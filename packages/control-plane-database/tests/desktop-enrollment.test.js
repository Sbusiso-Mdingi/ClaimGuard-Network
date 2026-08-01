import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";

import {
  createActivationKeyHasher,
  createDesktopEnrollmentService,
  createEnrollmentDocumentSigner,
} from "../src/index.js";

const ORG_ALPHA = "11111111-1111-4111-8111-111111111111";
const ORG_BETA = "22222222-2222-4222-8222-222222222222";
const ACTOR = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

function keyPair() {
  const pair = crypto.generateKeyPairSync("ed25519");
  return { privateKey: pair.privateKey, publicJwk: pair.publicKey.export({ format: "jwk" }) };
}

function createMemoryRepositories() {
  const organisations = new Map([
    [ORG_ALPHA, { displayName: "Alpha Medical", slug: "alpha", type: "medical_scheme" }],
    [ORG_BETA, { displayName: "Beta Medical", slug: "beta", type: "medical_scheme" }],
  ]);
  const policies = new Map();
  const keys = new Map();
  const devices = new Map();
  const rateLimits = new Map();
  const nonces = new Set();
  const audits = [];
  const repository = {
    async getPolicy(organisationId) {
      return { organisationId, deviceLimit: 5, activationKeyLifetimeHours: 24, offlineGraceDays: 7, ...policies.get(organisationId) };
    },
    async setPolicy(policy) { policies.set(policy.organisationId, policy); return this.getPolicy(policy.organisationId); },
    async createActivationKey(input) {
      assert.equal(Object.hasOwn(input, "activationKey"), false);
      const activationKeyId = crypto.randomUUID();
      keys.set(activationKeyId, { activationKeyId, status: "pending", useCount: 0, ...input });
      return { activationKeyId };
    },
    async getActivationKeyByHash(hash) {
      const entry = [...keys.values()].find((key) => key.activationKeyHash === hash);
      if (!entry) return null;
      const organisation = organisations.get(entry.organisationId);
      const policy = await this.getPolicy(entry.organisationId);
      return {
        ...entry,
        organisationDisplayName: organisation.displayName,
        organisationSlug: organisation.slug,
        organisationType: organisation.type,
        organisationStatus: "active",
        organisationActivationState: "activated",
        deviceLimit: policy.deviceLimit,
        offlineGraceDays: policy.offlineGraceDays,
      };
    },
    async listActivationKeys(organisationId) {
      return [...keys.values()].filter((key) => key.organisationId === organisationId)
        .map(({ activationKeyHash: _hash, ...key }) => key);
    },
    async consumeActivationKey(id, usedAt) {
      const key = keys.get(id);
      if (!key || key.status !== "pending" || key.expiresAt <= usedAt) return false;
      key.useCount += 1;
      key.usedAt = usedAt;
      if (key.useCount >= key.maximumUses) key.status = "used";
      return true;
    },
    async revokeActivationKey({ activationKeyId, organisationId, revokedAt }) {
      const key = keys.get(activationKeyId);
      if (!key || key.organisationId !== organisationId || key.status !== "pending") return false;
      Object.assign(key, { status: "revoked", revokedAt });
      return true;
    },
    async countActiveDevices(organisationId, at) {
      return [...devices.values()].filter((device) => device.organisationId === organisationId && device.status === "active" && device.expiresAt > at).length;
    },
    async lockOrganisationForDesktopEnrollment(organisationId) { return organisations.has(organisationId); },
    async createDevice(input) {
      const deviceEnrollmentId = crypto.randomUUID();
      devices.set(deviceEnrollmentId, { deviceEnrollmentId, status: "active", ...input });
      return { deviceEnrollmentId };
    },
    async getDeviceById(id) {
      const device = devices.get(id);
      if (!device) return null;
      const organisation = organisations.get(device.organisationId);
      return { ...device, organisationDisplayName: organisation.displayName, organisationSlug: organisation.slug };
    },
    async listDevices(organisationId) { return [...devices.values()].filter((device) => device.organisationId === organisationId); },
    async revokeDevice({ deviceEnrollmentId, organisationId, revokedAt }) {
      const device = devices.get(deviceEnrollmentId);
      if (!device || device.organisationId !== organisationId || device.status !== "active") return false;
      Object.assign(device, { status: "revoked", revokedAt });
      return true;
    },
    async touchDevice() {},
    async renewDeviceGrace({ deviceEnrollmentId, seenAt, offlineGraceExpiresAt }) {
      const device = devices.get(deviceEnrollmentId);
      if (!device || device.status !== "active" || device.revokedAt || device.expiresAt <= seenAt) return false;
      Object.assign(device, { lastSeenAt: seenAt, offlineGraceExpiresAt });
      return true;
    },
    async consumeProofNonce({ nonceHash }) { if (nonces.has(nonceHash)) return false; nonces.add(nonceHash); return true; },
    async getActivationRateLimit(bucketKey) { return rateLimits.get(bucketKey) || null; },
    async recordActivationFailure({ bucketKey, now, blockedUntil }) {
      const previous = rateLimits.get(bucketKey);
      rateLimits.set(bucketKey, {
        failure_count: Number(previous?.failure_count || 0) + 1,
        window_started_at: previous?.window_started_at || now,
        blocked_until: blockedUntil,
      });
    },
    async clearActivationRateLimit(bucketKey) { rateLimits.delete(bucketKey); },
    async recordAudit(input) { audits.push(input); return { desktopAuditEventId: crypto.randomUUID() }; },
    async listAudit(organisationId) { return audits.filter((event) => event.organisationId === organisationId); },
  };
  const repositories = {
    desktopEnrollment: repository,
    async runInTransaction(operation) { return operation(repositories); },
  };
  return { repositories, policies, keys, devices, audits };
}

function createFixture({ clock = new Date("2026-08-01T00:00:00.000Z") } = {}) {
  let current = clock;
  const memory = createMemoryRepositories();
  const signingPair = keyPair();
  const service = createDesktopEnrollmentService({
    repositories: memory.repositories,
    activationKeyHasher: createActivationKeyHasher({ pepper: "test-pepper-that-is-at-least-thirty-two-bytes-long" }),
    enrollmentSigner: createEnrollmentDocumentSigner({ privateKey: signingPair.privateKey, keyId: "enrollment-test-1" }),
    apiOrigin: "https://api.claimguard.example",
    environment: "test",
    now: () => new Date(current),
  });
  return {
    ...memory,
    service,
    setNow(value) { current = new Date(value); },
  };
}

test("activation keys resolve to exactly one organisation and raw values are never persisted", async () => {
  const fixture = createFixture();
  const issued = await fixture.service.issueActivationKey({ organisationId: ORG_ALPHA }, { id: ACTOR });
  const stored = [...fixture.keys.values()][0];
  assert.equal(stored.organisationId, ORG_ALPHA);
  assert.match(stored.activationKeyHash, /^[a-f0-9]{64}$/);
  assert.notEqual(stored.activationKeyHash, issued.activationKey);
  assert.equal(JSON.stringify(stored).includes(issued.activationKey), false);

  const deviceKey = keyPair();
  const activated = await fixture.service.activate({
    activationKey: issued.activationKey,
    installationId: "33333333-3333-4333-8333-333333333333",
    devicePublicKey: deviceKey.publicJwk,
  }, { sourceNetworkHash: "1".repeat(64) });
  assert.equal(activated.document.organisationId, ORG_ALPHA);
  assert.equal(activated.document.organisationDisplayName, "Alpha Medical");
  assert.equal(activated.document.permittedApiOrigin, "https://api.claimguard.example");
  assert.equal(activated.signedEnrollment.split(".").length, 3);
});

test("online authentication can renew an expired offline grace without changing organisation ownership", async () => {
  const fixture = createFixture();
  const issued = await fixture.service.issueActivationKey({ organisationId: ORG_ALPHA }, { id: ACTOR });
  const activated = await fixture.service.activate({
    activationKey: issued.activationKey,
    installationId: "34333333-3333-4333-8333-333333333333",
    devicePublicKey: keyPair().publicJwk,
  }, { sourceNetworkHash: "9".repeat(64) });
  const originalGrace = new Date(activated.document.offlineGraceExpiresAt);
  fixture.setNow("2026-08-09T00:00:00.000Z");
  const device = await fixture.repositories.desktopEnrollment.getDeviceById(activated.device.deviceEnrollmentId);
  const renewed = await fixture.service.renewEnrollment(device);
  assert.equal(renewed.document.organisationId, ORG_ALPHA);
  assert.equal(renewed.document.deviceEnrollmentId, activated.device.deviceEnrollmentId);
  assert.ok(new Date(renewed.document.offlineGraceExpiresAt) > originalGrace);
  assert.equal(
    new Date(fixture.devices.get(activated.device.deviceEnrollmentId).offlineGraceExpiresAt).toISOString(),
    renewed.document.offlineGraceExpiresAt,
  );
});

test("activation keys are single-use and expire", async () => {
  const fixture = createFixture();
  const issued = await fixture.service.issueActivationKey({ organisationId: ORG_ALPHA, expiresInHours: 1 }, { id: ACTOR });
  await fixture.service.activate({
    activationKey: issued.activationKey,
    installationId: "44444444-4444-4444-8444-444444444444",
    devicePublicKey: keyPair().publicJwk,
  }, { sourceNetworkHash: "2".repeat(64) });
  fixture.setNow("2026-08-01T00:00:01.000Z");
  await assert.rejects(() => fixture.service.activate({
    activationKey: issued.activationKey,
    installationId: "55555555-5555-4555-8555-555555555555",
    devicePublicKey: keyPair().publicJwk,
  }, { sourceNetworkHash: "3".repeat(64) }), (error) => error.code === "ACTIVATION_REJECTED");

  const expiring = await fixture.service.issueActivationKey({ organisationId: ORG_BETA, expiresInHours: 1 }, { id: ACTOR });
  fixture.setNow("2026-08-01T02:00:00.000Z");
  await assert.rejects(() => fixture.service.activate({
    activationKey: expiring.activationKey,
    installationId: "66666666-6666-4666-8666-666666666666",
    devicePublicKey: keyPair().publicJwk,
  }, { sourceNetworkHash: "4".repeat(64) }), (error) => error.code === "ACTIVATION_REJECTED");
});

test("organisation device limits are enforced", async () => {
  const fixture = createFixture();
  fixture.policies.set(ORG_ALPHA, { deviceLimit: 1, activationKeyLifetimeHours: 24, offlineGraceDays: 7 });
  const first = await fixture.service.issueActivationKey({ organisationId: ORG_ALPHA }, { id: ACTOR });
  await fixture.service.activate({
    activationKey: first.activationKey,
    installationId: "77777777-7777-4777-8777-777777777777",
    devicePublicKey: keyPair().publicJwk,
  }, { sourceNetworkHash: "5".repeat(64) });
  const second = await fixture.service.issueActivationKey({ organisationId: ORG_ALPHA }, { id: ACTOR });
  await assert.rejects(() => fixture.service.activate({
    activationKey: second.activationKey,
    installationId: "88888888-8888-4888-8888-888888888888",
    devicePublicKey: keyPair().publicJwk,
  }, { sourceNetworkHash: "6".repeat(64) }), (error) => error.code === "DEVICE_LIMIT_REACHED");
});

test("activation brute forcing is throttled without logging raw candidates", async () => {
  const fixture = createFixture();
  await assert.rejects(() => fixture.service.activate({
    activationKey: "not-an-activation-key",
    installationId: "99999999-9999-4999-8999-999999999999",
    devicePublicKey: keyPair().publicJwk,
  }, { sourceNetworkHash: "7".repeat(64) }), (error) => error.code === "ACTIVATION_REJECTED");
  await assert.rejects(() => fixture.service.activate({
    activationKey: "another-invalid-key",
    installationId: "99999999-9999-4999-8999-999999999999",
    devicePublicKey: keyPair().publicJwk,
  }, { sourceNetworkHash: "7".repeat(64) }), (error) => error.code === "ACTIVATION_RATE_LIMITED");
  assert.equal(JSON.stringify(fixture.audits).includes("not-an-activation-key"), false);
});
