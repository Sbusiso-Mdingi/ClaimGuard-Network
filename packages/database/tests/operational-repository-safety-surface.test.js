import assert from "node:assert/strict";
import test from "node:test";

import { createDataPlaneContext } from "../src/data-plane-context.js";
import { createOperationalRepositories } from "../src/operational-repositories.js";

function context() {
  return createDataPlaneContext({
    organisationId: "org-tenant-a",
    organisationType: "medical_scheme",
    organisationStatus: "active",
    operationalTenantId: "tenant-a",
    operationalTenantSlug: "tenant-a",
    routeId: "route-tenant-a",
    routeType: "legacy_shared",
    routeGeneration: 1,
    logicalDatabaseIdentifier: "test-operational",
    databaseName: null,
    schemaVersion: "17",
    deploymentClass: "test",
    region: "test",
  });
}

function pool() {
  return {
    async execute() {
      return [[], []];
    },
    async query() {
      return [[], []];
    },
    async getConnection() {
      throw new Error("No database operation is expected in this construction test.");
    },
  };
}

test("production operational composition exposes shared registry reads but no publication writes", () => {
  const repositories = createOperationalRepositories(context(), pool());
  assert.equal(typeof repositories.registry.searchRegistry, "function");
  assert.equal(typeof repositories.registry.getRegistryHistory, "function");
  assert.equal(typeof repositories.registry.getRegistryRecordById, "function");
  assert.equal(Object.hasOwn(repositories.registry, "publishConfirmedFraud"), false);
  assert.equal(Object.hasOwn(repositories.registry, "publishFraudReversal"), false);
  assert.equal(Object.isFrozen(repositories.registry), true);
});

test("production operational composition preserves distinct disabled legacy fraud errors", async () => {
  const repositories = createOperationalRepositories(context(), pool());
  await assert.rejects(
    repositories.fraudWorkflow.confirmFraud(),
    (error) => error.code === "LEGACY_FRAUD_CONFIRMATION_DISABLED" && error.status === 409,
  );
  await assert.rejects(
    repositories.fraudWorkflow.reverseFraud(),
    (error) => error.code === "LEGACY_FRAUD_REVERSAL_DISABLED" && error.status === 409,
  );
});

test("production operational composition rejects direct legacy status writes before SQL", async () => {
  const repositories = createOperationalRepositories(context(), pool());
  await assert.rejects(
    repositories.investigations.updateInvestigation({
      investigationId: "investigation-1",
      status: "CONFIRMED_FRAUD",
    }),
    (error) => error.code === "LEGACY_INVESTIGATION_STATUS_WRITE_DISABLED" && error.status === 409,
  );
});
