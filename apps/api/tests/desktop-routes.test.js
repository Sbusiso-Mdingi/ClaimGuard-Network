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

test("Clerk desktop routes start, inspect, approve, and exchange a device-bound session", async () => {
  const calls = [];
  let pending = true;
  const result = sessionResult();
  result.actor.credential.authenticationProvider = "oidc";
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.set("desktopDevice", deviceContext());
    c.set("resolvedSession", {
      ...result,
      externalIdentity: { clerkUserId: "clerk-user-1", reverified: true },
    });
    c.set("authenticationMetadata", { correlationId: "request-1" });
    await next();
  });
  registerDesktopRoutes(app, {
    authenticationConfiguration: {
      ...authenticationConfiguration,
      mode: "clerk",
    },
    authenticationService: {
      async requireRecentVerification(resolved, metadata) {
        calls.push(["reverify", resolved, metadata]);
      },
      async logout(resolved) { calls.push(["logout", resolved]); },
    },
    desktopEnrollmentService: {
      async renewEnrollment(device) {
        calls.push(["renew", device]);
        return { signedEnrollment: "renewed" };
      },
    },
    clerkDesktopAuthorizationService: {
      async start(device, metadata) {
        calls.push(["start", device, metadata]);
        return {
          requestId: "request-1",
          pollingSecret: "p".repeat(43),
          verificationUrl: "https://work.sequrin.example/desktop/authorize#request=secret",
          expiresAt: "2026-08-08T10:10:00.000Z",
          pollingIntervalSeconds: 2,
        };
      },
      async inspect(secret, resolved) {
        calls.push(["inspect", secret, resolved]);
        return {
          requestId: "request-1",
          status: "pending",
          licensedOrganisation: { organisationId: "org-alpha", displayName: "Alpha Medical" },
        };
      },
      async approve(secret, resolved, metadata) {
        calls.push(["approve", secret, resolved, metadata]);
        return { approved: true, requestId: "request-1" };
      },
      async poll(secret, device, metadata) {
        calls.push(["poll", secret, device, metadata]);
        if (pending) return { pending: true, expiresAt: "2026-08-08T10:10:00.000Z" };
        return { pending: false, result };
      },
    },
  });

  assert.equal((await app.request("/desktop/auth/login", { method: "POST" })).status, 410);
  assert.equal((await app.request("/desktop/auth/clerk/start", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ organisationId: "org-beta" }),
  })).status, 400);
  const started = await app.request("/desktop/auth/clerk/start", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  assert.equal(started.status, 201);
  assert.equal((await started.json()).requestId, "request-1");

  const browserSecret = "b".repeat(43);
  assert.equal((await app.request("/auth/desktop/authorizations/inspect", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ browserSecret: "invalid" }),
  })).status, 400);
  const inspected = await app.request("/auth/desktop/authorizations/inspect", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ browserSecret }),
  });
  assert.equal(inspected.status, 200);
  assert.equal((await inspected.json()).licensedOrganisation.organisationId, "org-alpha");

  const approved = await app.request("/auth/desktop/authorizations/approve", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ browserSecret }),
  });
  assert.equal(approved.status, 200);
  assert.equal((await approved.json()).approved, true);
  assert.equal(calls.filter(([kind]) => kind === "reverify").length, 1);

  const pollingSecret = "p".repeat(43);
  const pollRequest = () => app.request("/desktop/auth/clerk/poll", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ pollingSecret }),
  });
  const pendingResponse = await pollRequest();
  assert.equal(pendingResponse.status, 202);
  assert.equal((await pendingResponse.json()).status, "pending");

  pending = false;
  const exchanged = await pollRequest();
  assert.equal(exchanged.status, 200);
  assert.match(exchanged.headers.get("set-cookie"), /claim_guard_session=session-secret/);
  assert.equal((await exchanged.json()).enrollment.signedEnrollment, "renewed");
});

test("desktop data routes cover bounded sync, cached detail, and optimistic concurrency", async () => {
  const syncInputs = [];
  const updateInputs = [];
  const createInputs = [];
  const noteInputs = [];
  const evidenceInputs = [];
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.set("desktopDevice", deviceContext());
    c.set("dataPlaneContext", { organisationId: "org-alpha", operationalTenantId: "tenant-alpha" });
    c.set("tenantContext", { tenant_id: "tenant-alpha" });
    c.set("authContext", {
      is_authenticated: true,
      user_id: "user-alpha",
      organisation_id: "org-alpha",
      roles: ["claims_analyst", "investigator"],
      permissions: new Set([
        "claims.view_own",
        "investigations.view",
        "investigations.create",
        "investigations.assign",
        "investigations.update_status",
        "investigations.change_priority",
        "investigations.add_note",
        "investigations.upload_evidence",
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
    identityRepository: {
      async listUsersByOrganisation() {
        return [
          { userId: "investigator-alpha", displayName: "Alpha Investigator", userStatus: "active", membershipStatus: "active", roles: ["investigator"] },
          { userId: "investigator-disabled", displayName: "Disabled Investigator", userStatus: "disabled", membershipStatus: "active", roles: ["investigator"] },
          { userId: "analyst-alpha", displayName: "Alpha Analyst", userStatus: "active", membershipStatus: "active", roles: ["fraud_analyst"] },
        ];
      },
    },
    investigationService: {
      async createInvestigation(input) {
        createInputs.push(input);
        return {
          investigationId: "investigation-created",
          tenantId: "tenant-alpha",
          claimId: input.claimId,
          assignedInvestigator: input.assignedInvestigator,
          assignedBy: input.assignedBy,
          status: "OPEN",
          priority: input.priority,
          recordVersion: 1,
        };
      },
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
          recordVersion: 7,
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
          assignedInvestigator: input.assignedInvestigator,
          recordVersion: input.expectedRecordVersion + 1,
          updatedAt: "2026-08-01T10:00:00.000Z",
        };
      },
      async addNote(input) {
        noteInputs.push(input);
        return {
          note: { noteId: "note-created", tenantId: "tenant-alpha", text: input.text, noteType: input.noteType },
          investigation: { investigationId: input.investigationId, tenantId: "tenant-alpha", recordVersion: input.expectedRecordVersion + 1 },
        };
      },
      async uploadEvidence(input) {
        evidenceInputs.push(input);
        return {
          evidence: { evidenceId: "evidence-created", tenantId: "tenant-alpha", filename: input.filename, contentSha256: "a".repeat(64) },
          investigation: { investigationId: input.investigationId, tenantId: "tenant-alpha", recordVersion: input.expectedRecordVersion + 1 },
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

  const investigators = await app.request("/desktop/investigators");
  assert.equal(investigators.status, 200);
  assert.deepEqual((await investigators.json()).investigators, [
    { userId: "investigator-alpha", displayName: "Alpha Investigator" },
  ]);

  const createdInvestigation = await app.request("/desktop/investigations", {
    method: "POST",
    headers: { "content-type": "application/json", "if-match": "W/\"claim-4\"" },
    body: JSON.stringify({ claimId: "claim-1", assignedInvestigator: "investigator-alpha", priority: "HIGH" }),
  });
  assert.equal(createdInvestigation.status, 201);
  assert.equal(createdInvestigation.headers.get("etag"), "W/\"investigation-1\"");
  assert.equal(createInputs[0].expectedClaimVersion, 4);
  assert.equal(createInputs[0].assignedBy, "user-alpha");

  const ineligibleAssignment = await app.request("/desktop/investigations", {
    method: "POST",
    headers: { "content-type": "application/json", "if-match": "W/\"claim-4\"" },
    body: JSON.stringify({ claimId: "claim-1", assignedInvestigator: "investigator-disabled", priority: "HIGH" }),
  });
  assert.equal(ineligibleAssignment.status, 409);

  const investigationDetail = await app.request("/desktop/investigations/investigation-1");
  assert.equal(investigationDetail.status, 200);
  assert.equal(investigationDetail.headers.get("etag"), "W/\"investigation-7\"");
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
    headers: { "content-type": "application/json", "if-match": "W/\"investigation-7\"" },
    body: JSON.stringify({ note: "not supported" }),
  });
  assert.equal(invalidMutation.status, 400);

  const updated = await app.request("/desktop/investigations/investigation-1", {
    method: "PATCH",
    headers: { "content-type": "application/json", "if-match": "W/\"investigation-7\"" },
    body: JSON.stringify({ status: "under_review", priority: "high" }),
  });
  assert.equal(updated.status, 200);
  assert.equal(updated.headers.get("etag"), "W/\"investigation-8\"");
  assert.equal((await updated.json()).investigation.tenantId, undefined);
  assert.equal(updateInputs[0].expectedRecordVersion, 7);

  const note = await app.request("/desktop/investigations/investigation-1/notes", {
    method: "POST",
    headers: { "content-type": "application/json", "if-match": "W/\"investigation-7\"" },
    body: JSON.stringify({ text: "Provider called.", noteType: "CONTACT" }),
  });
  assert.equal(note.status, 201);
  assert.equal(note.headers.get("etag"), "W/\"investigation-8\"");
  assert.equal(noteInputs[0].author, "user-alpha");

  const evidence = await app.request("/desktop/investigations/investigation-1/evidence", {
    method: "POST",
    headers: { "content-type": "application/json", "if-match": "W/\"investigation-7\"" },
    body: JSON.stringify({
      filename: "invoice.txt",
      description: "Invoice extract",
      evidenceType: "INVOICE",
      contentType: "text/plain",
      contentBase64: "aW52b2ljZQ==",
    }),
  });
  const evidenceBody = await evidence.json();
  assert.equal(evidence.status, 201, JSON.stringify(evidenceBody));
  assert.equal(evidence.headers.get("etag"), "W/\"investigation-8\"");
  assert.equal(evidenceInputs[0].tenantId, "tenant-alpha");

  const stale = await app.request("/desktop/investigations/stale", {
    method: "PATCH",
    headers: { "content-type": "application/json", "if-match": "W/\"investigation-1\"" },
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
      async requireRecentVerification(session) {
        calls.push(["reverify", session]);
        return { reauthenticatedAt: "2026-08-08T10:00:00.000Z" };
      },
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
  assert.equal((await app.request("/admin/desktop/organisations/org-alpha/policy", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ deviceLimit: 20, confirmation: "SET DESKTOP LIMIT 20" }),
  })).status, 403);

  const mismatch = await app.request("/admin/desktop/organisations/org-alpha/activation-keys", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ confirmation: "wrong" }),
  });
  assert.equal(mismatch.status, 400);

  const issued = await app.request("/admin/desktop/organisations/org-alpha/activation-keys", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ confirmation: "ISSUE DESKTOP KEY", expiresInHours: 12, maximumUses: 1 }),
  });
  assert.equal(issued.status, 201);
  assert.equal((await issued.json()).displayedOnce, true);

  const wrongKeyConfirmation = await app.request("/admin/desktop/organisations/org-alpha/activation-keys/key-1/revoke", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ confirmation: "wrong" }),
  });
  assert.equal(wrongKeyConfirmation.status, 400);

  const revokedKey = await app.request("/admin/desktop/organisations/org-alpha/activation-keys/key-1/revoke", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ confirmation: "REVOKE KEY key-1", reason: "unused" }),
  });
  assert.equal(revokedKey.status, 200);

  const wrongDeviceConfirmation = await app.request("/admin/desktop/organisations/org-alpha/devices/device-1/revoke", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ confirmation: "wrong" }),
  });
  assert.equal(wrongDeviceConfirmation.status, 400);

  const revokedDevice = await app.request("/admin/desktop/organisations/org-alpha/devices/device-1/revoke", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ confirmation: "REVOKE DEVICE device-1", reason: "lost" }),
  });
  assert.equal(revokedDevice.status, 200);
  assert.equal(calls.filter(([kind]) => kind === "reverify").length, 3);
  assert.equal(calls.find(([kind]) => kind === "issue")[1].organisationId, "org-alpha");
  assert.equal(calls.find(([kind]) => kind === "revoke-device")[2].id, "admin-alpha");
});

test("only platform fleet-policy administrators can set a bounded allowance with step-up authentication", async () => {
  const calls = [];
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.set("authContext", {
      is_authenticated: true,
      user_id: "platform-admin",
      organisation_id: "org-platform",
      roles: ["platform_administrator"],
      permissions: new Set(["desktop.fleet_policy.manage"]),
    });
    c.set("resolvedSession", { sessionId: "session-platform" });
    c.set("authenticationMetadata", { ipAddress: "127.0.0.1" });
    await next();
  });
  registerDesktopAdminRoutes(app, {
    authenticationService: {
      async requireRecentVerification(session) {
        calls.push(["reverify", session]);
        return { reauthenticatedAt: "2026-08-08T10:00:00.000Z" };
      },
    },
    desktopEnrollmentService: {
      async setFleetPolicy(input, actor) {
        calls.push(["set-policy", input, actor]);
        return {
          policy: { organisationId: input.organisationId, deviceLimit: input.deviceLimit, configured: true },
          usage: { activeDevices: 25, deviceLimit: input.deviceLimit, overLimit: true, enrollmentBlocked: true },
        };
      },
    },
  });

  const mismatch = await app.request("/admin/desktop/organisations/org-alpha/policy", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ deviceLimit: 20, confirmation: "wrong" }),
  });
  assert.equal(mismatch.status, 400);

  const updated = await app.request("/admin/desktop/organisations/org-alpha/policy", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ deviceLimit: 20, confirmation: "SET DESKTOP LIMIT 20" }),
  });
  assert.equal(updated.status, 200);
  assert.equal((await updated.json()).usage.overLimit, true);
  assert.deepEqual(calls.find(([kind]) => kind === "set-policy")[1], {
    organisationId: "org-alpha",
    deviceLimit: 20,
  });
  assert.equal(calls.filter(([kind]) => kind === "reverify").length, 1);
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
