import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";
import { Hono } from "hono";

import {
  createDesktopDeviceProofMiddleware,
  createDesktopDeviceProofVerifier,
  createDesktopOrganisationEnforcementMiddleware,
  EMPTY_BODY_DIGEST,
} from "../src/desktop-device-proof.js";
import { createSessionCsrfMiddleware } from "../src/session-security-middleware.js";

const DEVICE_ID = "11111111-1111-4111-8111-111111111111";
const API_ORIGIN = "https://api.claimguard.example";
const NOW_SECONDS = 1_785_542_400;

function pair() {
  const value = crypto.generateKeyPairSync("ed25519");
  return { privateKey: value.privateKey, publicJwk: value.publicKey.export({ format: "jwk" }) };
}

function bodyDigest(body = "") {
  return crypto.createHash("sha256").update(body).digest("base64url");
}

function proof(privateKey, {
  jti = crypto.randomUUID(),
  iat = NOW_SECONDS,
  path = "/desktop/sync/bootstrap",
  method = "GET",
  body = "",
  origin = API_ORIGIN,
  kid = DEVICE_ID,
  bodySha256 = bodyDigest(body),
} = {}) {
  const header = Buffer.from(JSON.stringify({ alg: "EdDSA", typ: "dpop+jwt", kid })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({
    deviceEnrollmentId: kid,
    htm: method,
    htu: `${origin}${path}`,
    body_sha256: bodySha256,
    iat,
    jti,
  })).toString("base64url");
  const signature = crypto.sign(null, Buffer.from(`${header}.${payload}`, "ascii"), privateKey).toString("base64url");
  return `${header}.${payload}.${signature}`;
}

function fixture({
  status = "active",
  expiresAt = "2026-08-06T00:00:00.000Z",
  organisationId = "org-alpha",
  known = true,
} = {}) {
  const deviceKey = pair();
  const consumed = new Set();
  const calls = { getDevice: 0, consumeNonce: 0, touch: 0 };
  const repository = {
    async getDeviceById(id) {
      calls.getDevice += 1;
      if (!known || id !== DEVICE_ID) return null;
      return {
        deviceEnrollmentId: DEVICE_ID,
        organisationId,
        permittedApiOrigin: API_ORIGIN,
        devicePublicKey: deviceKey.publicJwk,
        status,
        expiresAt,
        revokedAt: status === "revoked" ? "2026-08-01T00:00:00.000Z" : null,
      };
    },
    async consumeProofNonce({ nonceHash }) {
      calls.consumeNonce += 1;
      if (consumed.has(nonceHash)) return false;
      consumed.add(nonceHash);
      return true;
    },
    async touchDevice() { calls.touch += 1; },
  };
  return {
    calls,
    deviceKey,
    verifier: createDesktopDeviceProofVerifier({
      desktopEnrollmentRepository: repository,
      now: () => new Date(NOW_SECONDS * 1000),
    }),
  };
}

function boundaryApp({ verifier, authOrganisationId = "org-alpha", permissions = ["cases.read", "cases.action"] } = {}) {
  const calls = { detail: 0, action: 0, csrfEvents: 0 };
  const app = new Hono();
  app.use("*", async (c, next) => {
    const authenticated = c.req.header("cookie") === "cg_session_local=session-value";
    if (authenticated) {
      c.set("resolvedSession", {
        session: { organisationId: authOrganisationId, userId: "actor-1", credentialId: "credential-1" },
      });
      c.set("authContext", {
        is_authenticated: true,
        organisation_id: authOrganisationId,
        tenant_id: "tenant-a",
        user_id: "actor-1",
        permissions: new Set(permissions),
      });
    }
    await next();
  });
  app.use("*", createDesktopDeviceProofMiddleware({ verifier }));
  app.use("*", createSessionCsrfMiddleware({
    authenticationService: {
      verifyCsrf(_resolved, value) { return value === "valid-csrf"; },
      async recordSecurityEvent() { calls.csrfEvents += 1; },
    },
    configuration: { mode: "session", allowedOrigins: ["https://app.claimguard.example"] },
  }));
  app.use("*", createDesktopOrganisationEnforcementMiddleware());
  app.get("/public/health", (c) => c.json({ ok: true, desktop: Boolean(c.get("desktopDevice")) }));
  app.get("/api/v1/cases/by-legacy-investigation/:id", (c) => {
    const auth = c.get("authContext");
    if (!auth?.is_authenticated) return c.json({ code: "AUTHENTICATION_REQUIRED" }, 401);
    if (!auth.permissions.has("cases.read")) return c.json({ code: "CASE_ROLE_NOT_AUTHORISED" }, 403);
    calls.detail += 1;
    return c.json({
      available: true,
      case: { caseId: "case-1", currentState: "TRIAGE_PENDING", stateVersion: 2 },
      allowedActions: ["begin-triage"],
      correlationId: "request-1",
      verifiedDevice: c.get("desktopDevice")?.deviceEnrollmentId || null,
    });
  });
  app.post("/api/v1/cases/:caseId/actions/:action", async (c) => {
    const auth = c.get("authContext");
    if (!auth?.is_authenticated) return c.json({ code: "AUTHENTICATION_REQUIRED" }, 401);
    if (!auth.permissions.has("cases.action")) return c.json({ code: "CASE_ROLE_NOT_AUTHORISED" }, 403);
    calls.action += 1;
    return c.json({
      caseId: c.req.param("caseId"),
      action: c.req.param("action"),
      body: await c.req.json(),
      verifiedDevice: c.get("desktopDevice")?.deviceEnrollmentId || null,
    }, 201);
  });
  return { app, calls };
}

function nativeHeaders(token) {
  return { cookie: "cg_session_local=session-value", dpop: token };
}

test("valid device proof succeeds once and replay is rejected", async () => {
  const value = fixture();
  const token = proof(value.deviceKey.privateKey, { jti: "unique-device-proof-0001" });
  const request = new Request("https://internal/desktop/sync/bootstrap", { headers: { dpop: token } });
  const device = await value.verifier.verify(request);
  assert.equal(device.deviceEnrollmentId, DEVICE_ID);
  await assert.rejects(() => value.verifier.verify(request), (error) => error.code === "DEVICE_PROOF_REPLAYED");
});

test("valid native governed detail and action preserve session, proof binding and organisation context", async () => {
  const value = fixture();
  const boundary = boundaryApp({ verifier: value.verifier });
  const detailPath = "/api/v1/cases/by-legacy-investigation/investigation-1";
  const detailResponse = await boundary.app.request(detailPath, {
    headers: nativeHeaders(proof(value.deviceKey.privateKey, { path: detailPath, jti: "native-detail-proof-0001" })),
  });
  const detailBody = await detailResponse.json();
  assert.equal(detailResponse.status, 200);
  assert.equal(detailBody.verifiedDevice, DEVICE_ID);
  assert.equal(boundary.calls.detail, 1);

  const actionPath = "/api/v1/cases/case-1/actions/begin-triage";
  const body = JSON.stringify({ expectedStateVersion: 2, reasonCode: "REVIEWED", reasonSummary: "Reviewed." });
  const actionResponse = await boundary.app.request(actionPath, {
    method: "POST",
    headers: {
      ...nativeHeaders(proof(value.deviceKey.privateKey, {
        path: actionPath,
        method: "POST",
        body,
        jti: "native-action-proof-0001",
      })),
      "content-type": "application/json",
      "idempotency-key": "idem-1",
    },
    body,
  });
  const actionBody = await actionResponse.json();
  assert.equal(actionResponse.status, 201);
  assert.equal(actionBody.verifiedDevice, DEVICE_ID);
  assert.deepEqual(actionBody.body, JSON.parse(body));
  assert.equal(boundary.calls.action, 1);
  assert.equal(value.calls.consumeNonce, 2);
  assert.equal(value.calls.touch, 2);
});

test("ordinary browser governed requests remain DPoP-free and retain CSRF protection", async () => {
  const value = fixture();
  const boundary = boundaryApp({ verifier: value.verifier });
  const path = "/api/v1/cases/by-legacy-investigation/investigation-1";
  const detail = await boundary.app.request(path, { headers: { cookie: "cg_session_local=session-value" } });
  assert.equal(detail.status, 200);
  assert.equal((await detail.json()).verifiedDevice, null);

  const actionPath = "/api/v1/cases/case-1/actions/begin-triage";
  const rejected = await boundary.app.request(actionPath, {
    method: "POST",
    headers: { cookie: "cg_session_local=session-value", "content-type": "application/json" },
    body: JSON.stringify({ expectedStateVersion: 2 }),
  });
  assert.equal(rejected.status, 403);
  assert.equal((await rejected.json()).code, "CSRF_REJECTED");
  assert.equal(boundary.calls.action, 0);

  const accepted = await boundary.app.request(actionPath, {
    method: "POST",
    headers: {
      cookie: "cg_session_local=session-value",
      origin: "https://app.claimguard.example",
      "x-csrf-token": "valid-csrf",
      "content-type": "application/json",
    },
    body: JSON.stringify({ expectedStateVersion: 2 }),
  });
  assert.equal(accepted.status, 201);
  assert.equal((await accepted.json()).verifiedDevice, null);
  assert.equal(boundary.calls.action, 1);
  assert.equal(value.calls.getDevice, 0);
});

test("invalid native proof variants fail before CSRF exemption or governed service invocation", async () => {
  const variants = [
    ["malformed", () => "not-a-proof"],
    ["invalid signature", (value) => proof(pair().privateKey, { path: "/api/v1/cases/case-1/actions/begin-triage", method: "POST", body: "{}" })],
    ["wrong method", (value) => proof(value.deviceKey.privateKey, { path: "/api/v1/cases/case-1/actions/begin-triage", method: "GET", body: "{}" })],
    ["wrong path", (value) => proof(value.deviceKey.privateKey, { path: "/api/v1/cases/case-2/actions/begin-triage", method: "POST", body: "{}" })],
    ["wrong body", (value) => proof(value.deviceKey.privateKey, { path: "/api/v1/cases/case-1/actions/begin-triage", method: "POST", bodySha256: bodyDigest("different") })],
    ["expired proof", (value) => proof(value.deviceKey.privateKey, { path: "/api/v1/cases/case-1/actions/begin-triage", method: "POST", body: "{}", iat: NOW_SECONDS - 1000 })],
    ["wrong origin", (value) => proof(value.deviceKey.privateKey, { path: "/api/v1/cases/case-1/actions/begin-triage", method: "POST", body: "{}", origin: "https://other.example" })],
  ];
  for (const [name, token] of variants) {
    const value = fixture();
    const boundary = boundaryApp({ verifier: value.verifier });
    const response = await boundary.app.request("/api/v1/cases/case-1/actions/begin-triage", {
      method: "POST",
      headers: { cookie: "cg_session_local=session-value", dpop: token(value), "content-type": "application/json" },
      body: "{}",
    });
    assert.equal(response.status, 401, name);
    assert.equal(boundary.calls.action, 0, name);
    assert.equal(boundary.calls.csrfEvents, 0, name);
  }
});

test("unknown revoked and expired enrollments fail closed without governed invocation", async () => {
  for (const options of [
    { known: false },
    { status: "revoked" },
    { expiresAt: "2026-07-31T00:00:00.000Z" },
  ]) {
    const value = fixture(options);
    const boundary = boundaryApp({ verifier: value.verifier });
    const path = "/api/v1/cases/by-legacy-investigation/investigation-1";
    const response = await boundary.app.request(path, {
      headers: nativeHeaders(proof(value.deviceKey.privateKey, { path })),
    });
    assert.equal(response.status, 401);
    assert.equal(boundary.calls.detail, 0);
  }
});

test("replayed proof, organisation mismatch, missing session and missing permission do not gain authority", async () => {
  const value = fixture();
  const path = "/api/v1/cases/by-legacy-investigation/investigation-1";
  const token = proof(value.deviceKey.privateKey, { path, jti: "replay-governed-proof-0001" });
  const boundary = boundaryApp({ verifier: value.verifier });
  assert.equal((await boundary.app.request(path, { headers: nativeHeaders(token) })).status, 200);
  assert.equal((await boundary.app.request(path, { headers: nativeHeaders(token) })).status, 401);
  assert.equal(boundary.calls.detail, 1);

  const mismatchValue = fixture();
  const mismatch = boundaryApp({ verifier: mismatchValue.verifier, authOrganisationId: "org-other" });
  const mismatchResponse = await mismatch.app.request(path, {
    headers: nativeHeaders(proof(mismatchValue.deviceKey.privateKey, { path })),
  });
  assert.equal(mismatchResponse.status, 403);
  assert.equal(mismatch.calls.detail, 0);

  const noSessionValue = fixture();
  const noSession = boundaryApp({ verifier: noSessionValue.verifier });
  const noSessionResponse = await noSession.app.request(path, {
    headers: { dpop: proof(noSessionValue.deviceKey.privateKey, { path }) },
  });
  assert.equal(noSessionResponse.status, 401);
  assert.equal(noSession.calls.detail, 0);

  const noPermissionValue = fixture();
  const noPermission = boundaryApp({ verifier: noPermissionValue.verifier, permissions: [] });
  const noPermissionResponse = await noPermission.app.request(path, {
    headers: nativeHeaders(proof(noPermissionValue.deviceKey.privateKey, { path })),
  });
  assert.equal(noPermissionResponse.status, 403);
  assert.equal(noPermission.calls.detail, 0);
});

test("adding no DPoP header leaves public route behavior unchanged", async () => {
  const value = fixture();
  const boundary = boundaryApp({ verifier: value.verifier });
  const response = await boundary.app.request("/public/health");
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, desktop: false });
  assert.equal(value.calls.getDevice, 0);
});

test("a copied enrollment cannot authenticate with a different private key", async () => {
  const value = fixture();
  const attacker = pair();
  const request = new Request("https://internal/desktop/sync/bootstrap", {
    headers: { dpop: proof(attacker.privateKey) },
  });
  await assert.rejects(() => value.verifier.verify(request), (error) => error.code === "DEVICE_PROOF_REJECTED");
});

test("empty body digest remains canonical", () => {
  assert.equal(EMPTY_BODY_DIGEST, bodyDigest(""));
});
