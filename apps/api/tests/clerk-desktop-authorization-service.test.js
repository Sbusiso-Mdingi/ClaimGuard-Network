import assert from "node:assert/strict";
import test from "node:test";

import { sha256 } from "@claimguard/control-plane-database";

import { createClerkDesktopAuthorizationService } from "../src/services/clerk-desktop-authorization-service.js";

const device = Object.freeze({ deviceEnrollmentId: "device-1", organisationId: "org-1" });
const actor = Object.freeze({
  user: { userId: "user-1" },
  membership: { membershipId: "membership-1" },
  credential: { credentialId: "credential-1" },
  organisation: { organisationId: "org-1", organisationType: "medical_scheme", displayName: "Alpha Health" },
  roles: ["fraud_analyst"],
});

function serviceHarness(overrides = {}) {
  const calls = { created: [], audits: [], completed: [], sessions: [] };
  const desktopEnrollment = {
    async createAuthenticationRequest(input) {
      calls.created.push(input);
      return { requestId: "request-1" };
    },
    async recordAudit(input) { calls.audits.push(input); },
    ...overrides.desktopEnrollment,
  };
  const repositories = {
    desktopEnrollment,
    async runInTransaction(callback) { return callback({ desktopEnrollment }); },
  };
  const authenticationService = {
    async createExternalSession(input, metadata) {
      calls.sessions.push({ input, metadata });
      return { sessionSecret: "opaque-session" };
    },
    ...overrides.authenticationService,
  };
  const service = createClerkDesktopAuthorizationService({
    controlPlaneRepositories: repositories,
    authenticationService,
    webOrigin: "https://work.sequrin.example/path",
    now: () => new Date("2026-08-08T10:00:00.000Z"),
    randomBytes: (() => {
      const values = [Buffer.alloc(32, 1), Buffer.alloc(32, 2)];
      return () => values.shift();
    })(),
  });
  return { service, calls, desktopEnrollment };
}

test("desktop start returns two independent secrets and persists only their hashes", async () => {
  const { service, calls } = serviceHarness();

  const result = await service.start(device, { correlationId: "request-correlation" });
  const browserSecret = new URL(result.verificationUrl).searchParams.get("request");

  assert.notEqual(browserSecret, result.pollingSecret);
  assert.equal(calls.created[0].browserSecretHash, sha256(browserSecret));
  assert.equal(calls.created[0].pollingSecretHash, sha256(result.pollingSecret));
  assert.equal(JSON.stringify(calls.created[0]).includes(browserSecret), false);
  assert.equal(JSON.stringify(calls.created[0]).includes(result.pollingSecret), false);
  assert.equal(result.verificationUrl.startsWith("https://work.sequrin.example/desktop/authorize?"), true);
});

test("desktop approval rejects platform and cross-organisation identities", async () => {
  const { service } = serviceHarness({
    desktopEnrollment: {
      async getAuthenticationRequestByBrowserHash() {
        return { requestId: "request-1", organisationId: "org-1", expiresAt: "2026-08-08T10:10:00.000Z", status: "pending" };
      },
    },
  });

  await assert.rejects(
    service.approve("browser-secret", { actor: { ...actor, organisation: { ...actor.organisation, organisationId: "org-2" } } }),
    (error) => error.code === "DESKTOP_AUTHORIZATION_ORGANISATION_MISMATCH",
  );
  await assert.rejects(
    service.approve("browser-secret", { actor: { ...actor, roles: ["platform_administrator"] } }),
    (error) => error.code === "PLATFORM_DESKTOP_AUTHENTICATION_REJECTED",
  );
});

test("desktop poll is device-bound and exchanges an approval only once", async () => {
  let status = "approved";
  const request = {
    requestId: "request-1",
    deviceEnrollmentId: "device-1",
    organisationId: "org-1",
    approvedUserId: "user-1",
    approvedCredentialId: "credential-1",
    expiresAt: "2026-08-08T10:10:00.000Z",
  };
  const { service, calls } = serviceHarness({
    desktopEnrollment: {
      async getAuthenticationRequestByPollingHash() { return { ...request, status }; },
      async beginAuthenticationExchange() {
        if (status !== "approved") return false;
        status = "exchanging";
        return true;
      },
      async completeAuthenticationExchange(id, at, options) {
        calls.completed.push({ id, at, options });
        status = options?.failed ? "failed" : "consumed";
      },
    },
  });

  await assert.rejects(
    service.poll("poll-secret", { ...device, deviceEnrollmentId: "other-device" }),
    (error) => error.code === "DESKTOP_AUTHORIZATION_NOT_FOUND",
  );
  const exchanged = await service.poll("poll-secret", device, { correlationId: "correlation-1" });
  assert.equal(exchanged.pending, false);
  assert.deepEqual(calls.sessions[0].input, {
    organisationId: "org-1",
    userId: "user-1",
    credentialId: "credential-1",
  });
  assert.equal(calls.completed.length, 1);
  await assert.rejects(
    service.poll("poll-secret", device),
    (error) => error.code === "DESKTOP_AUTHORIZATION_UNAVAILABLE",
  );
});

test("desktop poll reports pending without issuing a session", async () => {
  const { service, calls } = serviceHarness({
    desktopEnrollment: {
      async getAuthenticationRequestByPollingHash() {
        return {
          requestId: "request-1",
          deviceEnrollmentId: "device-1",
          organisationId: "org-1",
          expiresAt: "2026-08-08T10:10:00.000Z",
          status: "pending",
        };
      },
    },
  });

  assert.deepEqual(await service.poll("poll-secret", device), {
    pending: true,
    expiresAt: "2026-08-08T10:10:00.000Z",
  });
  assert.equal(calls.sessions.length, 0);
});
