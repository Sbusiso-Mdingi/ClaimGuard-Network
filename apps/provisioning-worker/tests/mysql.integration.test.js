import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";

import mysql from "mysql2/promise";
import {
  applyControlPlaneMigrations,
  createControlPlanePool,
  createControlPlaneRepositories,
  createControlPlaneService,
} from "@claimguard/control-plane-database";

import { runProvisioningBatch } from "../src/worker.js";

const controlUrl = process.env.PHASE11E_CONTROL_PLANE_MYSQL_URL || "";
const adminUrl = process.env.PHASE11E_MYSQL_SERVER_ADMIN_URL || "";
const integration = controlUrl && adminUrl ? test : test.skip;

const approvedEnvironment = Object.freeze({
  AZURE_APPROVED_SUBSCRIPTION_ID: "00000000-0000-0000-0000-000000000011",
  AZURE_APPROVED_RESOURCE_GROUP: "ClaimGuard-Test",
  AZURE_APPROVED_MYSQL_SERVER: "claimguard-test",
  AZURE_APPROVED_KEYVAULT: "claimguard-test-kv",
  AZURE_APPROVED_STORAGE_ACCOUNT: "claimguardtestreports",
  AZURE_APPROVED_REPORT_CONTAINER: "reports",
  AZURE_APPROVED_REGION: "southafricanorth",
  AZURE_APPROVED_ENVIRONMENT_KEY: "test",
  PRIVATE_TENANT_SCHEMA_VERSION: "10",
  PROVISIONING_ALLOW_ENV_SECRET_FALLBACK: "true",
  PROVISIONING_MAX_OPERATIONS: "1",
});

function databaseName(canonicalSlug) {
  return `claimguard_tenant_${canonicalSlug.replace(/[^a-zA-Z0-9]+/g, "_").replace(/^_+|_+$/g, "").toLowerCase().slice(0, 40)}`;
}

function credentialUsername(organisationId) {
  return `cg_runtime_${organisationId.replace(/[^a-zA-Z0-9]/g, "").toLowerCase().slice(0, 20)}`;
}

function fallbackSecretName(organisationId, suffix) {
  const secret = `claimguard--tenant--${organisationId.toLowerCase()}--${suffix}`;
  return `CLAIMGUARD_PROVISIONING_SECRET_${secret.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`;
}

async function createOrganisation(service, repositories, { slug, withAdministrator }) {
  const actor = { type: "system", id: null, source: "phase11e-integration" };
  const organisation = await service.createDraftOrganisation({
    displayName: `${slug} Medical Scheme`,
    canonicalSlug: slug,
    organisationType: "medical_scheme",
    deploymentClass: "demo",
  }, actor);
  if (withAdministrator) {
    const user = await repositories.identity.createUser({
      displayName: `${slug} Administrator`,
      canonicalContact: `${slug}@example.invalid`,
      status: "invited",
    });
    const membership = await service.createMembership({
      userId: user.userId,
      organisationId: organisation.organisationId,
      status: "active",
    }, actor);
    await service.assignMembershipRole({
      membershipId: membership.membershipId,
      roleKey: "scheme_administrator",
    }, actor);
  }
  const operation = await service.requestProvisioningOperation({
    organisationId: organisation.organisationId,
    requestedBy: "phase11e-integration",
  }, actor);
  return { organisation, operation };
}

async function addAdministrator(service, repositories, organisation, slug) {
  const actor = { type: "system", id: null, source: "phase11e-integration" };
  const user = await repositories.identity.createUser({
    displayName: `${slug} Retry Administrator`,
    canonicalContact: `${slug}-retry@example.invalid`,
    status: "invited",
  });
  const membership = await service.createMembership({
    userId: user.userId,
    organisationId: organisation.organisationId,
    status: "active",
  }, actor);
  await service.assignMembershipRole({ membershipId: membership.membershipId, roleKey: "scheme_administrator" }, actor);
}

integration("real MySQL onboarding is leased, isolated, retryable, and leaves routes inactive", async () => {
  Object.assign(process.env, approvedEnvironment, {
    CONTROL_PLANE_MYSQL_URL: controlUrl,
    MYSQL_SERVER_ADMIN_URL: adminUrl,
  });
  delete process.env.PROVISIONING_KEYVAULT_URI;

  const controlPool = createControlPlanePool(controlUrl);
  const adminPool = mysql.createPool(adminUrl);
  const repositories = createControlPlaneRepositories(controlPool);
  const service = createControlPlaneService({ pool: controlPool, repositories });
  const legacyOrganisationId = crypto.randomUUID();
  let first;
  let second;
  let generatedDatabases = [];
  let generatedUsers = [];

  try {
    await applyControlPlaneMigrations(controlPool);
  } catch (error) {
    // Surface a stable setup error without including connection details.
    throw new Error(`Control-plane migration setup failed: ${error.code || error.name}`);
  }

  try {
    first = await createOrganisation(service, repositories, { slug: "phase11e-first", withAdministrator: true });
    second = await createOrganisation(service, repositories, { slug: "phase11e-retry", withAdministrator: false });
    generatedDatabases = [databaseName(first.organisation.canonicalSlug), databaseName(second.organisation.canonicalSlug)];
    generatedUsers = [credentialUsername(first.organisation.organisationId), credentialUsername(second.organisation.organisationId)];
    await controlPool.execute(
      `INSERT INTO organisations
        (organisation_id, display_name, canonical_slug, organisation_type, deployment_class, status, activation_state)
       VALUES (?, 'Legacy Regression Scheme', 'phase11e-legacy', 'medical_scheme', 'demo', 'active', 'activated')`,
      [legacyOrganisationId],
    );
    await controlPool.execute(
      `INSERT INTO data_plane_routes
        (route_id, organisation_id, route_type, logical_database_identifier, database_name, secret_reference,
         region, route_generation, schema_version, provisioning_status, health_status, active_at, active_route_slot)
       VALUES (?, ?, 'legacy_shared', 'legacy-operational-shared', 'legacy', 'secret://runtime/MYSQL_URL',
         'southafricanorth', 1, '8', 'active', 'healthy', UTC_TIMESTAMP(3), ?)`,
      [crypto.randomUUID(), legacyOrganisationId, legacyOrganisationId],
    );

    const firstRun = await runProvisioningBatch({ maxOperations: 1 });
    assert.equal(firstRun.processed, 1);
    const firstOperation = await repositories.provisioning.getOperation(first.operation.operationId);
    assert.equal(firstOperation.status, "completed");
    assert.equal(firstOperation.leaseToken, null);
    const firstOrganisation = await repositories.organisations.getById(first.organisation.organisationId);
    assert.equal(firstOrganisation.status, "ready_for_activation");

    const [firstMetadata] = await adminPool.execute(
      `SELECT database_mode, logical_database_identifier, schema_version, environment_key, migration_version
       FROM \`${generatedDatabases[0]}\`.data_plane_metadata WHERE metadata_key = 'primary'`,
    );
    assert.deepEqual({
      databaseMode: firstMetadata[0].database_mode,
      logicalDatabaseIdentifier: firstMetadata[0].logical_database_identifier,
      schemaVersion: String(firstMetadata[0].schema_version),
      environmentKey: firstMetadata[0].environment_key,
      migrationVersion: Number(firstMetadata[0].migration_version),
    }, {
      databaseMode: "private_database",
      logicalDatabaseIdentifier: `private:${first.organisation.organisationId}`,
      schemaVersion: "10",
      environmentKey: "test",
      migrationVersion: 10,
    });
    const [migrationRows] = await adminPool.execute(`SELECT COUNT(*) AS count FROM \`${generatedDatabases[0]}\`.operational_migration_history`);
    assert.equal(Number(migrationRows[0].count), 10);

    const [privateRoutes] = await controlPool.execute(
      "SELECT route_type, provisioning_status, active_route_slot FROM data_plane_routes WHERE organisation_id = ? AND route_type = 'private_database'",
      [first.organisation.organisationId],
    );
    assert.equal(privateRoutes.length, 1);
    assert.equal(privateRoutes[0].provisioning_status, "ready");
    assert.equal(privateRoutes[0].active_route_slot, null);

    const usernameSecret = process.env[fallbackSecretName(first.organisation.organisationId, "mysql-username")];
    const passwordSecret = process.env[fallbackSecretName(first.organisation.organisationId, "mysql-password")];
    assert.equal(usernameSecret, generatedUsers[0]);
    assert.ok(passwordSecret);
    const tenantUrl = new URL(adminUrl);
    tenantUrl.pathname = `/${generatedDatabases[0]}`;
    tenantUrl.username = usernameSecret;
    tenantUrl.password = passwordSecret;
    const tenantConnection = await mysql.createConnection(tenantUrl.toString());
    await assert.rejects(
      () => tenantConnection.query("SELECT * FROM claimguard_tenant_isolation_fixture.data_plane_metadata"),
      (error) => ["ER_DBACCESS_DENIED_ERROR", "ER_TABLEACCESS_DENIED_ERROR", "ER_ACCESS_DENIED_ERROR"].includes(error.code),
    );
    await tenantConnection.end();

    const secondRun = await runProvisioningBatch({ maxOperations: 1 });
    assert.equal(secondRun.processed, 1);
    assert.equal((await repositories.provisioning.getOperation(second.operation.operationId)).status, "failed");
    const retryPasswordBefore = process.env[fallbackSecretName(second.organisation.organisationId, "mysql-password")];
    assert.ok(retryPasswordBefore);
    await addAdministrator(service, repositories, second.organisation, "phase11e-retry");
    const retried = await service.retryProvisioningOperation(second.operation.operationId, { type: "system", id: null });
    assert.equal(retried.status, "pending");
    const retryRun = await runProvisioningBatch({ maxOperations: 1 });
    assert.equal(retryRun.processed, 1);
    assert.equal((await repositories.provisioning.getOperation(second.operation.operationId)).status, "completed");
    assert.equal(process.env[fallbackSecretName(second.organisation.organisationId, "mysql-password")], retryPasswordBefore);

    const [legacyRoutes] = await controlPool.execute(
      "SELECT route_type, provisioning_status, active_route_slot FROM data_plane_routes WHERE organisation_id = ?",
      [legacyOrganisationId],
    );
    assert.equal(legacyRoutes.length, 1);
    assert.equal(legacyRoutes[0].route_type, "legacy_shared");
    assert.equal(legacyRoutes[0].provisioning_status, "active");
    assert.equal(legacyRoutes[0].active_route_slot, legacyOrganisationId);
  } finally {
    for (const username of generatedUsers) {
      await adminPool.query(`DROP USER IF EXISTS '${username}'@'%'`);
    }
    for (const name of generatedDatabases) {
      await adminPool.query(`DROP DATABASE IF EXISTS \`${name}\``);
    }
    await Promise.all([adminPool.end(), controlPool.end()]);
  }
});
