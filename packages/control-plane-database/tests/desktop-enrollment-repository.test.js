import assert from "node:assert/strict";
import test from "node:test";

import { createDesktopEnrollmentRepository } from "../src/desktop-enrollment-repository.js";

const DIGEST = "a".repeat(64);
const NOW = new Date("2026-08-01T00:00:00.000Z");

function queuedExecutor(responses) {
  const queries = [];
  return {
    queries,
    async execute(sql, params) {
      queries.push({ sql, params });
      assert.ok(responses.length > 0, `Unexpected query: ${sql}`);
      const response = responses.shift();
      if (response instanceof Error) throw response;
      return response;
    },
  };
}

function activationKeyRow(overrides = {}) {
  return {
    activation_key_id: "key-1",
    organisation_id: "org-1",
    display_name: "ClaimGuard Health",
    canonical_slug: "claimguard-health",
    organisation_status: "active",
    activation_state: "activated",
    organisation_type: "medical_scheme",
    activation_key_hash: DIGEST,
    status: "pending",
    maximum_uses: "1",
    use_count: "0",
    issued_by: "actor-1",
    issued_at: NOW,
    expires_at: new Date("2026-08-02T00:00:00.000Z"),
    used_at: null,
    revoked_at: null,
    revoked_by: null,
    revocation_reason: null,
    device_limit: "4",
    offline_grace_days: "6",
    ...overrides,
  };
}

function deviceRow(overrides = {}) {
  return {
    device_enrollment_id: "device-1",
    organisation_id: "org-1",
    display_name: "ClaimGuard Health",
    canonical_slug: "claimguard-health",
    installation_id: "installation-1",
    device_public_key: Buffer.from('{"kty":"OKP","crv":"Ed25519"}'),
    public_key_thumbprint: DIGEST,
    status: "active",
    document_version: "1",
    signing_key_id: "signer-1",
    permitted_api_origin: "https://api.claimguard.example",
    environment: "production",
    activated_at: NOW,
    last_seen_at: NOW,
    expires_at: new Date("2027-08-01T00:00:00.000Z"),
    offline_grace_expires_at: new Date("2026-08-07T00:00:00.000Z"),
    revoked_at: null,
    revoked_by: null,
    revocation_reason: null,
    ...overrides,
  };
}

test("desktop enrollment reads map database rows and redact persisted credentials from lists", async () => {
  const executor = queuedExecutor([
    [[{ organisation_id: "org-1", device_limit: "4", activation_key_lifetime_hours: "12", offline_grace_days: "6" }]],
    [[]],
    [[activationKeyRow()]],
    [[activationKeyRow()]],
    [[activationKeyRow()]],
    [[deviceRow()]],
    [[deviceRow()]],
    [[{
      desktop_audit_event_id: "audit-1",
      organisation_id: "org-1",
      activation_key_id: "key-1",
      device_enrollment_id: "device-1",
      actor_type: "user",
      actor_id: "actor-1",
      action: "device.activated",
      outcome: "success",
      failure_category: null,
      correlation_id: "correlation-1",
      occurred_at: NOW,
    }]],
  ]);
  const repository = createDesktopEnrollmentRepository(executor);

  assert.deepEqual(await repository.getPolicy("org-1"), {
    organisationId: "org-1",
    deviceLimit: 4,
    activationKeyLifetimeHours: 12,
    offlineGraceDays: 6,
  });
  assert.deepEqual(await repository.getPolicy("org-default"), {
    organisationId: "org-default",
    deviceLimit: 5,
    activationKeyLifetimeHours: 24,
    offlineGraceDays: 7,
  });

  const key = await repository.getActivationKeyByHash(DIGEST, { forUpdate: true });
  assert.equal(key.organisationDisplayName, "ClaimGuard Health");
  assert.equal(key.maximumUses, 1);
  assert.match(executor.queries[2].sql, /FOR UPDATE$/);
  assert.equal((await repository.getActivationKeyById("key-1")).activationKeyId, "key-1");
  const listedKeys = await repository.listActivationKeys("org-1");
  assert.equal(Object.hasOwn(listedKeys[0], "activationKeyHash"), false);

  const device = await repository.getDeviceById("device-1");
  assert.deepEqual(device.devicePublicKey, { kty: "OKP", crv: "Ed25519" });
  assert.equal(device.documentVersion, 1);
  const listedDevices = await repository.listDevices("org-1");
  assert.equal(Object.hasOwn(listedDevices[0], "devicePublicKey"), false);
  assert.equal(Object.hasOwn(listedDevices[0], "publicKeyThumbprint"), false);

  const audit = await repository.listAudit("org-1", { limit: 1000 });
  assert.equal(audit[0].desktopAuditEventId, "audit-1");
  assert.match(executor.queries.at(-1).sql, /LIMIT 500/);
});

test("desktop enrollment writes remain tenant-scoped and report optimistic outcomes", async () => {
  const executor = queuedExecutor([
    [[]],
    [[{ organisation_id: "org-1", device_limit: 3, activation_key_lifetime_hours: 10, offline_grace_days: 5 }]],
    [{ affectedRows: 1 }],
    [{ affectedRows: 1 }],
    [{ affectedRows: 0 }],
    [[{ total: "2" }]],
    [[{ organisation_id: "org-1" }]],
    [[]],
    [[deviceRow()]],
    [{ affectedRows: 1 }],
    [[]],
    [{ affectedRows: 0 }],
    [[]],
    [[{ failure_count: 2 }]],
    [[]],
    [[]],
    [[]],
  ]);
  const repository = createDesktopEnrollmentRepository(executor);

  assert.equal((await repository.setPolicy({
    organisationId: "org-1",
    deviceLimit: 3,
    activationKeyLifetimeHours: 10,
    offlineGraceDays: 5,
  })).deviceLimit, 3);
  assert.deepEqual(await repository.createActivationKey({
    activationKeyId: "key-1",
    organisationId: "org-1",
    activationKeyHash: DIGEST,
    maximumUses: 1,
    issuedBy: "actor-1",
    issuedAt: NOW,
    expiresAt: new Date("2026-08-02T00:00:00.000Z"),
  }), { activationKeyId: "key-1" });
  assert.equal(await repository.consumeActivationKey("key-1", NOW), true);
  assert.equal(await repository.revokeActivationKey({
    activationKeyId: "key-1", organisationId: "org-1", revokedBy: "actor-1", revokedAt: NOW,
  }), false);
  assert.equal(await repository.countActiveDevices("org-1", NOW), 2);
  assert.equal(await repository.lockOrganisationForDesktopEnrollment("org-1"), true);

  assert.deepEqual(await repository.createDevice({
    deviceEnrollmentId: "device-1",
    organisationId: "org-1",
    activationKeyId: "key-1",
    installationId: "installation-1",
    devicePublicKey: { kty: "OKP", crv: "Ed25519" },
    publicKeyThumbprint: DIGEST,
    documentVersion: 1,
    signingKeyId: "signer-1",
    permittedApiOrigin: "https://api.claimguard.example",
    environment: "production",
    activatedAt: NOW,
    expiresAt: new Date("2027-08-01T00:00:00.000Z"),
    offlineGraceExpiresAt: new Date("2026-08-07T00:00:00.000Z"),
  }), { deviceEnrollmentId: "device-1" });
  assert.equal((await repository.getDeviceById("device-1", { forUpdate: true })).deviceEnrollmentId, "device-1");
  assert.equal(await repository.revokeDevice({
    deviceEnrollmentId: "device-1", organisationId: "org-1", revokedBy: "actor-1", revokedAt: NOW,
  }), true);
  await repository.touchDevice("device-1", NOW);
  assert.equal(await repository.renewDeviceGrace({
    deviceEnrollmentId: "device-1", seenAt: NOW, offlineGraceExpiresAt: new Date("2026-08-07T00:00:00.000Z"),
  }), false);
  assert.equal(await repository.consumeProofNonce({
    nonceHash: DIGEST, deviceEnrollmentId: "device-1", issuedAt: NOW, expiresAt: new Date("2026-08-01T00:05:00.000Z"),
  }), true);
  assert.equal((await repository.getActivationRateLimit(DIGEST)).failure_count, 2);
  await repository.recordActivationFailure({
    bucketKey: DIGEST, sourceNetworkHash: DIGEST, now: NOW,
    blockedUntil: new Date("2026-08-01T00:10:00.000Z"), windowCutoff: new Date("2026-07-31T23:55:00.000Z"),
  });
  await repository.clearActivationRateLimit(DIGEST);
  assert.deepEqual(await repository.recordAudit({
    desktopAuditEventId: "audit-1", organisationId: "org-1", actorType: "user",
    action: "device.activated", outcome: "success", occurredAt: NOW,
  }), { desktopAuditEventId: "audit-1" });
});

test("desktop enrollment persistence rejects raw secrets, malformed digests, and replayed nonces", async () => {
  const duplicate = new Error("duplicate nonce");
  duplicate.code = "ER_DUP_ENTRY";
  const executor = queuedExecutor([duplicate, [[deviceRow({ device_public_key: "not-json" })]]]);
  const repository = createDesktopEnrollmentRepository(executor);

  await assert.rejects(
    repository.createActivationKey({ activationKey: "raw-secret" }),
    /Raw organisation activation keys are not accepted/,
  );
  await assert.rejects(repository.getActivationKeyByHash("invalid"), /lowercase SHA-256 digest/);
  assert.equal(await repository.consumeProofNonce({
    nonceHash: DIGEST, deviceEnrollmentId: "device-1", issuedAt: NOW, expiresAt: NOW,
  }), false);
  assert.equal((await repository.getDeviceById("device-1")).devicePublicKey, null);
});
