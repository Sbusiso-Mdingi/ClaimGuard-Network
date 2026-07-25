import assert from "node:assert/strict";
import test from "node:test";

import { Hono } from "hono";

import { CLAIMGUARD_PERMISSIONS } from "../src/authorization-policy.js";
import { registerSchemeAdminRoutes } from "../src/routes/scheme-admin-routes.js";

function createApp(authContext) {
  const calls = [];
  const app = new Hono();

  app.use("*", async (c, next) => {
    c.set("authContext", authContext);
    c.set("requestId", "request-1");
    c.set("tenantContext", { tenant_id: "tenant-ubuntu", scheme_id: "scheme-ubuntu" });
    await next();
  });

  registerSchemeAdminRoutes(app, {
    controlPlaneService: {
      async listUsersByOrganisation(organisationId, actor) {
        calls.push({ organisationId, actor });
        return [{ userId: "user-1", displayName: "Ubuntu Admin", username: "admin@example.com", roles: ["scheme_administrator"], userStatus: "active" }];
      },
    },
    claimsReadRepository: {
      async listClaims({ page, pageSize }) {
        calls.push({ type: "claims", page, pageSize });
        if (page === 1) {
          return {
            claims: [
              { claimId: "C-1", processingStatus: "scored", investigation: { status: "OPEN" } },
              { claimId: "C-2", processingStatus: "queued", investigation: null },
            ],
            pagination: { page: 1, pageSize: 100, total: 3, totalPages: 2 },
          };
        }
        return {
          claims: [
            { claimId: "C-3", processingStatus: "failed", investigation: { status: "UNDER_REVIEW" } },
          ],
          pagination: { page: 2, pageSize: 100, total: 3, totalPages: 2 },
        };
      },
    },
    detectionStrategyRepository: {
      async getActiveStrategy(tenantContext) {
        calls.push({ type: "strategy", tenantContext });
        return {
          strategy_id: 7,
          strategy_type: "approved_model",
          model_deployment_id: "deployment-1",
          activated_at: "2026-07-25T08:00:00.000Z",
          activated_by: "scheme-admin-1",
          change_reason: "Approved production model",
        };
      },
    },
  });

  return { app, calls };
}

test("scheme administrator with users.manage_tenant can list organisation users", async () => {
  const { app, calls } = createApp({
    is_authenticated: true,
    user_id: "scheme-admin-1",
    organisation_id: "org-ubuntu",
    roles: ["scheme_administrator"],
    permissions: new Set([CLAIMGUARD_PERMISSIONS.USERS_MANAGE_TENANT]),
  });

  const response = await app.request("/admin/scheme/users");
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.available, true);
  assert.equal(body.users.length, 1);
  assert.deepEqual(calls, [{
    organisationId: "org-ubuntu",
    actor: {
      type: "user",
      id: "scheme-admin-1",
      organisationId: "org-ubuntu",
      source: "scheme-admin-api",
      correlationId: "request-1",
    },
  }]);
});

test("tenant status authority returns an aggregated scheme operations overview", async () => {
  const { app, calls } = createApp({
    is_authenticated: true,
    user_id: "scheme-admin-1",
    organisation_id: "org-ubuntu",
    roles: ["scheme_administrator"],
    permissions: new Set([CLAIMGUARD_PERMISSIONS.TENANT_STATUS_VIEW]),
  });

  const response = await app.request("/admin/scheme/overview");
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.available, true);
  assert.equal(body.overview.claims.total, 3);
  assert.equal(body.overview.claims.scored, 1);
  assert.equal(body.overview.claims.awaitingScoring, 1);
  assert.equal(body.overview.claims.failed, 1);
  assert.equal(body.overview.claims.completionRate, 33.33);
  assert.deepEqual(body.overview.investigations.byStatus, { open: 1, under_review: 1 });
  assert.equal(body.overview.detectionStrategy.modelDeploymentId, "deployment-1");
  assert.deepEqual(calls.filter((call) => call.type === "claims"), [
    { type: "claims", page: 1, pageSize: 100 },
    { type: "claims", page: 2, pageSize: 100 },
  ]);
});

test("user without users.manage_tenant remains forbidden", async () => {
  const { app, calls } = createApp({
    is_authenticated: true,
    user_id: "fraud-analyst-1",
    organisation_id: "org-ubuntu",
    roles: ["fraud_analyst"],
    permissions: new Set(),
  });

  const response = await app.request("/admin/scheme/users");

  assert.equal(response.status, 403);
  assert.equal(calls.length, 0);
});

test("user without tenant_status.view cannot read the scheme overview", async () => {
  const { app, calls } = createApp({
    is_authenticated: true,
    user_id: "fraud-analyst-1",
    organisation_id: "org-ubuntu",
    roles: ["fraud_analyst"],
    permissions: new Set(),
  });

  const response = await app.request("/admin/scheme/overview");

  assert.equal(response.status, 403);
  assert.equal(calls.length, 0);
});
