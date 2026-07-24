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

function appFor({ repository = null, authContext = ADMIN } = {}) {
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
  });
  return app;
}

function configureModels() {
  process.env.APPROVED_MODEL_DEPLOYMENT_IDS = [
    "claimguard-fraud-model:1.2.0",
    "alpha-proprietary-model:production",
  ].join(",");
  process.env.CLAIMGUARD_MANAGED_MODEL_DEPLOYMENT_ID = "claimguard-fraud-model:1.2.0";
  process.env.SCHEME_MODEL_DEPLOYMENTS_JSON = JSON.stringify({
    "tenant-alpha": ["alpha-proprietary-model:production"],
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
        return { strategyType: "deterministic_rules", modelDeploymentId: null };
      },
    },
  });

  const response = await app.request("/detection/strategy");
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.strategy.strategyType, "selection_required");
  assert.equal(body.strategy.requiresSelection, true);
  assert.match(body.strategy.message, /Deterministic scoring is no longer selectable/);
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
    },
  }]);
  assert.equal(body.strategy.strategyType, "claimguard_managed");
  assert.equal(body.strategy.modelDeploymentId, "claimguard-fraud-model:1.2.0");
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
    }),
  });
  const rejectedBody = await rejected.json();

  assert.equal(rejected.status, 400);
  assert.equal(rejectedBody.code, "SCHEME_MODEL_DEPLOYMENT_NOT_APPROVED");
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
