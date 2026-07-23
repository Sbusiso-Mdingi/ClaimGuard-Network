import assert from "node:assert/strict";
import test from "node:test";

import { createPrivateDatabaseAdapter } from "../src/private-database-adapter.js";

function baseContext(overrides = {}) {
  return {
    organisationId: "org-private",
    organisationType: "medical_scheme",
    organisationStatus: "active",
    routeId: "route-private",
    routeType: "private_database",
    routeGeneration: 1,
    logicalDatabaseIdentifier: "private-db-1",
    schemaVersion: "13",
    deploymentClass: "production",
    secretReference: "https://kv.example.vault.azure.net/secrets/user",
    ...overrides,
  };
}

test("private adapter rejects non-private route type", async () => {
  const adapter = createPrivateDatabaseAdapter();
  await assert.rejects(
    adapter.create(baseContext({
      routeType: "legacy_shared",
      operationalTenantId: "tenant-shared",
      operationalTenantSlug: "tenant-shared",
    })),
    /private_database routes/,
  );
});

test("private adapter rejects incomplete secret references before pool creation", async () => {
  let poolFactoryCalled = false;
  const adapter = createPrivateDatabaseAdapter({
    poolFactory() {
      poolFactoryCalled = true;
      return {};
    },
  });

  await assert.rejects(
    adapter.create(baseContext({ secretReference: "https://kv.example.vault.azure.net/secrets/user" })),
    /must include username, password, host, and database/,
  );
  assert.equal(poolFactoryCalled, false);
});

test("private adapter verify enforces metadata compatibility", async () => {
  const adapter = createPrivateDatabaseAdapter({ expectedEnvironment: "production", expectedMigrationVersion: 13 });
  const pool = {
    async execute() {
      return [[{
        database_mode: "private_database",
        logical_database_identifier: "private-db-1",
        schema_version: "13",
        environment_key: "staging",
        migration_version: 13,
      }], []];
    },
  };

  await assert.rejects(
    adapter.verify(pool, baseContext()),
    /environment verification failed/,
  );
});

test("private adapter verify returns normalized metadata when compatible", async () => {
  const adapter = createPrivateDatabaseAdapter({ expectedEnvironment: "production", expectedMigrationVersion: 13 });
  const pool = {
    async execute() {
      return [[{
        database_mode: "private_database",
        logical_database_identifier: "private-db-1",
        schema_version: "13",
        environment_key: "production",
        migration_version: 13,
      }], []];
    },
  };

  const verified = await adapter.verify(pool, baseContext());
  assert.equal(verified.routeType, "private_database");
  assert.equal(verified.logicalDatabaseIdentifier, "private-db-1");
  assert.equal(verified.schemaVersion, "13");
  assert.equal(verified.migrationVersion, 13);
});
