import assert from "node:assert/strict";
import test from "node:test";
import { Hono } from "hono";

import { createDataPlaneMiddleware } from "../src/middleware/data-plane-middleware.js";
import { createBackendApp } from "../src/backend.js";
import { createAuthenticatedAuthContext } from "../src/middleware/auth-context.js";
import { createCanonicalDetectionReport } from "./helpers/detection-report.js";

function context(overrides = {}) {
  return Object.freeze({
    organisationId: "org-alpha", routeId: "route-alpha", routeType: "legacy_shared", routeGeneration: 1,
    operationalTenantId: "tenant-alpha", operationalTenantSlug: "alpha", ...overrides,
    organisationType: "medical_scheme", organisationStatus: "active", logicalDatabaseIdentifier: "legacy-operational-shared",
    databaseName: "operational", schemaVersion: "8", deploymentClass: "demo",
  });
}

test("operational middleware routes only from authenticated organisation and skips authentication/public paths", async () => {
  const calls = [];
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.set("requestId", "corr");
    c.set("authContext", { is_authenticated: true, organisation_id: "org-alpha", user_id: "user-alpha", source: "session" });
    await next();
  });
  app.use("*", createDataPlaneMiddleware({
    routeResolver: { async resolve(input) { calls.push(input); return context(); } },
    connectionManager: { async acquire() { return { pool: {}, async release() {} }; } },
    createServiceBundle() { return {}; },
  }));
  app.get("/auth/session", (c) => c.json({ routed: Boolean(c.get("dataPlaneContext")) }));
  app.get("/health", (c) => c.json({ routed: Boolean(c.get("dataPlaneContext")) }));
  app.get("/claims", (c) => c.json({ organisationId: c.get("dataPlaneContext").organisationId }));

  assert.deepEqual(await (await app.request("/auth/session")).json(), { routed: false });
  assert.deepEqual(await (await app.request("/health")).json(), { routed: false });
  const privateResponse = await app.request("/claims", { headers: { "x-claimguard-tenant": "tenant-beta" } });
  assert.deepEqual(await privateResponse.json(), { organisationId: "org-alpha" });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].organisationId, "org-alpha");
});

test("platform_none fails private routes before pool acquisition", async () => {
  let acquired = false;
  const app = new Hono();
  app.use("*", async (c, next) => { c.set("authContext", { is_authenticated: true, organisation_id: "org-platform", user_id: "admin", source: "session" }); await next(); });
  app.use("*", createDataPlaneMiddleware({
    routeResolver: { async resolve() { return context({ organisationId: "org-platform", routeType: "platform_none", operationalTenantId: null }); } },
    connectionManager: { async acquire() { acquired = true; } },
    createServiceBundle() { return {}; },
  }));
  app.get("/claims", (c) => c.json({ unexpected: true }));
  const response = await app.request("/claims");
  assert.equal(response.status, 503);
  assert.equal((await response.json()).code, "DATA_PLANE_NOT_AVAILABLE");
  assert.equal(acquired, false);
});

test("suspension failure retires only the authenticated organisation cache", async () => {
  const retired = [];
  const app = new Hono();
  app.use("*", async (c, next) => { c.set("authContext", { is_authenticated: true, organisation_id: "org-alpha", user_id: "user", source: "session" }); await next(); });
  app.use("*", createDataPlaneMiddleware({
    routeResolver: { async resolve() { throw Object.assign(new Error("inactive"), { code: "DATA_PLANE_ORGANISATION_INACTIVE", status: 503 }); } },
    connectionManager: { async acquire() { throw new Error("must not acquire"); }, async retireOrganisation(id) { retired.push(id); } },
    createServiceBundle() { return {}; },
  }));
  app.get("/claims", (c) => c.json({ unexpected: true }));
  const response = await app.request("/claims");
  assert.equal(response.status, 503);
  assert.deepEqual(retired, ["org-alpha"]);
});

test("backend operational services are constructed request-scoped from the verified routed pool", async () => {
  let resolutions = 0;
  const routedContext = context();
  const pool = {
    async execute() { return [[], []]; }, async query() { return [[], []]; },
    async getConnection() { throw new Error("not used by report read"); },
  };
  const report = createCanonicalDetectionReport({ tenantId: "tenant-alpha" });
  const app = createBackendApp({
    authenticationProvider: { async resolveAuthContext() {
      return createAuthenticatedAuthContext({
        userId: "user-alpha", organisationId: "org-alpha", tenantId: "tenant-alpha",
        roles: ["fraud_analyst"], permissions: ["reports.view_own"], source: "session",
      });
    } },
    reportStorage: { async getLatestReport() { return { report, metadata: { tenant: "tenant-alpha" } }; } },
    dataPlaneRuntime: {
      routeResolver: { async resolve({ organisationId }) { resolutions += 1; assert.equal(organisationId, "org-alpha"); return routedContext; } },
      connectionManager: { async acquire() { return { pool, async release() {} }; }, metrics() { return { pools: [] }; } },
    },
  });
  const response = await app.request("http://localhost/detection/report", { headers: { "x-claimguard-tenant": "tenant-beta" } });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).report.metadata.tenant.tenantId, "tenant-alpha");
  assert.equal(resolutions, 1);
});
