import assert from "node:assert/strict";
import test from "node:test";

import { createDesktopEnrollmentRepository } from "../src/index.js";

const timestamp = new Date("2026-08-08T10:00:00.000Z");
const expiresAt = new Date("2026-08-08T10:10:00.000Z");
const digest = "a".repeat(64);

function executorFixture() {
  const calls = [];
  const row = {
    request_id: "request-1",
    device_enrollment_id: "device-1",
    organisation_id: "org-1",
    status: "approved",
    approved_user_id: "user-1",
    approved_membership_id: "membership-1",
    approved_credential_id: "credential-1",
    expires_at: expiresAt,
    approved_at: timestamp,
    exchange_started_at: null,
    consumed_at: null,
    created_at: timestamp,
  };
  return {
    calls,
    executor: {
      async execute(sql, parameters) {
        calls.push({ sql, parameters });
        if (sql.includes("SELECT * FROM desktop_authentication_requests")) return [[row]];
        return [{ affectedRows: 1 }];
      },
    },
  };
}

test("desktop authentication requests store hashes and transition append-only exchange state", async () => {
  const { executor, calls } = executorFixture();
  const repository = createDesktopEnrollmentRepository(executor);

  assert.deepEqual(await repository.createAuthenticationRequest({
    requestId: "request-1",
    deviceEnrollmentId: "device-1",
    organisationId: "org-1",
    browserSecretHash: digest,
    pollingSecretHash: digest,
    expiresAt,
  }), { requestId: "request-1", expiresAt });

  const browserRequest = await repository.getAuthenticationRequestByBrowserHash(digest, { forUpdate: true });
  const pollingRequest = await repository.getAuthenticationRequestByPollingHash(digest, { forUpdate: true });
  assert.equal(browserRequest.approvedUserId, "user-1");
  assert.equal(pollingRequest.approvedCredentialId, "credential-1");

  assert.equal(await repository.rotateAuthenticationBrowserSecret({
    requestId: "request-1",
    currentSecretHash: digest,
    replacementSecretHash: "b".repeat(64),
    claimedAt: timestamp,
  }), true);

  assert.equal(await repository.approveAuthenticationRequest({
    requestId: "request-1",
    organisationId: "org-1",
    userId: "user-1",
    membershipId: "membership-1",
    credentialId: "credential-1",
    approvedAt: timestamp,
  }), true);
  assert.equal(await repository.beginAuthenticationExchange("request-1", timestamp), true);
  assert.equal(await repository.completeAuthenticationExchange("request-1", timestamp), true);
  assert.equal(await repository.completeAuthenticationExchange("request-1", timestamp, { failed: true }), true);

  assert.equal(calls[0].sql.includes("SET status = 'expired'"), true);
  assert.equal(calls[1].parameters.includes(digest), true);
  assert.equal(calls.some(({ sql }) => sql.includes("SET status = 'exchanging'")), true);
  assert.equal(calls.some(({ sql }) => sql.includes("SET browser_secret_hash = ?")), true);
  assert.equal(calls.some(({ parameters }) => parameters?.[0] === "failed"), true);
});

test("desktop authentication request digests are validated before SQL", async () => {
  const { executor } = executorFixture();
  const repository = createDesktopEnrollmentRepository(executor);

  await assert.rejects(
    repository.getAuthenticationRequestByBrowserHash("raw-secret"),
    /lowercase SHA-256 digest/,
  );
});
