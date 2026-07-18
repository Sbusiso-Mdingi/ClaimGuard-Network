import assert from "node:assert/strict";
import test from "node:test";
import { Hono } from "hono";

import { createDataPlaneMiddleware } from "../src/middleware/data-plane-middleware.js";
import { createBackendApp } from "../src/backend.js";
import { createAuthenticatedAuthContext } from "../src/middleware/auth-context.js";
import { CLAIMGUARD_PERMISSIONS } from "../src/authorization-policy.js";
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
    c.set("authContext", {
      is_authenticated: true,
      organisation_id: "org-alpha",
      user_id: "user-alpha",
      source: "session",
      permissions: new Set([CLAIMGUARD_PERMISSIONS.CLAIMS_VIEW_OWN]),
    });
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
  app.use("*", async (c, next) => {
    c.set("authContext", {
      is_authenticated: true,
      organisation_id: "org-platform",
      user_id: "admin",
      source: "session",
      permissions: new Set([CLAIMGUARD_PERMISSIONS.CLAIMS_VIEW_OWN]),
    });
    await next();
  });
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
  app.use("*", async (c, next) => {
    c.set("authContext", {
      is_authenticated: true,
      organisation_id: "org-alpha",
      user_id: "user",
      source: "session",
      permissions: new Set([CLAIMGUARD_PERMISSIONS.CLAIMS_VIEW_OWN]),
    });
    await next();
  });
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

test("a session invalidated by organisation suspension retires that organisation before private authorization", async () => {
  const retired = [];
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.set("authContext", { is_authenticated: false, source: "invalid_session" });
    c.set("dataPlaneOrganisationToRetire", "org-alpha");
    await next();
  });
  app.use("*", createDataPlaneMiddleware({
    routeResolver: { async resolve() { throw new Error("must not resolve an invalid session"); } },
    connectionManager: {
      async acquire() { throw new Error("must not acquire"); },
      async retireOrganisation(id, reason) { retired.push([id, reason]); },
    },
    createServiceBundle() { return {}; },
  }));
  app.get("/investigations/private", (c) => c.json({ authenticated: false }, 401));
  const response = await app.request("/investigations/private");
  assert.equal(response.status, 401);
  assert.deepEqual(retired, [["org-alpha", "session_organisation_inactive"]]);
});

test("private claims routes deny platform administrators before route resolution", async () => {
  let resolveCalls = 0;
  let acquireCalls = 0;
  let bundleCalls = 0;
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.set("authContext", {
      is_authenticated: true,
      organisation_id: "org-platform",
      user_id: "admin",
      source: "session",
      roles: ["platform_administrator"],
      permissions: new Set([CLAIMGUARD_PERMISSIONS.TENANTS_MANAGE]),
    });
    await next();
  });
  app.use("*", createDataPlaneMiddleware({
    routeResolver: { async resolve() { resolveCalls += 1; return context({ organisationId: "org-platform" }); } },
    connectionManager: { async acquire() { acquireCalls += 1; return { pool: {}, async release() {} }; } },
    createServiceBundle() { bundleCalls += 1; return {}; },
  }));
  app.get("/claims", (c) => c.json({ unexpected: true }));
  app.get("/claims/:claimId", (c) => c.json({ unexpected: c.req.param("claimId") }));

  const listResponse = await app.request("/claims", { headers: { "x-claimguard-role": "claims_analyst", "x-claimguard-tenant": "tenant-spoof" } });
  const listBody = await listResponse.json();
  const detailResponse = await app.request("/claims/CLAIM-1", { headers: { "x-claimguard-role": "claims_analyst", "x-claimguard-tenant": "tenant-spoof" } });
  const detailBody = await detailResponse.json();

  assert.equal(listResponse.status, 403);
  assert.equal(listBody.code, "FORBIDDEN");
  assert.equal(detailResponse.status, 403);
  assert.equal(detailBody.code, "FORBIDDEN");
  assert.equal(resolveCalls, 0);
  assert.equal(acquireCalls, 0);
  assert.equal(bundleCalls, 0);
});

test("authorized claims analyst still reaches resolver and preserves missing-route fail-closed behavior", async () => {
  let resolveCalls = 0;
  let acquireCalls = 0;
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.set("authContext", {
      is_authenticated: true,
      organisation_id: "org-analyst",
      user_id: "claims-user",
      source: "session",
      roles: ["claims_analyst"],
      permissions: new Set([CLAIMGUARD_PERMISSIONS.CLAIMS_VIEW_OWN]),
    });
    await next();
  });
  app.use("*", createDataPlaneMiddleware({
    routeResolver: {
      async resolve() {
        resolveCalls += 1;
        throw Object.assign(new Error("route missing"), {
          code: "DATA_PLANE_ROUTE_MISSING",
          status: 503,
        });
      },
    },
    connectionManager: { async acquire() { acquireCalls += 1; } },
    createServiceBundle() { return {}; },
  }));
  app.get("/claims", (c) => c.json({ unexpected: true }));

  const response = await app.request("/claims");
  const body = await response.json();

  assert.equal(response.status, 503);
  assert.equal(body.code, "DATA_PLANE_ROUTE_MISSING");
  assert.equal(resolveCalls, 1);
  assert.equal(acquireCalls, 0);
});

test("detection private route also denies platform administrators before route resolution", async () => {
  let resolveCalls = 0;
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.set("authContext", {
      is_authenticated: true,
      organisation_id: "org-platform",
      user_id: "admin",
      source: "session",
      roles: ["platform_administrator"],
      permissions: new Set([CLAIMGUARD_PERMISSIONS.TENANTS_MANAGE]),
    });
    await next();
  });
  app.use("*", createDataPlaneMiddleware({
    routeResolver: { async resolve() { resolveCalls += 1; return context({ organisationId: "org-platform" }); } },
    connectionManager: { async acquire() { return { pool: {}, async release() {} }; } },
    createServiceBundle() { return {}; },
  }));
  app.get("/detection/report", (c) => c.json({ unexpected: true }));

  const response = await app.request("/detection/report");
  const body = await response.json();

  assert.equal(response.status, 403);
  assert.equal(body.code, "FORBIDDEN");
  assert.equal(resolveCalls, 0);
});

test("unknown operational private route fails closed before route resolution", async () => {
  let resolveCalls = 0;
  let acquireCalls = 0;
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.set("authContext", {
      is_authenticated: true,
      organisation_id: "org-analyst",
      user_id: "claims-user",
      source: "session",
      permissions: new Set([CLAIMGUARD_PERMISSIONS.CLAIMS_VIEW_OWN]),
    });
    await next();
  });
  app.use("*", createDataPlaneMiddleware({
    routeResolver: { async resolve() { resolveCalls += 1; return context(); } },
    connectionManager: { async acquire() { acquireCalls += 1; return { pool: {}, async release() {} }; } },
    createServiceBundle() { return {}; },
  }));

  const response = await app.request("/claims/private-policy-gap", { method: "POST" });
  const body = await response.json();

  assert.equal(response.status, 503);
  assert.equal(body.code, "OPERATIONAL_ROUTE_POLICY_MISSING");
  assert.equal(resolveCalls, 0);
  assert.equal(acquireCalls, 0);
});

test("OPTIONS on operational path bypasses data-plane resolution", async () => {
  let resolveCalls = 0;
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.set("authContext", {
      is_authenticated: true,
      organisation_id: "org-any",
      user_id: "user-any",
      source: "session",
      permissions: new Set(),
    });
    await next();
  });
  app.use("*", createDataPlaneMiddleware({
    routeResolver: { async resolve() { resolveCalls += 1; return context(); } },
    connectionManager: { async acquire() { return { pool: {}, async release() {} }; } },
    createServiceBundle() { return {}; },
  }));
  app.options("/claims", (c) => c.body(null, 204));

  const response = await app.request("/claims", { method: "OPTIONS" });
  assert.equal(response.status, 204);
  assert.equal(resolveCalls, 0);
});

test("HEAD on mapped claims route uses canonical GET policy and resolves data-plane", async () => {
  let resolveCalls = 0;
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.set("authContext", {
      is_authenticated: true,
      organisation_id: "org-analyst",
      user_id: "claims-user",
      source: "session",
      permissions: new Set([CLAIMGUARD_PERMISSIONS.CLAIMS_VIEW_OWN]),
    });
    await next();
  });
  app.use("*", createDataPlaneMiddleware({
    routeResolver: { async resolve() { resolveCalls += 1; return context(); } },
    connectionManager: { async acquire() { return { pool: {}, async release() {} }; } },
    createServiceBundle() { return {}; },
  }));
  app.get("/claims", (c) => c.json({ available: true }));

  const response = await app.request("/claims", { method: "HEAD" });
  assert.equal(response.status, 200);
  assert.equal(resolveCalls, 1);
});

test("unsupported method on mapped operational prefix fails closed before resolution", async () => {
  let resolveCalls = 0;
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.set("authContext", {
      is_authenticated: true,
      organisation_id: "org-analyst",
      user_id: "claims-user",
      source: "session",
      permissions: new Set([CLAIMGUARD_PERMISSIONS.CLAIMS_VIEW_OWN]),
    });
    await next();
  });
  app.use("*", createDataPlaneMiddleware({
    routeResolver: { async resolve() { resolveCalls += 1; return context(); } },
    connectionManager: { async acquire() { return { pool: {}, async release() {} }; } },
    createServiceBundle() { return {}; },
  }));

  const response = await app.request("/claims", { method: "PUT" });
  const body = await response.json();

  assert.equal(response.status, 503);
  assert.equal(body.code, "OPERATIONAL_ROUTE_POLICY_MISSING");
  assert.equal(resolveCalls, 0);
});

test("claims detail for authorized analyst reaches resolver", async () => {
  let resolveCalls = 0;
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.set("authContext", {
      is_authenticated: true,
      organisation_id: "org-analyst",
      user_id: "claims-user",
      source: "session",
      permissions: new Set([CLAIMGUARD_PERMISSIONS.CLAIMS_VIEW_OWN]),
    });
    await next();
  });
  app.use("*", createDataPlaneMiddleware({
    routeResolver: { async resolve() { resolveCalls += 1; return context(); } },
    connectionManager: { async acquire() { return { pool: {}, async release() {} }; } },
    createServiceBundle() { return {}; },
  }));
  app.get("/claims/:claimId", (c) => c.json({ claimId: c.req.param("claimId") }));

  const response = await app.request("/claims/C-123");
  assert.equal(response.status, 200);
  assert.equal(resolveCalls, 1);
});

test("denied investigations route does not resolve data-plane", async () => {
  let resolveCalls = 0;
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.set("authContext", {
      is_authenticated: true,
      organisation_id: "org-denied",
      user_id: "user-denied",
      source: "session",
      permissions: new Set(),
    });
    await next();
  });
  app.use("*", createDataPlaneMiddleware({
    routeResolver: { async resolve() { resolveCalls += 1; return context(); } },
    connectionManager: { async acquire() { return { pool: {}, async release() {} }; } },
    createServiceBundle() { return {}; },
  }));
  app.post("/investigations", (c) => c.json({ available: true }));

  const response = await app.request("/investigations", { method: "POST" });
  assert.equal(response.status, 403);
  assert.equal(resolveCalls, 0);
});

test("denied ledger route does not resolve data-plane", async () => {
  let resolveCalls = 0;
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.set("authContext", {
      is_authenticated: true,
      organisation_id: "org-denied",
      user_id: "user-denied",
      source: "session",
      permissions: new Set(),
    });
    await next();
  });
  app.use("*", createDataPlaneMiddleware({
    routeResolver: { async resolve() { resolveCalls += 1; return context(); } },
    connectionManager: { async acquire() { return { pool: {}, async release() {} }; } },
    createServiceBundle() { return {}; },
  }));
  app.get("/ledger/latest", (c) => c.json({ available: true }));

  const response = await app.request("/ledger/latest");
  assert.equal(response.status, 403);
  assert.equal(resolveCalls, 0);
});

test("denied registry route does not resolve data-plane", async () => {
  let resolveCalls = 0;
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.set("authContext", {
      is_authenticated: true,
      organisation_id: "org-denied",
      user_id: "user-denied",
      source: "session",
      permissions: new Set(),
    });
    await next();
  });
  app.use("*", createDataPlaneMiddleware({
    routeResolver: { async resolve() { resolveCalls += 1; return context(); } },
    connectionManager: { async acquire() { return { pool: {}, async release() {} }; } },
    createServiceBundle() { return {}; },
  }));
  app.get("/registry/search", (c) => c.json({ available: true }));

  const response = await app.request("/registry/search");
  assert.equal(response.status, 403);
  assert.equal(resolveCalls, 0);
});

test("denied simulator route does not resolve data-plane", async () => {
  let resolveCalls = 0;
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.set("authContext", {
      is_authenticated: true,
      organisation_id: "org-denied",
      user_id: "user-denied",
      source: "session",
      permissions: new Set(),
    });
    await next();
  });
  app.use("*", createDataPlaneMiddleware({
    routeResolver: { async resolve() { resolveCalls += 1; return context(); } },
    connectionManager: { async acquire() { return { pool: {}, async release() {} }; } },
    createServiceBundle() { return {}; },
  }));
  app.post("/simulator/start", (c) => c.json({ available: true }));

  const response = await app.request("/simulator/start", { method: "POST" });
  assert.equal(response.status, 403);
  assert.equal(resolveCalls, 0);
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
