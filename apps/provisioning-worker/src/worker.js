import crypto from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import mysql from "mysql2/promise";
import { DefaultAzureCredential } from "@azure/identity";
import { SecretClient } from "@azure/keyvault-secrets";
import {
  createControlPlanePool,
  createControlPlaneRepositories,
  createControlPlaneService,
  withControlPlaneTransaction,
} from "@claimguard/control-plane-database";

const REQUIRED_STEPS = Object.freeze([
  "validate_request",
  "reserve_slug",
  "create_organisation_record",
  "allocate_database_name",
  "create_database",
  "create_database_principal",
  "store_secret_references",
  "apply_tenant_schema",
  "write_data_plane_metadata",
  "verify_database_isolation",
  "create_report_partition",
  "register_worker_routing",
  "register_private_route",
  "create_initial_scheme_admin",
  "run_activation_checks",
  "ready_for_activation",
]);

const moduleDir = fileURLToPath(new URL(".", import.meta.url));
const privateSchemaBaselinePath = path.join(moduleDir, "private-schema-baseline.sql");

function log(level, event, details = {}) {
  const payload = {
    timestamp: new Date().toISOString(),
    level,
    service: "provisioning-worker",
    event,
    ...details,
  };
  if (level === "error") console.error(JSON.stringify(payload));
  else console.log(JSON.stringify(payload));
}

function requireEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

function organisationSafeDatabaseName(organisationId) {
  const safe = String(organisationId || "").replace(/[^a-zA-Z0-9]/g, "").toLowerCase().slice(0, 32) || "tenant";
  return `claimguard_tenant_${safe}`;
}

function organisationSecretPrefix(organisationId) {
  return `claimguard--tenant--${String(organisationId || "").replace(/[^a-zA-Z0-9-]/g, "").toLowerCase()}`;
}

function parseAzurePolicy(organisationId) {
  const resourceGroup = process.env.AZURE_APPROVED_RESOURCE_GROUP || "ClaimGuard";
  const mysqlServerName = process.env.AZURE_APPROVED_MYSQL_SERVER || "claimguard";
  const keyVaultName = process.env.AZURE_APPROVED_KEYVAULT || "claimguard-kv-ufs";
  const region = process.env.AZURE_APPROVED_REGION || "southafricanorth";
  const storageAccount = process.env.AZURE_APPROVED_STORAGE_ACCOUNT || "cgrpt0715sa";
  const reportContainer = process.env.AZURE_APPROVED_REPORT_CONTAINER || "claimguard-reports";
  const schemaVersion = process.env.PRIVATE_TENANT_SCHEMA_VERSION || "11e-baseline-v1";
  const subscriptionId = process.env.AZURE_APPROVED_SUBSCRIPTION_ID || process.env.AZURE_SUBSCRIPTION_ID || null;
  return {
    resourceGroup,
    mysqlServerName,
    keyVaultName,
    region,
    storageAccount,
    reportContainer,
    schemaVersion,
    subscriptionId,
    logicalDatabaseIdentifier: `private-${String(organisationId || "").slice(0, 8)}`,
    databaseName: organisationSafeDatabaseName(organisationId),
  };
}

async function createSecretStore() {
  const keyVaultUri = process.env.PROVISIONING_KEYVAULT_URI || null;
  const allowFallback = String(process.env.PROVISIONING_ALLOW_ENV_SECRET_FALLBACK || "false").toLowerCase() === "true";
  if (!keyVaultUri && !allowFallback) {
    throw new Error("PROVISIONING_KEYVAULT_URI is required unless PROVISIONING_ALLOW_ENV_SECRET_FALLBACK=true.");
  }

  if (!keyVaultUri && allowFallback) {
    return {
      kind: "env-fallback",
      async setSecret(name, value) {
        if (!value) throw new Error("Secret value is required.");
        process.env[`CLAIMGUARD_PROVISIONING_SECRET_${name.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`] = value;
        return { id: `env://${name}` };
      },
    };
  }

  const credential = new DefaultAzureCredential();
  const client = new SecretClient(keyVaultUri, credential);
  return {
    kind: "azure-keyvault",
    async setSecret(name, value) {
      return client.setSecret(name, value);
    },
  };
}

async function parseSqlStatements(filePath) {
  const source = await readFile(filePath, "utf8");
  return source
    .split(";\n")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

async function ensurePrivateSchema(adminPool, databaseName, organisationId, schemaVersion) {
  const statements = await parseSqlStatements(privateSchemaBaselinePath);
  const connection = await adminPool.getConnection();
  try {
    await connection.query(`USE \`${databaseName}\``);
    for (const statement of statements) {
      await connection.query(statement);
    }
    await connection.query(
      `INSERT INTO private_migration_history (migration_id)
       VALUES (?)
       ON DUPLICATE KEY UPDATE migration_id = migration_id`,
      [schemaVersion],
    );
    await connection.query(
      `INSERT INTO data_plane_metadata
        (metadata_key, organisation_id, route_type, logical_database_identifier, schema_version, migration_version)
       VALUES ('primary', ?, 'private_database', ?, ?, ?)
       ON DUPLICATE KEY UPDATE
        organisation_id = VALUES(organisation_id),
        route_type = VALUES(route_type),
        logical_database_identifier = VALUES(logical_database_identifier),
        schema_version = VALUES(schema_version),
        migration_version = VALUES(migration_version)`,
      [organisationId, `private-${organisationId.slice(0, 8)}`, schemaVersion, schemaVersion],
    );
  } finally {
    connection.release();
  }
}

async function ensureTenantPrincipal(adminPool, { databaseName, username, password }) {
  const connection = await adminPool.getConnection();
  const escapedUser = connection.escape(username);
  const escapedPassword = connection.escape(password);
  const escapedDatabase = `\`${String(databaseName).replace(/`/g, "``")}\``;
  try {
    await connection.query(`CREATE USER IF NOT EXISTS ${escapedUser}@'%' IDENTIFIED BY ${escapedPassword}`);
    await connection.query(`ALTER USER ${escapedUser}@'%' IDENTIFIED BY ${escapedPassword}`);
    await connection.query(`GRANT SELECT, INSERT, UPDATE, DELETE, CREATE, ALTER, INDEX, REFERENCES ON ${escapedDatabase}.* TO ${escapedUser}@'%'`);
    await connection.query("FLUSH PRIVILEGES");
  } finally {
    connection.release();
  }
}

async function verifyIsolation(adminPool, { tenantUsername, tenantPassword, databaseName }) {
  const tenantConnection = await mysql.createConnection({
    uri: requireEnv("MYSQL_SERVER_ADMIN_URL").replace(/\/[^/?#]+(\?|$)/, `/${databaseName}$1`),
    user: tenantUsername,
    password: tenantPassword,
    ssl: { rejectUnauthorized: true },
  });
  try {
    await tenantConnection.query("SELECT 1");
    let blocked = false;
    try {
      await tenantConnection.query("SELECT 1 FROM mysql.user LIMIT 1");
    } catch {
      blocked = true;
    }
    if (!blocked) {
      throw new Error("Tenant principal unexpectedly has server-wide access.");
    }
  } finally {
    await tenantConnection.end();
  }
}

async function stepRunner(repositories, operationId, stepKey, runner, { resourceReference = null } = {}) {
  const existing = await repositories.provisioning.listSteps(operationId);
  const found = existing.find((step) => step.stepKey === stepKey);
  if (found?.status === "completed") return { skipped: true };

  await repositories.provisioning.startStep({ operationId, stepKey, externalResourceReference: resourceReference });
  try {
    await runner();
    await repositories.provisioning.completeStep({ operationId, stepKey, externalResourceReference: resourceReference });
    return { skipped: false };
  } catch (error) {
    await repositories.provisioning.failStep({ operationId, stepKey, error });
    throw error;
  }
}

async function findLeasableOperation(repositories) {
  const pending = await repositories.provisioning.listOperations({ statuses: ["pending"], limit: 25 });
  for (const operation of pending) {
    try {
      return repositories.provisioning.transitionOperation(operation.operationId, ["pending"], "running");
    } catch {
      // Lost the race; keep scanning.
    }
  }

  const running = await repositories.provisioning.listOperations({ statuses: ["running"], limit: 1 });
  return running[0] || null;
}

function generateTenantCredential(organisationId) {
  const slug = String(organisationId || "").replace(/[^a-zA-Z0-9]/g, "").slice(0, 24).toLowerCase() || "tenant";
  const username = `cg_runtime_${slug}`;
  const password = crypto.randomBytes(24).toString("base64url");
  return { username, password };
}

async function ensureInitialSchemeAdministrator(controlPool, organisationId) {
  const [rows] = await controlPool.execute(
    `SELECT COUNT(*) AS count
     FROM organisation_memberships m
     JOIN membership_roles mr ON mr.membership_id = m.membership_id
     JOIN roles r ON r.role_id = mr.role_id
     WHERE m.organisation_id = ? AND r.role_key = 'scheme_administrator' AND mr.revoked_at IS NULL`,
    [organisationId],
  );
  return Number(rows?.[0]?.count || 0) > 0;
}

async function runProvisioningOperation({
  controlPool,
  repositories,
  service,
  operation,
  adminPool,
  secretStore,
}) {
  const organisation = await repositories.organisations.getById(operation.organisationId);
  if (!organisation) {
    throw new Error("Organisation not found for operation.");
  }

  const policy = parseAzurePolicy(organisation.organisationId);
  const secretPrefix = organisationSecretPrefix(organisation.organisationId);
  const tenantCredential = generateTenantCredential(organisation.organisationId);
  const serverHost = `${policy.mysqlServerName}.mysql.database.azure.com`;
  const runtimeUsernameSecretName = `${secretPrefix}--mysql-username`;
  const runtimePasswordSecretName = `${secretPrefix}--mysql-password`;
  const runtimeHostSecretName = `${secretPrefix}--mysql-host`;
  const runtimeDatabaseSecretName = `${secretPrefix}--mysql-database`;

  await stepRunner(repositories, operation.operationId, "validate_request", async () => {
    if (organisation.organisationType !== "medical_scheme") {
      throw new Error("Only medical_scheme organisations can be provisioned.");
    }
  });

  await stepRunner(repositories, operation.operationId, "reserve_slug", async () => {});
  await stepRunner(repositories, operation.operationId, "create_organisation_record", async () => {
    if (organisation.status !== "provisioning") {
      await service.transitionOrganisation(organisation.organisationId, "provisioning", { actor: { type: "system", id: "provisioning-worker" } });
    }
  });

  await stepRunner(repositories, operation.operationId, "allocate_database_name", async () => {});

  await stepRunner(repositories, operation.operationId, "create_database", async () => {
    await adminPool.execute(`CREATE DATABASE IF NOT EXISTS \`${policy.databaseName}\``);
  }, { resourceReference: `mysql-database:${policy.databaseName}` });

  await stepRunner(repositories, operation.operationId, "create_database_principal", async () => {
    await ensureTenantPrincipal(adminPool, {
      databaseName: policy.databaseName,
      username: tenantCredential.username,
      password: tenantCredential.password,
    });
  }, { resourceReference: `mysql-user:${tenantCredential.username}` });

  await stepRunner(repositories, operation.operationId, "store_secret_references", async () => {
    await secretStore.setSecret(runtimeUsernameSecretName, tenantCredential.username);
    await secretStore.setSecret(runtimePasswordSecretName, tenantCredential.password);
    await secretStore.setSecret(runtimeHostSecretName, serverHost);
    await secretStore.setSecret(runtimeDatabaseSecretName, policy.databaseName);
  }, { resourceReference: `${policy.keyVaultName}:${secretPrefix}` });

  await stepRunner(repositories, operation.operationId, "apply_tenant_schema", async () => {
    await ensurePrivateSchema(adminPool, policy.databaseName, organisation.organisationId, policy.schemaVersion);
  }, { resourceReference: `schema:${policy.databaseName}:${policy.schemaVersion}` });

  await stepRunner(repositories, operation.operationId, "write_data_plane_metadata", async () => {});

  await stepRunner(repositories, operation.operationId, "verify_database_isolation", async () => {
    await verifyIsolation(adminPool, {
      tenantUsername: tenantCredential.username,
      tenantPassword: tenantCredential.password,
      databaseName: policy.databaseName,
    });
  });

  await stepRunner(repositories, operation.operationId, "create_report_partition", async () => {
    await controlPool.execute(
      `INSERT INTO report_storage_partitions
        (partition_id, organisation_id, storage_type, logical_partition_key, resource_reference, provisioning_status, health_status, active_at)
       VALUES (?, ?, 'azure_blob_prefix', ?, ?, 'ready', 'unknown', UTC_TIMESTAMP(3))
       ON DUPLICATE KEY UPDATE resource_reference = VALUES(resource_reference), provisioning_status = 'ready'`,
      [
        crypto.randomUUID(),
        organisation.organisationId,
        `${organisation.organisationId}/`,
        `/subscriptions/${policy.subscriptionId || "unknown"}/resourceGroups/${policy.resourceGroup}/providers/Microsoft.Storage/storageAccounts/${policy.storageAccount}/blobServices/default/containers/${policy.reportContainer}`,
      ],
    );
  });

  await stepRunner(repositories, operation.operationId, "register_worker_routing", async () => {
    await controlPool.execute(
      `INSERT INTO worker_routing_status
        (organisation_id, worker_type, status, routing_generation)
       VALUES
        (?, 'report-worker', 'pending', 1),
        (?, 'simulator-worker', 'pending', 1),
        (?, 'provisioning-worker', 'ready', 1)
       ON DUPLICATE KEY UPDATE status = VALUES(status), routing_generation = routing_generation + 1`,
      [organisation.organisationId, organisation.organisationId, organisation.organisationId],
    );
  });

  await stepRunner(repositories, operation.operationId, "register_private_route", async () => {
    const [existingRows] = await controlPool.execute(
      `SELECT route_id FROM data_plane_routes
       WHERE organisation_id = ? AND route_type = 'private_database' AND retired_at IS NULL
       ORDER BY route_generation DESC LIMIT 1`,
      [organisation.organisationId],
    );
    if (existingRows?.[0]?.route_id) return;

    await service.registerRoute({
      organisationId: organisation.organisationId,
      routeType: "private_database",
      logicalDatabaseIdentifier: policy.logicalDatabaseIdentifier,
      azureResourceIdentifier: `/subscriptions/${policy.subscriptionId || "unknown"}/resourceGroups/${policy.resourceGroup}/providers/Microsoft.DBforMySQL/flexibleServers/${policy.mysqlServerName}`,
      databaseName: policy.databaseName,
      secretReference: `https://${policy.keyVaultName}.vault.azure.net/secrets/${runtimeUsernameSecretName},https://${policy.keyVaultName}.vault.azure.net/secrets/${runtimePasswordSecretName},https://${policy.keyVaultName}.vault.azure.net/secrets/${runtimeHostSecretName},https://${policy.keyVaultName}.vault.azure.net/secrets/${runtimeDatabaseSecretName}`,
      region: policy.region,
      schemaVersion: policy.schemaVersion,
      provisioningStatus: "ready",
      healthStatus: "unknown",
      activate: false,
    }, { type: "system", id: "provisioning-worker", source: "provisioning-worker" });
  });

  await stepRunner(repositories, operation.operationId, "create_initial_scheme_admin", async () => {
    const exists = await ensureInitialSchemeAdministrator(controlPool, organisation.organisationId);
    if (!exists) {
      throw new Error("No scheme administrator membership is registered for organisation.");
    }
  });

  await stepRunner(repositories, operation.operationId, "run_activation_checks", async () => {
    const checks = [
      async () => {
        const [rows] = await adminPool.execute(`SELECT COUNT(*) AS count FROM \`${policy.databaseName}\`.data_plane_metadata`);
        return Number(rows?.[0]?.count || 0) === 1;
      },
      async () => {
        const [rows] = await controlPool.execute(
          `SELECT COUNT(*) AS count FROM data_plane_routes
           WHERE organisation_id = ? AND route_type = 'private_database' AND active_route_slot IS NULL`,
          [organisation.organisationId],
        );
        return Number(rows?.[0]?.count || 0) >= 1;
      },
      async () => {
        const [rows] = await controlPool.execute(
          `SELECT COUNT(*) AS count FROM data_plane_routes
           WHERE organisation_id = ? AND route_type = 'legacy_shared' AND active_route_slot = organisation_id`,
          [organisation.organisationId],
        );
        return Number(rows?.[0]?.count || 0) === 1;
      },
    ];
    for (const check of checks) {
      const ok = await check();
      if (!ok) {
        throw new Error("Activation checks failed.");
      }
    }
  });

  await stepRunner(repositories, operation.operationId, "ready_for_activation", async () => {
    await service.transitionOrganisation(organisation.organisationId, "ready_for_activation", {
      actor: { type: "system", id: "provisioning-worker", source: "provisioning-worker" },
    });
  });

  await repositories.provisioning.transitionOperation(operation.operationId, ["running"], "completed");
}

export async function runProvisioningBatch({ maxOperations = 1 } = {}) {
  const controlPlaneUrl = requireEnv("CONTROL_PLANE_MYSQL_URL");
  const controlPool = createControlPlanePool(controlPlaneUrl);
  const repositories = createControlPlaneRepositories(controlPool);
  const service = createControlPlaneService({ pool: controlPool, repositories });
  const secretStore = await createSecretStore();
  const adminPool = mysql.createPool(requireEnv("MYSQL_SERVER_ADMIN_URL"));

  let processed = 0;
  try {
    while (processed < maxOperations) {
      const operation = await findLeasableOperation(repositories);
      if (!operation) break;
      log("info", "provisioning_operation_leased", {
        operationId: operation.operationId,
        organisationId: operation.organisationId,
      });
      try {
        await runProvisioningOperation({
          controlPool,
          repositories,
          service,
          operation,
          adminPool,
          secretStore,
        });
        log("info", "provisioning_operation_completed", { operationId: operation.operationId, organisationId: operation.organisationId });
      } catch (error) {
        await withControlPlaneTransaction(controlPool, async (executor) => {
          await repositories.provisioning.transitionOperation(
            operation.operationId,
            ["running", "pending", "compensating"],
            "failed",
            { error, executor },
          );
        }).catch(() => undefined);
        log("error", "provisioning_operation_failed", {
          operationId: operation.operationId,
          organisationId: operation.organisationId,
          failureType: error?.name || "Error",
          failureCode: error?.code || "UNCLASSIFIED",
        });
      }
      processed += 1;
    }

    return { processed };
  } finally {
    await Promise.all([
      adminPool.end(),
      controlPool.end(),
    ]);
  }
}

export { REQUIRED_STEPS };
