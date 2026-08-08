import assert from "node:assert/strict";
import test from "node:test";
import { Hono } from "hono";

import {
  registerClerkAuthRoutes,
  safeClerkSessionResponse,
} from "../src/routes/clerk-auth-routes.js";

const configuration = { deploymentClass: "production" };
const resolvedIdentity = {
  actor: {
    user: {
      userId: "user-1",
      displayName: "Alpha Analyst",
      canonicalContact: "analyst@example.com",
      status: "active",
    },
    organisation: {
      organisationId: "org-1",
      organisationType: "medical_scheme",
      canonicalSlug: "alpha-health",
    },
    membership: { status: "active" },
    credential: { status: "active" },
    roles: ["fraud_analyst"],
    permissions: ["claims.view_own", "investigations.view"],
    legacyTenant: { tenantId: "tenant-alpha", tenantSlug: "alpha" },
  },
  externalIdentity: {
    verifiedEmail: "analyst@example.com",
    issuedAt: 1_786_186_800,
    expiresAt: 1_786_190_400,
  },
};

test("Clerk session responses expose safe workforce and operational authority", () => {
  const response = safeClerkSessionResponse(resolvedIdentity, configuration);

  assert.equal(response.authenticated, true);
  assert.equal(response.authenticationProvider, "clerk");
  assert.equal(response.account.passwordChangeAvailable, false);
  assert.equal(response.account.mfaRequired, true);
  assert.equal(response.operationalTenant.tenantId, "tenant-alpha");
  assert.equal(response.deployment.demo, false);
  assert.match(response.sessionActivity.issuedAt, /^2026-/);
  assert.equal(JSON.stringify(response).includes("password"), true);
  assert.equal(JSON.stringify(response).includes("sessionSecret"), false);
});

test("Clerk owns browser sign-in, sign-up, invitation, and password endpoints", async () => {
  const app = new Hono();
  app.use("*", async (c, next) => {
    if (c.req.header("x-test-signed-in") === "true") c.set("resolvedSession", resolvedIdentity);
    await next();
  });
  registerClerkAuthRoutes(app, { configuration });

  assert.deepEqual(await (await app.request("/auth/session")).json(), { authenticated: false });
  const session = await app.request("/auth/session", { headers: { "x-test-signed-in": "true" } });
  assert.equal(session.status, 200);
  assert.equal((await session.json()).user.userId, "user-1");

  const logout = await app.request("/auth/logout", { method: "POST" });
  assert.deepEqual(await logout.json(), {
    authenticated: false,
    authenticationProvider: "clerk",
  });

  for (const [method, path] of [
    ["GET", "/auth/csrf"],
    ["POST", "/auth/login"],
    ["POST", "/o/alpha/login"],
    ["POST", "/auth/signup"],
    ["POST", "/auth/invitation/validate"],
    ["POST", "/auth/password/change"],
  ]) {
    const response = await app.request(path, { method });
    const body = await response.json();
    assert.equal(response.status, 410);
    assert.equal(body.code, "CLERK_MANAGED_AUTHENTICATION");
    assert.match(body.message, /managed by Clerk/);
  }
});
