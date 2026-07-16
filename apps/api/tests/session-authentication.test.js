import assert from "node:assert/strict";
import test from "node:test";

import { resolveAuthenticationConfiguration } from "../src/authentication-config.js";
import { createBackendApp } from "../src/backend.js";

function configuration(overrides = {}) {
  return {
    mode: "session", deploymentClass: "demo", production: false,
    cookie: { name: "__Host-cg_session", secure: true, sameSite: "Lax", path: "/", httpOnly: true },
    idleTimeoutMs: 1_800_000, absoluteTimeoutMs: 28_800_000,
    allowedOrigins: ["http://localhost"], trustProxy: false,
    demoCredentialsVisible: false, demoCredentials: [],
    ...overrides,
  };
}

function actor({ platform = false } = {}) {
  return {
    user: { userId: "user-1", displayName: "Investigator" },
    organisation: {
      organisationId: platform ? "platform-org" : "org-1",
      displayName: platform ? "ClaimGuard" : "Alpha",
      canonicalSlug: platform ? "claimguard" : "alpha",
      organisationType: platform ? "platform" : "medical_scheme",
      deploymentClass: "demo",
    },
    membership: { membershipId: "membership-1" },
    credential: { credentialId: "credential-1" },
    roles: [platform ? "platform_administrator" : "investigator"],
    permissions: platform ? ["organisation.manage", "platform_health.view"] : ["reports.view_own", "investigations.manage"],
    legacyTenant: platform ? null : { tenantId: "tenant-alpha", tenantSlug: "alpha" },
  };
}

function authService({ loginFailure = false, platform = false } = {}) {
  const calls = { events: [], logout: 0, login: 0 };
  const resolved = {
    actor: actor({ platform }),
    session: {
      sessionId: "session-1", organisationId: platform ? "platform-org" : "org-1",
      userId: "user-1", membershipId: "membership-1", credentialId: "credential-1",
      idleExpiresAt: new Date("2026-07-16T09:00:00Z"), absoluteExpiresAt: new Date("2026-07-16T16:00:00Z"),
      csrfTokenHash: "hash",
    },
  };
  return {
    calls,
    async login() {
      calls.login += 1;
      if (loginFailure) throw new Error("internal credential detail");
      return { ...resolved, bearerSecret: "s".repeat(43), csrfToken: "csrf-token" };
    },
    async resolveOrganisationCandidate(slug) { return slug === "alpha" ? { organisationId: "org-1", canonicalSlug: "alpha" } : null; },
    async resolveSession(secret) { if (secret !== "s".repeat(43)) throw new Error("invalid"); return resolved; },
    verifyCsrf(_session, token) { return token === "csrf-token"; },
    async rotateCsrf() { return "csrf-token"; },
    async logout() { calls.logout += 1; return true; },
    async recordSecurityEvent(...args) { calls.events.push(args); },
  };
}

const tenantRepository = {
  async lookupTenantById(id) { return id === "tenant-alpha" ? { tenant_id: id, tenant_slug: "alpha", scheme_id: "scheme-a" } : null; },
  async lookupTenantBySlug() { return null; },
};

function sessionApp(options = {}) {
  const service = options.service || authService(options);
  const app = createBackendApp({
    authenticationConfiguration: configuration(options.configuration),
    authenticationService: service,
    tenantRepository,
  });
  return { app, service };
}

test("authentication configuration defaults to session and rejects production header or demo exposure modes", () => {
  const session = resolveAuthenticationConfiguration({ CONTROL_PLANE_MYSQL_URL: "mysql://u:p@localhost/control" });
  assert.equal(session.mode, "session");
  assert.throws(() => resolveAuthenticationConfiguration({ AUTHENTICATION_MODE: "hybrid" }), /session or demo_headers/);
  assert.throws(() => resolveAuthenticationConfiguration({ AUTHENTICATION_MODE: "demo_headers", DEPLOYMENT_CLASS: "production" }), /refuses/);
  assert.throws(() => resolveAuthenticationConfiguration({ CONTROL_PLANE_MYSQL_URL: "mysql://u:p@localhost/control", DEPLOYMENT_CLASS: "production" }), /AUTH_ALLOWED_ORIGINS/);
  assert.throws(() => resolveAuthenticationConfiguration({ CONTROL_PLANE_MYSQL_URL: "mysql://u:p@localhost/control", DEPLOYMENT_CLASS: "production", DEMO_CREDENTIALS_VISIBLE: "true" }), /DEMO_CREDENTIALS_VISIBLE|demo credential exposure/);
});

test("login issues a secure opaque cookie and safe session response", async () => {
  const { app } = sessionApp();
  const response = await app.request("http://localhost/auth/login", {
    method: "POST", headers: { origin: "http://localhost", "content-type": "application/json" },
    body: JSON.stringify({ organisationSlug: "alpha", username: "investigator", password: "not-logged" }),
  });
  const payload = await response.json();
  assert.equal(response.status, 200);
  assert.equal(payload.authenticated, true);
  assert.deepEqual(payload.roles, ["investigator"]);
  assert.equal(Object.hasOwn(payload, "bearerSecret"), false);
  assert.equal(Object.hasOwn(payload, "legacyTenant"), false);
  const cookie = response.headers.get("set-cookie");
  assert.match(cookie, /^__Host-cg_session=/);
  assert.match(cookie, /Secure/);
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Lax/);
  assert.match(cookie, /Path=\//);
  assert.doesNotMatch(cookie, /Domain=/);
});

test("login failure and path/form mismatch return the same generic external message", async () => {
  const { app } = sessionApp({ loginFailure: true });
  const request = (url, body) => app.request(url, {
    method: "POST", headers: { origin: "http://localhost", "content-type": "application/json" }, body: JSON.stringify(body),
  });
  const failed = await request("http://localhost/auth/login", { organisationSlug: "alpha", username: "x", password: "x" });
  const mismatched = await request("http://localhost/o/beta/login", { organisationSlug: "alpha", username: "x", password: "x" });
  assert.equal(failed.status, 401);
  assert.equal(mismatched.status, 401);
  assert.equal((await failed.json()).message, "The organisation or credentials could not be verified.");
  assert.equal((await mismatched.json()).message, "The organisation or credentials could not be verified.");
});

test("session mode resolves server identity and rejects all spoofed authority headers", async () => {
  const { app, service } = sessionApp();
  const cookie = `__Host-cg_session=${"s".repeat(43)}`;
  const sessionResponse = await app.request("http://localhost/auth/session", { headers: { cookie } });
  assert.equal(sessionResponse.status, 200);
  assert.equal((await sessionResponse.json()).organisation.organisationId, "org-1");
  const spoofed = await app.request("http://localhost/health", {
    headers: { cookie, "x-claimguard-role": "platform_administrator" },
  });
  assert.equal(spoofed.status, 403);
  assert.equal((await spoofed.json()).code, "IDENTITY_HEADER_REJECTED");
  assert.equal(service.calls.events.some(([type]) => type === "header_spoof_attempt"), true);
});

test("CSRF requires both allowed Origin and the session-bound token while GET remains safe", async () => {
  const { app } = sessionApp();
  const cookie = `__Host-cg_session=${"s".repeat(43)}`;
  assert.equal((await app.request("http://localhost/auth/session", { headers: { cookie } })).status, 200);
  const missing = await app.request("http://localhost/auth/logout", { method: "POST", headers: { cookie, origin: "http://localhost" } });
  const wrongOrigin = await app.request("http://localhost/auth/logout", { method: "POST", headers: { cookie, origin: "https://evil.example", "x-csrf-token": "csrf-token" } });
  const valid = await app.request("http://localhost/auth/logout", { method: "POST", headers: { cookie, origin: "http://localhost", "x-csrf-token": "csrf-token" } });
  assert.equal(missing.status, 403);
  assert.equal(wrongOrigin.status, 403);
  assert.equal(valid.status, 200);
  assert.match(valid.headers.get("set-cookie"), /Max-Age=0/);
});

test("header rollback mode ignores session cookies and does not expose session endpoints", async () => {
  const app = createBackendApp();
  const response = await app.request("http://localhost/auth/session", { headers: { cookie: `__Host-cg_session=${"s".repeat(43)}` } });
  assert.equal(response.status, 404);
});

test("demo account endpoint is fail-closed and returns only safe catalogue entries joined to ephemeral deployment secrets", async () => {
  const hidden = sessionApp();
  assert.equal((await hidden.app.request("http://localhost/auth/demo-accounts")).status, 404);

  const catalogueEntry = {
    catalogueEntryId: "catalogue-1", organisationId: "org-1", membershipId: "membership-1",
    displayLabel: "Investigator — Alpha", roleLabel: "Investigator", usernameDisplayValue: "investigator.demo",
    organisationSlug: "alpha", organisationName: "Alpha",
  };
  const app = createBackendApp({
    authenticationConfiguration: configuration({
      demoCredentialsVisible: true,
      demoCredentials: [{ organisationSlug: "alpha", username: "investigator.demo", password: "deployment-only-value" }],
    }),
    authenticationService: authService(), tenantRepository,
    controlPlaneConfigurationRepository: { async listSafeEnabledDemoCatalogueAll() { return [catalogueEntry]; } },
  });
  const response = await app.request("http://localhost/auth/demo-accounts");
  const payload = await response.json();
  assert.equal(response.status, 200);
  assert.equal(payload.accounts.length, 1);
  assert.equal(payload.accounts[0].password, "deployment-only-value");
  assert.equal(Object.hasOwn(payload.accounts[0], "secretReference"), false);
  assert.match(payload.warning, /DEMO-ONLY/);
});

test("internal service authentication uses its dedicated bearer mechanism and rejects browser authority headers", async () => {
  const token = "i".repeat(32);
  const { app } = sessionApp({ configuration: { internalServiceToken: token } });
  const accepted = await app.request("http://localhost/health", { headers: {
    authorization: `Bearer ${token}`,
    "x-cg-service-actor": "simulator-worker",
    "x-cg-service-role": "platform_administrator",
    "x-cg-service-tenant": "tenant-alpha",
  } });
  assert.equal(accepted.status, 200);
  const rejected = await app.request("http://localhost/health", { headers: {
    authorization: `Bearer ${token}`,
    "x-cg-service-actor": "simulator-worker",
    "x-cg-service-role": "platform_administrator",
    "x-cg-service-tenant": "tenant-alpha",
    "x-claimguard-role": "investigator",
  } });
  assert.equal(rejected.status, 403);
  assert.equal((await rejected.json()).code, "IDENTITY_HEADER_REJECTED");
});

test("platform organisation session has no operational tenant and receives no private-route bypass", async () => {
  const { app } = sessionApp({ platform: true });
  const response = await app.request("http://localhost/detection/report", { headers: { cookie: `__Host-cg_session=${"s".repeat(43)}` } });
  assert.equal(response.status, 403);
});
