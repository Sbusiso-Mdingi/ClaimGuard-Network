import assert from "node:assert/strict";
import test from "node:test";
import { Hono } from "hono";

import { registerDesktopAdminRoutes, registerDesktopRoutes } from "../src/routes/desktop-routes.js";

const authenticationConfiguration = {
  deploymentClass: "test",
  cookie: { name: "claim_guard_session", sameSite: "Strict", httpOnly: true, secure: true },
};

function sessionResult() {
  return {
    bearerSecret: "session-secret",
    csrfToken: "csrf-token",
    actor: {
      user: {
        userId: "user-alpha",
        displayName: "Alpha Analyst",
        canonicalContact: "analyst@alpha.example",
        status: "active",
      },
      organisation: {
        organisationId: "org-alpha",
        organisationType: "medical_scheme",
        canonicalSlug: "alpha-medical",
      },
      membership: { status: "active" },
      credential: {
        normalizedUsername: "analyst",
        status: "active",
        authenticationProvider: "local_password",
      },
      roles: ["claims_analyst"],
      permissions: ["claims.view_own"],
    },
    session: {
      issuedAt: "2026-08-01T00:00:00.000Z",
      lastActivityAt: "2026-08-01T00:10:00.000Z",
      idleExpiresAt: "2026-08-01T01:00:00.000Z",
      absoluteExpiresAt: "2026-08-02T00:00:00.000Z",
    },
  };
}

function deviceContext() {
  return {
    deviceEnrollmentId: "device-alpha",
    organisationId: "org-alpha",
    organisationSlug: "alpha-medical",
    organisationDisplayName: "Alpha Medical",
  };
}

test("desktop activation and session routes preserve one fixed licensed organisation", async () => {
  const activationInputs = [];
  const loggedOut = [];
  const resolved = sessionResult();
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.set("desktopDevice", deviceContext());
    c.set("resolvedSession", resolved);
    c.set("authenticationMetadata", { ipAddress: "127.0.0.1" });
    await next();
  });
  registerDesktopRoutes(app, {
    authenticationConfiguration,
    authenticationService: {
      async logout(value) { loggedOut.push(value); },
    },
    desktopEnrollmentService: {
      async activate(input) {
        activationInputs.push(input);
        if (input.activationKey === "rejected") {
          throw Object.assign(new Error("Activation key rejected."), { status: 409, code: "ACTIVATION_KEY_REJECTED" });
        }
        return { signedEnrollment: "signed-enrollment", licensedOrganisation: { organisationId: "org-alpha" } };
      },
      async renewEnrollment() { return { signedEnrollment: "renewed" }; },
    },
  });

  const invalid = await app.request("/desktop/activate", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ activationKey: "key", installationId: "install", devicePublicKey: "public", organisationId: "org-beta" }),
  });
  assert.equal(invalid.status, 400);

  const activated = await app.request("/desktop/activate", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ activationKey: "accepted", installationId: "install", devicePublicKey: "public" }),
  });
  assert.equal(activated.status, 201);
  assert.equal((await activated.json()).licensedOrganisation.organisationId, "org-alpha");
  assert.equal(activationInputs.length, 1);

  const rejected = await app.request("/desktop/activate", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ activationKey: "rejected", installationId: "install", devicePublicKey: "public" }),
  });
  assert.equal(rejected.status, 409);
  assert.equal((await rejected.json()).code, "ACTIVATION_KEY_REJECTED");

  const current = await app.request("/desktop/auth/session");
  const currentBody = await current.json();
  assert.equal(currentBody.authenticated, true);
  assert.equal(currentBody.licensedOrganisation.organisationId, "org-alpha");
  assert.equal(currentBody.account.username, "analyst");

  const logout = await app.request("/desktop/auth/logout", { method: "POST" });
  assert.equal(logout.status, 200);
  assert.match(logout.headers.get("set-cookie"), /Max-Age=0/);
  assert.deepEqual(loggedOut, [resolved]);
});

test("desktop data routes cover bounded sync, cached detail, and optimistic concurrency", async () => {
  const syncInputs = [];
  const updateInputs = [];
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.set("desktopDevice", deviceContext());
    c.set("dataPlaneContext", { organisationId: "org-alpha", operationalTenantId: "tenant-alpha" });
    c.set("authContext", {
      is_authenticated: true,
      user_id: "user-alpha",
      organisation_id: "org-alpha",
      roles: ["claims_analyst", "investigator"],
      permissions: new Set([
        "claims.view_own",
        "investigations.view",
        "investigations.update_status",
        "investigations.change_priority",
      ]),
    });
    await next();
  });
  registerDesktopRoutes(app, {
    desktopEnrollmentService: { async renewEnrollment() { return { signedEnrollment: "renewed" }; } },
    desktopSyncRepository: { kind: "test-repository" },
    desktopSyncService: {
      async bootstrap(input) {
        syncInputs.push(["bootstrap", input]);
        if (String(input.limit) === "999") {
          throw Object.assign(new Error("Bootstrap window expired."), {
            status: 410,
            code: "BOOTSTRAP_WINDOW_EXPIRED",
            details: { requiresBootstrap: true },
          });
        }
        return { available: true, items: [{ claimId: "claim-1" }], nextCursor: "cursor-1" };
      },
      async changes(input) {
        syncInputs.push(["changes", input]);
        return { available: true, items: [], tombstones: [], nextCursor: "cursor-2" };
      },
    },
    claimsReadRepository: {
      async getClaimById(claimId) {
        if (claimId === "missing") return null;
        if (claimId === "broken") throw new Error("Database unavailable");
        return { claimId, currentClaimVersion: 4, status: "FLAGGED" };
      },
    },
    investigationService: {
      async getInvestigationDetails(investigationId) {
        if (investigationId === "missing") return null;
        if (investigationId === "broken") throw new Error("Database unavailable");
        return {
          investigationId,
          tenantId: "tenant-alpha",
          claimId: "claim-1",
          assignedInvestigator: "investigator-alpha",
          assignedBy: "analyst-alpha",
          status: "OPEN",
          priority: "HIGH",
          createdAt: "2026-08-01T09:00:00.000Z",
          updatedAt: "2026-08-01T10:00:00.000Z",
          notes: [{ noteId: "note-1", tenantId: "tenant-alpha", text: "Review provider invoice." }],
          evidence: [{ evidenceId: "evidence-1", tenantId: "tenant-alpha", filename: "invoice.pdf" }],
        };
      },
      async updateInvestigation(input) {
        updateInputs.push(input);
        if (input.investigationId === "stale") {
          throw Object.assign(new Error("stale"), { code: "stale_record_version" });
        }
        return {
          investigationId: input.investigationId,
          tenantId: "tenant-alpha",
          status: input.status,
          priority: input.priority,
          updatedAt: "2026-08-01T10:00:00.000Z",
        };
      },
    },
  });

  const bootstrap = await app.request("/desktop/sync/bootstrap?limit=50&schemaVersion=1");
  assert.equal(bootstrap.status, 200);
  assert.equal((await bootstrap.json()).enrollment.signedEnrollment, "renewed");
  assert.equal(syncInputs[0][1].device.organisationId, "org-alpha");
  assert.equal(syncInputs[0][1].schemaVersion, "1");

  const changes = await app.request("/desktop/sync/changes?cursor=cursor-1&limit=25&schemaVersion=1");
  assert.equal(changes.status, 200);
  assert.equal((await changes.json()).nextCursor, "cursor-2");
  assert.equal(syncInputs[1][1].cursor, "cursor-1");

  const expired = await app.request("/desktop/sync/bootstrap?limit=999&schemaVersion=1");
  assert.equal(expired.status, 410);
  assert.equal((await expired.json()).requiresBootstrap, true);

  const detail = await app.request("/desktop/claims/claim-1");
  assert.equal(detail.status, 200);
  assert.equal((await detail.json()).etag, "W/\"claim-4\"");
  assert.equal((await app.request("/desktop/claims/missing")).status, 404);
  assert.equal((await app.request("/desktop/claims/broken")).status, 500);

  const investigationDetail = await app.request("/desktop/investigations/investigation-1");
  assert.equal(investigationDetail.status, 200);
  assert.equal(investigationDetail.headers.get("etag"), "W/\"2026-08-01T10:00:00.000Z\"");
  const investigationBody = await investigationDetail.json();
  assert.equal(investigationBody.investigation.investigationId, "investigation-1");
  assert.equal(investigationBody.investigation.tenantId, undefined);
  assert.equal(investigationBody.investigation.notes[0].tenantId, undefined);
  assert.equal(investigationBody.investigation.evidence[0].tenantId, undefined);
  assert.equal((await app.request("/desktop/investigations/missing")).status, 404);
  assert.equal((await app.request("/desktop/investigations/broken")).status, 500);

  const missingVersion = await app.request("/desktop/investigations/investigation-1", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ status: "under_review" }),
  });
  assert.equal(missingVersion.status, 428);

  const invalidMutation = await app.request("/desktop/investigations/investigation-1", {
    method: "PATCH",
    headers: { "content-type": "application/json", "if-match": "version-1" },
    body: JSON.stringify({ note: "not supported" }),
  });
  assert.equal(invalidMutation.status, 400);

  const updated = await app.request("/desktop/investigations/investigation-1", {
    method: "PATCH",
    headers: { "content-type": "application/json", "if-match": "W/\"version-1\"" },
    body: JSON.stringify({ status: "under_review", priority: "high" }),
  });
  assert.equal(updated.status, 200);
  assert.equal(updated.headers.get("etag"), "W/\"2026-08-01T10:00:00.000Z\"");
  assert.equal((await updated.json()).investigation.tenantId, undefined);
  assert.equal(updateInputs[0].expectedUpdatedAt, "version-1");

  const stale = await app.request("/desktop/investigations/stale", {
    method: "PATCH",
    headers: { "content-type": "application/json", "if-match": "version-1" },
    body: JSON.stringify({ status: "closed" }),
  });
  assert.equal(stale.status, 412);
  assert.equal((await stale.json()).code, "STALE_RECORD_VERSION");
});

test("desktop investigation detail fails closed when its service is unavailable", async () => {
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.set("desktopDevice", deviceContext());
    c.set("dataPlaneContext", { organisationId: "org-alpha", operationalTenantId: "tenant-alpha" });
    c.set("authContext", {
      is_authenticated: true,
      user_id: "user-alpha",
      organisation_id: "org-alpha",
      roles: ["investigator"],
      permissions: new Set(["investigations.view"]),
    });
    await next();
  });
  registerDesktopRoutes(app);

  const response = await app.request("/desktop/investigations/investigation-1");
  assert.equal(response.status, 503);
  assert.equal((await response.json()).code, "DESKTOP_INVESTIGATION_UNAVAILABLE");
});

test("desktop administration routes require scope, step-up, and exact destructive confirmations", async () => {
  const calls = [];
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.set("authContext", {
      is_authenticated: true,
      user_id: "admin-alpha",
      organisation_id: "org-alpha",
      roles: ["scheme_administrator"],
      permissions: new Set(["desktop.devices.manage"]),
    });
    c.set("resolvedSession", { sessionId: "session-alpha" });
    c.set("authenticationMetadata", { ipAddress: "127.0.0.1" });
    await next();
  });
  registerDesktopAdminRoutes(app, {
    authenticationService: {
      async reauthenticate(session, password) { calls.push(["reauthenticate", session, password]); },
    },
    desktopEnrollmentService: {
      async getAdminSnapshot(organisationId) { return { organisationId, devices: [], activationKeys: [] }; },
      async issueActivationKey(input, actor) {
        calls.push(["issue", input, actor]);
        return { activationKey: "one-time-key", activationKeyId: "key-1" };
      },
      async revokeActivationKey(input, actor) {
        calls.push(["revoke-key", input, actor]);
        return { activationKeyId: input.activationKeyId, status: "revoked" };
      },
      async revokeDevice(input, actor) {
        calls.push(["revoke-device", input, actor]);
        return { deviceEnrollmentId: input.deviceEnrollmentId, status: "revoked" };
      },
    },
  });

  const snapshotResponse = await app.request("/admin/desktop/organisations/org-alpha");
  assert.equal(snapshotResponse.status, 200);
  assert.equal((await snapshotResponse.json()).organisationId, "org-alpha");
  assert.equal((await app.request("/admin/desktop/organisations/org-beta")).status, 403);

  const mismatch = await app.request("/admin/desktop/organisations/org-alpha/activation-keys", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password: "secret", confirmation: "wrong" }),
  });
  assert.equal(mismatch.status, 400);

  const issued = await app.request("/admin/desktop/organisations/org-alpha/activation-keys", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password: "secret", confirmation: "ISSUE DESKTOP KEY", expiresInHours: 12, maximumUses: 1 }),
  });
  assert.equal(issued.status, 201);
  assert.equal((await issued.json()).displayedOnce, true);

  const wrongKeyConfirmation = await app.request("/admin/desktop/organisations/org-alpha/activation-keys/key-1/revoke", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password: "secret", confirmation: "wrong" }),
  });
  assert.equal(wrongKeyConfirmation.status, 400);

  const revokedKey = await app.request("/admin/desktop/organisations/org-alpha/activation-keys/key-1/revoke", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password: "secret", confirmation: "REVOKE KEY key-1", reason: "unused" }),
  });
  assert.equal(revokedKey.status, 200);

  const wrongDeviceConfirmation = await app.request("/admin/desktop/organisations/org-alpha/devices/device-1/revoke", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password: "secret", confirmation: "wrong" }),
  });
  assert.equal(wrongDeviceConfirmation.status, 400);

  const revokedDevice = await app.request("/admin/desktop/organisations/org-alpha/devices/device-1/revoke", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password: "secret", confirmation: "REVOKE DEVICE device-1", reason: "lost" }),
  });
  assert.equal(revokedDevice.status, 200);
  assert.equal(calls.filter(([kind]) => kind === "reauthenticate").length, 3);
  assert.equal(calls.find(([kind]) => kind === "issue")[1].organisationId, "org-alpha");
  assert.equal(calls.find(([kind]) => kind === "revoke-device")[2].id, "admin-alpha");
});

test("desktop routes fail closed when enrollment or administration is not configured", async () => {
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.set("authContext", {
      is_authenticated: true,
      organisation_id: "org-alpha",
      roles: ["scheme_administrator"],
      permissions: new Set(["desktop.devices.manage"]),
    });
    await next();
  });
  registerDesktopRoutes(app);
  registerDesktopAdminRoutes(app);

  assert.equal((await app.request("/desktop/activate", { method: "POST" })).status, 503);
  assert.equal((await app.request("/desktop/auth/login", { method: "POST" })).status, 503);
  assert.equal((await app.request("/desktop/auth/session")).status, 200);
  assert.equal((await app.request("/admin/desktop/organisations/org-alpha")).status, 503);
  assert.equal((await app.request("/admin/desktop/organisations/org-alpha/activation-keys", { method: "POST" })).status, 503);
  assert.equal((await app.request("/admin/desktop/organisations/org-alpha/activation-keys/key-1/revoke", { method: "POST" })).status, 503);
  assert.equal((await app.request("/admin/desktop/organisations/org-alpha/devices/device-1/revoke", { method: "POST" })).status, 503);
});
