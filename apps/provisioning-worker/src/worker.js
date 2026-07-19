import crypto from "node:crypto";

import mysql from "mysql2/promise";
import { applyMigrations } from "@claimguard/database/migrate";
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
  "grant_report_worker_secret_access",
  "record_schema_compatibility",
  "mark_report_worker_ready",
  "create_initial_scheme_admin",
  "run_activation_checks",
  "ready_for_activation",
]);

const REQUIRED_UPGRADE_STEPS = Object.freeze([
  "validate_upgrade_request",
  "apply_tenant_schema",
  "write_data_plane_metadata",
  "verify_database_isolation",
  "grant_report_worker_secret_access",
  "register_schema_10_route",
  "record_schema_compatibility",
  "mark_report_worker_ready",
]);

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

function organisationSafeDatabaseName(canonicalSlug) {
  const safe = String(canonicalSlug || "").replace(/[^a-zA-Z0-9]+/g, "_").replace(/^_+|_+$/g, "").toLowerCase().slice(0, 40) || "tenant";
  return `claimguard_tenant_${safe}`;
}

function organisationSecretPrefix(organisationId) {
  return `claimguard--tenant--${String(organisationId || "").replace(/[^a-zA-Z0-9-]/g, "").toLowerCase()}`;
}

function deterministicGuid(value) {
  const bytes = Buffer.from(crypto.createHash("sha256").update(value).digest().subarray(0, 16));
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

async function grantReportWorkerSecretAccess(policy, secretNames) {
  const principalId = requireEnv("AZURE_REPORT_WORKER_PRINCIPAL_ID");
  const roleDefinitionId = `/subscriptions/${policy.subscriptionId}/providers/Microsoft.Authorization/roleDefinitions/4633458b-17de-408a-b874-0445c86b69e6`;
  const { DefaultAzureCredential } = await import("@azure/identity");
  const credential = new DefaultAzureCredential();
  const accessToken = await credential.getToken("https://management.azure.com/.default");
  if (!accessToken?.token) throw new Error("Azure Resource Manager token acquisition failed.");

  for (const secretName of secretNames) {
    const scope = `/subscriptions/${policy.subscriptionId}/resourceGroups/${policy.resourceGroup}`
      + `/providers/Microsoft.KeyVault/vaults/${policy.keyVaultName}/secrets/${secretName}`;
    const assignmentId = deterministicGuid(`${scope}:${principalId}:${roleDefinitionId}`);
    const response = await fetch(
      `https://management.azure.com${scope}/providers/Microsoft.Authorization/roleAssignments/${assignmentId}?api-version=2022-04-01`,
      {
        method: "PUT",
        headers: {
          authorization: `Bearer ${accessToken.token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          properties: {
            principalId,
            principalType: "ServicePrincipal",
            roleDefinitionId,
            description: "Allow the ClaimGuard report worker to resolve this tenant route secret.",
          },
        }),
      },
    );
    if (!response.ok) {
      throw new Error(`Report-worker secret role assignment failed with HTTP ${response.status}.`);
    }
  }
}

function parseAzurePolicy(organisation) {
  const resourceGroup = requireEnv("AZURE_APPROVED_RESOURCE_GROUP");
  const mysqlServerName = requireEnv("AZURE_APPROVED_MYSQL_SERVER");
  const keyVaultName = requireEnv("AZURE_APPROVED_KEYVAULT");
  const region = requireEnv("AZURE_APPROVED_REGION");
  const storageAccount = requireEnv("AZURE_APPROVED_STORAGE_ACCOUNT");
  const reportContainer = requireEnv("AZURE_APPROVED_REPORT_CONTAINER");
  const schemaVersion = process.env.PRIVATE_TENANT_SCHEMA_VERSION?.trim() || "10";
  const environmentKey = process.env.AZURE_APPROVED_ENVIRONMENT_KEY?.trim() || "production";
  const subscriptionId = requireEnv("AZURE_APPROVED_SUBSCRIPTION_ID");
  if (schemaVersion !== "10") throw new Error("PRIVATE_TENANT_SCHEMA_VERSION must be 10 for the canonical operational schema.");
  return {
    resourceGroup,
    mysqlServerName,
    keyVaultName,
    region,
    storageAccount,
    reportContainer,
    schemaVersion,
    environmentKey,
    subscriptionId,
    logicalDatabaseIdentifier: `private:${organisation.organisationId}`,
    databaseName: organisationSafeDatabaseName(organisation.canonicalSlug),
  };
}

async function assertDatabaseUnclaimed(adminPool, policy) {
  const [tableRows] = await adminPool.execute(
    `SELECT COUNT(*) AS count FROM information_schema.tables
     WHERE table_schema = ? AND table_name = 'data_plane_metadata'`,
    [policy.databaseName],
  );
  if (Number(tableRows?.[0]?.count || 0) === 0) return;
  const [metadataRows] = await adminPool.execute(
    `SELECT database_mode, logical_database_identifier FROM \`${policy.databaseName}\`.data_plane_metadata
     WHERE metadata_key = 'primary'`,
  );
  const metadata = metadataRows?.[0];
  if (!metadata
    || metadata.database_mode !== "private_database"
    || metadata.logical_database_identifier !== policy.logicalDatabaseIdentifier) {
    throw new Error("Allocated database is already initialized for a different data-plane identity.");
  }
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
      async getSecret(name) {
        const value = process.env[`CLAIMGUARD_PROVISIONING_SECRET_${name.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`];
        return value ? { value } : null;
      },
    };
  }

  const [{ DefaultAzureCredential }, { SecretClient }] = await Promise.all([
    import("@azure/identity"),
    import("@azure/keyvault-secrets"),
  ]);
  const credential = new DefaultAzureCredential();
  const client = new SecretClient(keyVaultUri, credential);
  return {
    kind: "azure-keyvault",
    async setSecret(name, value) {
      return client.setSecret(name, value);
    },
    async getSecret(name) {
      try {
        return await client.getSecret(name);
      } catch (error) {
        if (error?.statusCode === 404) return null;
        throw error;
      }
    },
  };
}

async function ensurePrivateSchema(adminPool, databaseName, organisation, policy) {
  const connection = await adminPool.getConnection();
  try {
    await connection.query(`USE \`${databaseName}\``);
    await applyMigrations(connection, undefined, { applicationVersion: `private-${policy.schemaVersion}` });
    await connection.query(
      "DELETE FROM ledger_chain_heads WHERE tenant_id = 'tenant_default'",
    );
    await connection.query(
      "DELETE FROM tenants WHERE tenant_id = 'tenant_default'",
    );
    await connection.query(
      `INSERT INTO tenants (tenant_id, tenant_slug, tenant_name, status)
       VALUES (?, ?, ?, 'active')
       ON DUPLICATE KEY UPDATE tenant_slug = VALUES(tenant_slug), tenant_name = VALUES(tenant_name), status = 'active'`,
      [organisation.organisationId, organisation.canonicalSlug, organisation.displayName],
    );
    await connection.query(
      `UPDATE data_plane_metadata
       SET database_mode = 'private_database', logical_database_identifier = ?,
         schema_version = ?, environment_key = ?, migration_version = 10
       WHERE metadata_key = 'primary'`,
      [policy.logicalDatabaseIdentifier, policy.schemaVersion, policy.environmentKey],
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
    await connection.query(`REVOKE ALL PRIVILEGES, GRANT OPTION FROM ${escapedUser}@'%'`);
    await connection.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ${escapedDatabase}.* TO ${escapedUser}@'%'`);
    await connection.query("FLUSH PRIVILEGES");
  } finally {
    connection.release();
  }
}

function tenantDatabaseUrl(adminDatabaseUrl, { databaseName, username, password }) {
  const url = new URL(adminDatabaseUrl);
  url.pathname = `/${databaseName}`;
  url.username = username;
  url.password = password;
  return url.toString();
}

function mysqlConnectionConfig(connectionUrl) {
  const url = new URL(connectionUrl);
  const isAzureMySqlHost = url.hostname.endsWith(".mysql.database.azure.com");
  if (!isAzureMySqlHost) return connectionUrl;
  // Azure MySQL enforces secure transport; ensure mysql2 sends an SSL/TLS config.
  return {
    uri: connectionUrl,
    ssl: {
      minVersion: "TLSv1.2",
    },
  };
}

async function verifyIsolation(adminPool, { tenantUsername, tenantPassword, databaseName, adminDatabaseUrl }) {
  const tenantConnection = await mysql.createConnection(mysqlConnectionConfig(tenantDatabaseUrl(adminDatabaseUrl, {
    databaseName,
    username: tenantUsername,
    password: tenantPassword,
  })));
  try {
    await tenantConnection.query("SELECT 1");
    const [otherRows] = await adminPool.execute(
      `SELECT schema_name AS schema_name FROM information_schema.schemata
       WHERE schema_name LIKE 'claimguard\\_tenant\\_%' AND schema_name <> ?
       ORDER BY schema_name LIMIT 1`,
      [databaseName],
    );
    const otherDatabaseName = otherRows?.[0]?.schema_name || null;
    if (!otherDatabaseName) throw new Error("A second tenant database is required for negative isolation verification.");
    let crossDatabaseBlocked = false;
    try {
      await tenantConnection.query(`SELECT 1 FROM \`${String(otherDatabaseName).replace(/`/g, "``")}\`.data_plane_metadata LIMIT 1`);
    } catch {
      crossDatabaseBlocked = true;
    }
    if (!crossDatabaseBlocked) throw new Error("Tenant principal unexpectedly has cross-database access.");
    const [grants] = await tenantConnection.query("SHOW GRANTS FOR CURRENT_USER()");
    const grantStatements = (grants || []).flatMap((row) => Object.values(row).map(String));
    if (grantStatements.some((grant) => !/^GRANT USAGE ON \*\.\*/i.test(grant) && / ON `?\*`?\.`?\*`? /i.test(grant))) {
      throw new Error("Tenant principal unexpectedly has server-wide grants.");
    }
    return { otherDatabaseName, crossDatabaseBlocked: true };
  } finally {
    await tenantConnection.end();
  }
}

async function stepRunner(repositories, operationId, stepKey, runner, { resourceReference = null, leaseToken } = {}) {
  await repositories.provisioning.renewOperationLease({ operationId, leaseToken });
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

function generateTenantCredential(organisationId) {
  const slug = String(organisationId || "").replace(/[^a-zA-Z0-9]/g, "").slice(0, 20).toLowerCase() || "tenant";
  const username = `cg_runtime_${slug}`;
  const password = crypto.randomBytes(24).toString("base64url");
  return { username, password };
}

async function resolveTenantCredential(secretStore, organisationId, usernameSecretName, passwordSecretName) {
  const [storedUsername, storedPassword] = await Promise.all([
    secretStore.getSecret(usernameSecretName),
    secretStore.getSecret(passwordSecretName),
  ]);
  if (storedUsername?.value && storedPassword?.value) {
    return { username: storedUsername.value, password: storedPassword.value, persisted: true };
  }
  const generated = generateTenantCredential(organisationId);
  return { ...generated, persisted: false };
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
  if (operation.operationType !== "onboard_private_database") {
    throw new Error("Unsupported onboarding operation type.");
  }

  const policy = parseAzurePolicy(organisation);
  const secretPrefix = organisationSecretPrefix(organisation.organisationId);
  const serverHost = `${policy.mysqlServerName}.mysql.database.azure.com`;
  const runtimeUsernameSecretName = `${secretPrefix}--mysql-username`;
  const runtimePasswordSecretName = `${secretPrefix}--mysql-password`;
  const runtimeHostSecretName = `${secretPrefix}--mysql-host`;
  const runtimeDatabaseSecretName = `${secretPrefix}--mysql-database`;
  const tenantCredential = await resolveTenantCredential(
    secretStore,
    organisation.organisationId,
    runtimeUsernameSecretName,
    runtimePasswordSecretName,
  );
  const runStep = (stepKey, runner, options = {}) => stepRunner(
    repositories,
    operation.operationId,
    stepKey,
    runner,
    { ...options, leaseToken: operation.leaseToken },
  );

  await runStep("validate_request", async () => {
    if (organisation.organisationType !== "medical_scheme") {
      throw new Error("Only medical_scheme organisations can be provisioned.");
    }
  });

  await runStep("reserve_slug", async () => {});
  await runStep("create_organisation_record", async () => {
    if (organisation.status !== "provisioning") {
      await service.transitionOrganisation(organisation.organisationId, "provisioning", { actor: { type: "system", id: "provisioning-worker" } });
    }
  });

  await runStep("allocate_database_name", async () => {});

  await runStep("create_database", async () => {
    await adminPool.execute(`CREATE DATABASE IF NOT EXISTS \`${policy.databaseName}\``);
    await assertDatabaseUnclaimed(adminPool, policy);
  }, { resourceReference: `mysql-database:${policy.databaseName}` });

  await runStep("create_database_principal", async () => {
    await ensureTenantPrincipal(adminPool, {
      databaseName: policy.databaseName,
      username: tenantCredential.username,
      password: tenantCredential.password,
    });
    await secretStore.setSecret(runtimeUsernameSecretName, tenantCredential.username);
    await secretStore.setSecret(runtimePasswordSecretName, tenantCredential.password);
  }, { resourceReference: `mysql-user:${tenantCredential.username}` });

  await runStep("store_secret_references", async () => {
    await secretStore.setSecret(runtimeUsernameSecretName, tenantCredential.username);
    await secretStore.setSecret(runtimePasswordSecretName, tenantCredential.password);
    await secretStore.setSecret(runtimeHostSecretName, serverHost);
    await secretStore.setSecret(runtimeDatabaseSecretName, policy.databaseName);
  }, { resourceReference: `${policy.keyVaultName}:${secretPrefix}` });

  await runStep("apply_tenant_schema", async () => {
    await ensurePrivateSchema(adminPool, policy.databaseName, organisation, policy);
  }, { resourceReference: `schema:${policy.databaseName}:${policy.schemaVersion}` });

  await runStep("write_data_plane_metadata", async () => {
    const [rows] = await adminPool.execute(
      `SELECT database_mode, logical_database_identifier, schema_version, environment_key, migration_version
       FROM \`${policy.databaseName}\`.data_plane_metadata WHERE metadata_key = 'primary'`,
    );
    const metadata = rows?.[0];
    if (!metadata
      || metadata.database_mode !== "private_database"
      || metadata.logical_database_identifier !== policy.logicalDatabaseIdentifier
      || String(metadata.schema_version) !== policy.schemaVersion
      || metadata.environment_key !== policy.environmentKey
      || Number(metadata.migration_version) !== 10) {
      throw new Error("Private data-plane metadata verification failed.");
    }
  });

  await runStep("verify_database_isolation", async () => {
    await verifyIsolation(adminPool, {
      tenantUsername: tenantCredential.username,
      tenantPassword: tenantCredential.password,
      databaseName: policy.databaseName,
      adminDatabaseUrl: requireEnv("MYSQL_SERVER_ADMIN_URL"),
    });
  });

  await runStep("create_report_partition", async () => {
    await controlPool.execute(
      `INSERT INTO report_storage_partitions
        (partition_id, organisation_id, storage_type, logical_partition_key, resource_reference, provisioning_status, health_status, active_at)
       VALUES (?, ?, 'azure_blob_prefix', ?, ?, 'ready', 'unknown', UTC_TIMESTAMP(3))
       ON DUPLICATE KEY UPDATE resource_reference = VALUES(resource_reference), provisioning_status = 'ready'`,
      [
        crypto.randomUUID(),
        organisation.organisationId,
        `${organisation.organisationId}/`,
        `/subscriptions/${policy.subscriptionId}/resourceGroups/${policy.resourceGroup}/providers/Microsoft.Storage/storageAccounts/${policy.storageAccount}/blobServices/default/containers/${policy.reportContainer}`,
      ],
    );
  });

  await runStep("register_worker_routing", async () => {
    await controlPool.execute(
      `INSERT INTO worker_routing_status
        (organisation_id, worker_type, status, routing_generation)
       VALUES
        (?, 'report-worker', 'pending', 1),
        (?, 'provisioning-worker', 'ready', 1)
       ON DUPLICATE KEY UPDATE status = VALUES(status), routing_generation = routing_generation + 1`,
      [organisation.organisationId, organisation.organisationId],
    );
  });

  await runStep("register_private_route", async () => {
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
      azureResourceIdentifier: `/subscriptions/${policy.subscriptionId}/resourceGroups/${policy.resourceGroup}/providers/Microsoft.DBforMySQL/flexibleServers/${policy.mysqlServerName}`,
      databaseName: policy.databaseName,
      secretReference: `https://${policy.keyVaultName}.vault.azure.net/secrets/${runtimeUsernameSecretName},https://${policy.keyVaultName}.vault.azure.net/secrets/${runtimePasswordSecretName},https://${policy.keyVaultName}.vault.azure.net/secrets/${runtimeHostSecretName},https://${policy.keyVaultName}.vault.azure.net/secrets/${runtimeDatabaseSecretName}`,
      region: policy.region,
      schemaVersion: policy.schemaVersion,
      provisioningStatus: "ready",
      healthStatus: "unknown",
      activate: false,
    }, { type: "system", id: "provisioning-worker", source: "provisioning-worker" });
  });

  await runStep("grant_report_worker_secret_access", async () => {
    await grantReportWorkerSecretAccess(policy, [
      runtimeUsernameSecretName,
      runtimePasswordSecretName,
      runtimeHostSecretName,
      runtimeDatabaseSecretName,
    ]);
  });

  await runStep("record_schema_compatibility", async () => {
    const [rows] = await controlPool.execute(
      `SELECT route_id FROM data_plane_routes
       WHERE organisation_id = ? AND route_type = 'private_database' AND retired_at IS NULL
       ORDER BY route_generation DESC LIMIT 1`,
      [organisation.organisationId],
    );
    const routeId = rows?.[0]?.route_id;
    if (!routeId) throw new Error("Private route was not registered.");
    await controlPool.execute(
      `UPDATE data_plane_routes SET provisioning_status = 'ready', health_status = 'healthy'
       WHERE route_id = ? AND active_route_slot IS NULL`,
      [routeId],
    );
    await controlPool.execute(
      `INSERT INTO organisation_schema_status
        (organisation_id, route_id, expected_schema_version, observed_schema_version,
         compatibility_status, last_checked_at, safe_error_summary)
       VALUES (?, ?, '10', '10', 'compatible', UTC_TIMESTAMP(3), NULL)
       ON DUPLICATE KEY UPDATE route_id = VALUES(route_id), expected_schema_version = '10',
         observed_schema_version = '10', compatibility_status = 'compatible',
         last_checked_at = UTC_TIMESTAMP(3), safe_error_summary = NULL`,
      [organisation.organisationId, routeId],
    );
  });

  await runStep("mark_report_worker_ready", async () => {
    await controlPool.execute(
      `UPDATE worker_routing_status SET status = 'ready', routing_generation = routing_generation + 1,
         safe_error_summary = NULL
       WHERE organisation_id = ? AND worker_type = 'report-worker'`,
      [organisation.organisationId],
    );
  });

  await runStep("create_initial_scheme_admin", async () => {
    const exists = await ensureInitialSchemeAdministrator(controlPool, organisation.organisationId);
    if (!exists) {
      throw new Error("No scheme administrator membership is registered for organisation.");
    }
  });

  await runStep("run_activation_checks", async () => {
    const checks = [
      async () => {
        const [rows] = await adminPool.execute(
          `SELECT COUNT(*) AS count FROM \`${policy.databaseName}\`.data_plane_metadata
           WHERE metadata_key = 'primary' AND database_mode = 'private_database'
             AND logical_database_identifier = ? AND schema_version = ? AND migration_version = 10`,
          [policy.logicalDatabaseIdentifier, policy.schemaVersion],
        );
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
           WHERE organisation_id = ? AND route_type = 'private_database' AND active_route_slot IS NOT NULL`,
          [organisation.organisationId],
        );
        return Number(rows?.[0]?.count || 0) === 0;
      },
      async () => {
        const [rows] = await controlPool.execute(
          `SELECT COUNT(*) AS count FROM data_plane_routes
           WHERE organisation_id = ? AND active_route_slot = organisation_id AND route_type <> 'legacy_shared'`,
          [organisation.organisationId],
        );
        return Number(rows?.[0]?.count || 0) === 0;
      },
    ];
    for (const check of checks) {
      const ok = await check();
      if (!ok) {
        throw new Error("Activation checks failed.");
      }
    }
  });

  await runStep("ready_for_activation", async () => {
    await service.transitionOrganisation(organisation.organisationId, "ready_for_activation", {
      actor: { type: "system", id: "provisioning-worker", source: "provisioning-worker" },
    });
  });

  await repositories.provisioning.transitionOperation(operation.operationId, ["running"], "completed", { leaseToken: operation.leaseToken });
}

async function runUpgradeOperation({
  controlPool,
  repositories,
  service,
  operation,
  adminPool,
  secretStore,
}) {
  const organisation = await repositories.organisations.getById(operation.organisationId);
  if (!organisation) throw new Error("Organisation not found for upgrade operation.");
  if (operation.operationType !== "upgrade_private_database") throw new Error("Unsupported upgrade operation type.");

  const policy = parseAzurePolicy(organisation);
  const secretPrefix = organisationSecretPrefix(organisation.organisationId);
  const secretNames = [
    `${secretPrefix}--mysql-username`,
    `${secretPrefix}--mysql-password`,
    `${secretPrefix}--mysql-host`,
    `${secretPrefix}--mysql-database`,
  ];
  const tenantCredential = await resolveTenantCredential(secretStore, organisation.organisationId, secretNames[0], secretNames[1]);
  if (!tenantCredential.persisted) throw new Error("Existing private database credentials were not found in Key Vault.");
  const runStep = (stepKey, runner, options = {}) => stepRunner(
    repositories,
    operation.operationId,
    stepKey,
    runner,
    { ...options, leaseToken: operation.leaseToken },
  );
  let sourceRoute;
  let upgradedRoute;

  await runStep("validate_upgrade_request", async () => {
    if (organisation.organisationType !== "medical_scheme"
      || !["active", "suspended", "ready_for_activation"].includes(organisation.status)) {
      throw new Error("Only an existing medical-scheme private route can be upgraded.");
    }
    const [rows] = await controlPool.execute(
      `SELECT * FROM data_plane_routes
       WHERE organisation_id = ? AND route_type = 'private_database'
         AND retired_at IS NULL
       ORDER BY (active_route_slot = organisation_id) DESC, route_generation DESC LIMIT 2`,
      [organisation.organisationId],
    );
    sourceRoute = rows?.[0];
    if (!sourceRoute || sourceRoute.database_name !== policy.databaseName
      || sourceRoute.logical_database_identifier !== policy.logicalDatabaseIdentifier) {
      throw new Error("The existing private route does not match the approved database identity.");
    }
    const expectedReferences = secretNames.map((name) => `https://${policy.keyVaultName}.vault.azure.net/secrets/${name}`);
    const actualReferences = String(sourceRoute.secret_reference || "").split(",").map((value) => value.trim());
    if (expectedReferences.some((reference, index) => actualReferences[index] !== reference)) {
      throw new Error("The existing private route secret references do not match the approved tenant secrets.");
    }
  });
  if (!sourceRoute) {
    const [rows] = await controlPool.execute(
      `SELECT * FROM data_plane_routes
       WHERE organisation_id = ? AND route_type = 'private_database'
       ORDER BY (active_route_slot = organisation_id) DESC, route_generation DESC LIMIT 1`,
      [organisation.organisationId],
    );
    sourceRoute = rows?.[0];
  }
  if (!sourceRoute) throw new Error("Private route disappeared after upgrade validation.");

  await runStep("apply_tenant_schema", async () => {
    await ensurePrivateSchema(adminPool, policy.databaseName, organisation, policy);
  }, { resourceReference: `schema:${policy.databaseName}:${policy.schemaVersion}` });

  await runStep("write_data_plane_metadata", async () => {
    const [rows] = await adminPool.execute(
      `SELECT database_mode, logical_database_identifier, schema_version, environment_key, migration_version
       FROM \`${policy.databaseName}\`.data_plane_metadata WHERE metadata_key = 'primary'`,
    );
    const metadata = rows?.[0];
    if (!metadata || metadata.database_mode !== "private_database"
      || metadata.logical_database_identifier !== policy.logicalDatabaseIdentifier
      || String(metadata.schema_version) !== "10" || metadata.environment_key !== policy.environmentKey
      || Number(metadata.migration_version) !== 10) {
      throw new Error("Upgraded private data-plane metadata verification failed.");
    }
  });

  await runStep("verify_database_isolation", async () => {
    await verifyIsolation(adminPool, {
      tenantUsername: tenantCredential.username,
      tenantPassword: tenantCredential.password,
      databaseName: policy.databaseName,
      adminDatabaseUrl: requireEnv("MYSQL_SERVER_ADMIN_URL"),
    });
  });

  await runStep("grant_report_worker_secret_access", async () => {
    await grantReportWorkerSecretAccess(policy, secretNames);
  });

  await runStep("register_schema_10_route", async () => {
    const [existingRows] = await controlPool.execute(
      `SELECT route_id FROM data_plane_routes
       WHERE organisation_id = ? AND schema_version = '10' AND retired_at IS NULL
       ORDER BY route_generation DESC LIMIT 1`,
      [organisation.organisationId],
    );
    if (existingRows?.[0]?.route_id) {
      upgradedRoute = await repositories.routes.getSafeById(existingRows[0].route_id);
      return;
    }
    upgradedRoute = await service.registerRoute({
      organisationId: organisation.organisationId,
      routeType: "private_database",
      logicalDatabaseIdentifier: policy.logicalDatabaseIdentifier,
      azureResourceIdentifier: sourceRoute.azure_resource_identifier,
      databaseName: policy.databaseName,
      secretReference: sourceRoute.secret_reference,
      region: policy.region,
      schemaVersion: "10",
      provisioningStatus: organisation.status === "active" ? "active" : "ready",
      healthStatus: "healthy",
      activate: organisation.status === "active",
    }, { type: "system", id: "provisioning-worker", source: "provisioning-worker" });
  });

  await runStep("record_schema_compatibility", async () => {
    if (!upgradedRoute?.routeId) {
      const [rows] = await controlPool.execute(
        `SELECT route_id FROM data_plane_routes
         WHERE organisation_id = ? AND schema_version = '10' AND retired_at IS NULL
         ORDER BY route_generation DESC LIMIT 1`,
        [organisation.organisationId],
      );
      upgradedRoute = rows?.[0] ? { routeId: rows[0].route_id } : null;
    }
    if (!upgradedRoute?.routeId) throw new Error("Schema-10 route was not registered.");
    await controlPool.execute(
      `INSERT INTO organisation_schema_status
        (organisation_id, route_id, expected_schema_version, observed_schema_version,
         compatibility_status, last_checked_at, safe_error_summary)
       VALUES (?, ?, '10', '10', 'compatible', UTC_TIMESTAMP(3), NULL)
       ON DUPLICATE KEY UPDATE route_id = VALUES(route_id), expected_schema_version = '10',
         observed_schema_version = '10', compatibility_status = 'compatible',
         last_checked_at = UTC_TIMESTAMP(3), safe_error_summary = NULL`,
      [organisation.organisationId, upgradedRoute.routeId],
    );
  });

  await runStep("mark_report_worker_ready", async () => {
    await controlPool.execute(
      `INSERT INTO worker_routing_status (organisation_id, worker_type, status, routing_generation)
       VALUES (?, 'report-worker', 'ready', 1)
       ON DUPLICATE KEY UPDATE status = 'ready', routing_generation = routing_generation + 1,
         safe_error_summary = NULL`,
      [organisation.organisationId],
    );
  });

  await repositories.provisioning.transitionOperation(operation.operationId, ["running"], "completed", { leaseToken: operation.leaseToken });
}

export async function runProvisioningBatch({ maxOperations = 1 } = {}) {
  const controlPlaneUrl = requireEnv("CONTROL_PLANE_MYSQL_URL");
  const controlPool = createControlPlanePool(controlPlaneUrl);
  const repositories = createControlPlaneRepositories(controlPool);
  const service = createControlPlaneService({ pool: controlPool, repositories });
  const secretStore = await createSecretStore();
  const adminPool = mysql.createPool(mysqlConnectionConfig(requireEnv("MYSQL_SERVER_ADMIN_URL")));
  const workerInstanceId = process.env.CONTAINER_APP_JOB_EXECUTION_NAME?.trim() || `provisioning-worker-${crypto.randomUUID()}`;

  let processed = 0;
  try {
    while (processed < maxOperations) {
      const operation = await withControlPlaneTransaction(controlPool, (executor) => repositories.provisioning.leaseNextOperation({
        leaseOwner: workerInstanceId,
        leaseSeconds: 2100,
        executor,
      }));
      if (!operation) break;
      log("info", "provisioning_operation_leased", {
        operationId: operation.operationId,
        organisationId: operation.organisationId,
      });
      try {
        const runner = operation.operationType === "upgrade_private_database"
          ? runUpgradeOperation
          : runProvisioningOperation;
        await runner({ controlPool, repositories, service, operation, adminPool, secretStore });
        log("info", "provisioning_operation_completed", { operationId: operation.operationId, organisationId: operation.organisationId });
      } catch (error) {
        await withControlPlaneTransaction(controlPool, async (executor) => {
          await repositories.provisioning.transitionOperation(
            operation.operationId,
            ["running", "pending", "compensating"],
            "failed",
            { error, executor, leaseToken: operation.leaseToken },
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

export { REQUIRED_STEPS, REQUIRED_UPGRADE_STEPS };
