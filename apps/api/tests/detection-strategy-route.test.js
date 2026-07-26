import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

import { Hono } from "hono";

import { CLAIMGUARD_PERMISSIONS } from "../src/authorization-policy.js";
import { registerAdminRoutes } from "../src/routes/admin-routes.js";

const TENANT_CONTEXT = Object.freeze({
  tenant_id: "tenant-alpha",
  tenant_slug: "alpha",
  scheme_id: "ALPHA01",
});

const ADMIN = Object.freeze({
  is_authenticated: true,
  user_id: "scheme-admin-1",
  tenant_id: "tenant-alpha",
  roles: Object.freeze(["scheme_administrator"]),
  permissions: new Set([CLAIMGUARD_PERMISSIONS.USERS_MANAGE_TENANT]),
});

const NON_ADMIN = Object.freeze({
  is_authenticated: true,
  user_id: "analyst-1",
  tenant_id: "tenant-alpha",
  roles: Object.freeze(["fraud_analyst"]),
  permissions: new Set(),
});

function appFor({
  repository = null,
  authContext = ADMIN,
  modelDeploymentRepository = null,
} = {}) {
  const app = new Hono();
  app.use("*", async (context, next) => {
    context.set("authContext", authContext);
    context.set("tenantContext", TENANT_CONTEXT);
    await next();
  });
  registerAdminRoutes(app, {
    reportService: {
      async checkReadiness() {
        return { ready: true, degraded: false, checks: {} };
      },
    },
    detectionStrategyRepository: repository,
    modelDeploymentRepository,
  });
  return app;
}

function configureModels() {
  process.env.APPROVED_MODEL_DEPLOYMENT_IDS = [
    "claimguard-fraud-model:1.1.0",
    "claimguard-fraud-model:1.2.0",
    "alpha-proprietary-model:production",
    "beta-proprietary-model:production",
  ].join(",");
  process.env.CLAIMGUARD_MANAGED_MODEL_DEPLOYMENT_ID = "claimguard-fraud-model:1.2.0";
  process.env.SCHEME_MODEL_DEPLOYMENTS_JSON = JSON.stringify({
    "tenant-alpha": ["alpha-proprietary-model:production"],
    "tenant-beta": ["beta-proprietary-model:production"],
  });
}

afterEach(() => {
  delete process.env.APPROVED_MODEL_DEPLOYMENT_IDS;
  delete process.env.CLAIMGUARD_MANAGED_MODEL_DEPLOYMENT_ID;
  delete process.env.SCHEME_MODEL_DEPLOYMENTS_JSON;
});

test("GET projects a legacy deterministic strategy as selection required", async () => {
  configureModels();
  const app = appFor({
    repository: {
      async getActiveStrategy() {
        return {
          strategyId: 7,
          strategyType: "deterministic_rules",
          modelDeploymentId: null,
        };
      },
    },
  });

  const response = await app.request("/detection/strategy");
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.strategy.strategyType, "selection_required");
  assert.equal(body.strategy.requiresSelection, true);
  assert.match(body.strategy.message, /Deterministic scoring is no longer selectable/);
  assert.deepEqual(body.modelCatalogue.schemeOwned, [{
    deploymentId: "alpha-proprietary-model:production",
    displayName: "alpha-proprietary-model:production",
    modelId: null,
    modelVersion: null,
    featureSchemaVersion: null,
    ownership: "scheme",
  }]);
});

test("GET preserves a managed scheme posture when a newer fleet deployment is promoted", async () => {
  configureModels();
  const app = appFor({
    repository: {
      async getActiveStrategy() {
        return {
          strategyId: 9,
          strategyType: "approved_model",
          modelDeploymentId: "claimguard-fraud-model:1.1.0",
        };
      },
    },
  });

  const response = await app.request("/detection/strategy");
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.strategy.strategyType, "claimguard_managed");
  assert.equal(body.strategy.modelDeploymentId, "claimguard-fraud-model:1.1.0");
  assert.equal(body.strategy.updateAvailable, true);
  assert.equal(body.strategy.recommendedModelDeploymentId, "claimguard-fraud-model:1.2.0");
});

test("GET does not misclassify another scheme's proprietary deployment as fleet-managed", async () => {
  configureModels();
  const app = appFor({
    repository: {
      async getActiveStrategy() {
        return {
          strategyId: 10,
          strategyType: "approved_model",
          modelDeploymentId: "beta-proprietary-model:production",
        };
      },
    },
  });

  const response = await app.request("/detection/strategy");
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.strategy.strategyType, "selection_required");
  assert.equal(body.strategy.requiresSelection, true);
  assert.deepEqual(
    body.modelCatalogue.schemeOwned.map((model) => model.deploymentId),
    ["alpha-proprietary-model:production"],
  );
});

test("PUT ClaimGuard-managed selection resolves the platform deployment and stores an approved model", async () => {
  configureModels();
  const calls = [];
  const app = appFor({
    repository: {
      async setStrategy(tenantContext, change) {
        calls.push({ tenantContext, change });
        return { strategyId: 12, changed: true };
      },
    },
  });

  const response = await app.request("/detection/strategy", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      strategyType: "claimguard_managed",
      modelDeploymentId: null,
      changeReason: "Use ClaimGuard's validated production model.",
      expectedActiveStrategyId: 7,
    }),
  });
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.deepEqual(calls, [{
    tenantContext: TENANT_CONTEXT,
    change: {
      strategyType: "approved_model",
      modelDeploymentId: "claimguard-fraud-model:1.2.0",
      actor: "scheme-admin-1",
      changeReason: "Use ClaimGuard's validated production model.",
      expectedActiveStrategyId: 7,
    },
  }]);
  assert.equal(body.strategy.strategyType, "claimguard_managed");
  assert.equal(body.strategy.modelDeploymentId, "claimguard-fraud-model:1.2.0");
});

test("PUT requires the active strategy ID and rejects a stale strategy transition", async () => {
  configureModels();
  let called = false;
  const missingExpectationApp = appFor({
    repository: {
      async setStrategy() {
        called = true;
      },
    },
  });

  const missingExpectation = await missingExpectationApp.request(
    "/detection/strategy",
    {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        strategyType: "claimguard_managed",
        modelDeploymentId: null,
        changeReason: "Attempt an unguarded transition.",
      }),
    },
  );
  const missingBody = await missingExpectation.json();

  assert.equal(missingExpectation.status, 400);
  assert.equal(
    missingBody.code,
    "EXPECTED_ACTIVE_STRATEGY_REQUIRED",
  );
  assert.equal(called, false);

  const conflictApp = appFor({
    repository: {
      async setStrategy() {
        const error = new Error(
          "The active detection strategy changed after it was read.",
        );
        error.code = "DETECTION_STRATEGY_CONFLICT";
        error.status = 409;
        throw error;
      },
    },
  });
  const conflict = await conflictApp.request(
    "/detection/strategy",
    {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        strategyType: "claimguard_managed",
        modelDeploymentId: null,
        changeReason: "Attempt a stale transition.",
        expectedActiveStrategyId: 7,
      }),
    },
  );
  const conflictBody = await conflict.json();

  assert.equal(conflict.status, 409);
  assert.equal(
    conflictBody.code,
    "DETECTION_STRATEGY_CONFLICT",
  );
});

test("PUT scheme-managed selection requires a tenant-owned approved deployment", async () => {
  configureModels();
  const calls = [];
  const repository = {
    async setStrategy(tenantContext, change) {
      calls.push({ tenantContext, change });
      return { strategyId: 13, changed: true };
    },
  };
  const app = appFor({ repository });

  const accepted = await app.request("/detection/strategy", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      strategyType: "scheme_managed",
      modelDeploymentId: "alpha-proprietary-model:production",
      changeReason: "Activate the scheme's validated proprietary model.",
      expectedActiveStrategyId: 8,
    }),
  });

  assert.equal(accepted.status, 200);
  assert.equal(calls[0].change.strategyType, "approved_model");
  assert.equal(calls[0].change.modelDeploymentId, "alpha-proprietary-model:production");

  const rejected = await app.request("/detection/strategy", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      strategyType: "scheme_managed",
      modelDeploymentId: "another-scheme-model:production",
      changeReason: "Attempt a foreign deployment.",
      expectedActiveStrategyId: 8,
    }),
  });
  const rejectedBody = await rejected.json();

  assert.equal(rejected.status, 400);
  assert.equal(rejectedBody.code, "SCHEME_MODEL_DEPLOYMENT_NOT_APPROVED");
  assert.equal(calls.length, 1);
});

test("registered catalogue dynamically gates and labels scheme-owned selection", async () => {
  configureModels();
  process.env.SCHEME_MODEL_DEPLOYMENTS_JSON = "{}";
  const calls = [];
  const registered = [{
    deploymentId: "alpha-proprietary-model:production",
    modelId: "alpha-fraud-model",
    modelVersion: "3.0.0",
    displayName: "Alpha proprietary fraud model",
    ownerType: "scheme",
    ownerOrganisationId: "org-alpha",
    lifecycleStatus: "active",
    featureSchemaVersion: "claim-feature-schema-2026.2",
  }];
  const app = appFor({
    authContext: {
      ...ADMIN,
      organisation_id: "org-alpha",
    },
    repository: {
      async getActiveStrategy() {
        return {
          strategyId: 7,
          strategyType: "approved_model",
          modelDeploymentId: "claimguard-fraud-model:1.2.0",
        };
      },
      async setStrategy(tenantContext, change) {
        calls.push({ tenantContext, change });
        return { strategyId: 8, changed: true };
      },
    },
    modelDeploymentRepository: {
      async listSelectableForOrganisation(organisationId) {
        assert.equal(organisationId, "org-alpha");
        return registered;
      },
    },
  });

  const listed = await app.request("/detection/strategy");
  const listedBody = await listed.json();
  assert.equal(
    listedBody.modelCatalogue.schemeOwned[0].displayName,
    "Alpha proprietary fraud model",
  );

  const accepted = await app.request("/detection/strategy", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      strategyType: "scheme_managed",
      modelDeploymentId: "alpha-proprietary-model:production",
      changeReason: "Use the scheme-scoped durable catalogue entry.",
      expectedActiveStrategyId: 7,
    }),
  });
  assert.equal(accepted.status, 200);
  assert.equal(calls.length, 1);

  registered.length = 0;
  const rejected = await app.request("/detection/strategy", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      strategyType: "scheme_managed",
      modelDeploymentId: "alpha-proprietary-model:production",
      changeReason: "Attempt an unregistered runtime selection.",
      expectedActiveStrategyId: 7,
    }),
  });
  const rejectedBody = await rejected.json();

  assert.equal(rejected.status, 400);
  assert.equal(
    rejectedBody.code,
    "SCHEME_MODEL_DEPLOYMENT_NOT_APPROVED",
  );
  assert.equal(calls.length, 1);
});

test("PUT rejects deterministic scoring and managed deployment pinning", async () => {
  configureModels();
  let called = false;
  const app = appFor({
    repository: {
      async setStrategy() {
        called = true;
      },
    },
  });

  const deterministic = await app.request("/detection/strategy", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      strategyType: "deterministic_rules",
      modelDeploymentId: null,
      changeReason: "This must be rejected.",
      expectedActiveStrategyId: 9,
    }),
  });
  assert.equal(deterministic.status, 400);

  const pinnedManaged = await app.request("/detection/strategy", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      strategyType: "claimguard_managed",
      modelDeploymentId: "claimguard-fraud-model:1.2.0",
      changeReason: "A scheme must not pin the managed deployment.",
      expectedActiveStrategyId: 9,
    }),
  });
  const body = await pinnedManaged.json();

  assert.equal(pinnedManaged.status, 400);
  assert.equal(body.code, "MANAGED_MODEL_DEPLOYMENT_FORBIDDEN");
  assert.equal(called, false);
});

test("strategy routes remain permission protected and fail closed without a repository", async () => {
  configureModels();
  const forbidden = await appFor({
    authContext: NON_ADMIN,
    repository: {
      async getActiveStrategy() {
        throw new Error("must not be called");
      },
    },
  }).request("/detection/strategy");
  assert.equal(forbidden.status, 403);

  const unavailable = await appFor().request("/detection/strategy");
  assert.equal(unavailable.status, 503);
});
