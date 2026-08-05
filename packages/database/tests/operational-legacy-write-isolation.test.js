import assert from "node:assert/strict";
import test from "node:test";

import {
  createDataPlaneContext,
  createOperationalRepositories,
} from "../src/index.js";

function dataPlaneContext() {
  return createDataPlaneContext({
    organisationId: "org-tenant-default",
    organisationType: "medical_scheme",
    organisationStatus: "active",
    operationalTenantId: "tenant_default",
    operationalTenantSlug: "default",
    routeId: "route-tenant-default",
    routeType: "legacy_shared",
    routeGeneration: 1,
    logicalDatabaseIdentifier: "legacy-operational-shared",
    databaseName: null,
    schemaVersion: "17",
    deploymentClass: "test",
    region: "test",
  });
}

test("supported operational construction exposes only fail-closed legacy fraud adapters", async () => {
  let databaseCalls = 0;
  const pool = {
    async execute() {
      databaseCalls += 1;
      throw new Error("Disabled legacy adapters must not reach the database.");
    },
    async getConnection() {
      databaseCalls += 1;
      throw new Error("Disabled legacy adapters must not acquire a connection.");
    },
  };

  const repositories = createOperationalRepositories(dataPlaneContext(), pool);

  await assert.rejects(
    repositories.fraudWorkflow.confirmFraud({ investigationId: "legacy-1" }),
    (error) => error.code === "LEGACY_FRAUD_CONFIRMATION_DISABLED" && error.status === 409,
  );
  await assert.rejects(
    repositories.fraudWorkflow.reverseFraud({ investigationId: "legacy-1" }),
    (error) => error.code === "LEGACY_FRAUD_REVERSAL_DISABLED" && error.status === 409,
  );
  assert.equal(databaseCalls, 0);
});
