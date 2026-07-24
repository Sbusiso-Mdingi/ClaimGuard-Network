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
    await next();
  });

  registerSchemeAdminRoutes(app, {
    controlPlaneService: {
      async listUsersByOrganisation(organisationId, actor) {
        calls.push({ organisationId, actor });
        return [{ userId: "user-1", displayName: "Ubuntu Admin", username: "admin@example.com", roles: ["scheme_administrator"], userStatus: "active" }];
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
