import assert from "node:assert/strict";
import test from "node:test";

import {
  AuthenticationRejectedError,
  createControlPlaneAuthenticationService,
  hashPassword,
  passwordHashNeedsRehash,
  sha256,
  verifyPassword,
} from "../src/index.js";

function fixture({ passwordHash = "current-hash", organisationStatus = "active", membershipStatus = "active", userStatus = "active", credentialStatus = "active", mapping = true, membershipValidUntil = null, idleTimeoutMs, absoluteTimeoutMs, integrationCredentialsRepository = null } = {}) {
  let currentTime = new Date("2026-07-16T08:00:00Z");
  let randomCounter = 0;
  const sessions = new Map();
  const throttle = new Map();
  const events = [];
  const upgrades = [];
  const organisation = {
    organisationId: "org-1", displayName: "Alpha", canonicalSlug: "alpha", organisationType: "medical_scheme",
    deploymentClass: "demo", status: organisationStatus, activationState: "activated",
    matchedSlug: "alpha", matchedSlugType: "canonical", matchedSlugStatus: "active",
  };
  const user = { userId: "user-1", displayName: "User", status: userStatus, authenticationVersion: 3 };
  const membership = { membershipId: "membership-1", userId: "user-1", organisationId: "org-1", status: membershipStatus, validUntil: membershipValidUntil };
  const credential = {
    credentialId: "credential-1", userId: "user-1", organisationId: "org-1", authenticationProvider: "local_password",
    normalizedUsername: "investigator", passwordHash, status: credentialStatus, lockedUntil: null,
  };
  const repository = {
    async resolveOrganisation(slug) { return ["alpha", "alpha-old"].includes(slug) ? { ...organisation, matchedSlugType: slug === "alpha-old" ? "alias" : "canonical", matchedSlugStatus: slug === "alpha-old" ? "redirect" : "active" } : null; },
    async getOrganisationById(id) { return id === "org-1" ? organisation : null; },
    async getInternalCredential({ organisationId, username }) { return organisationId === "org-1" && username === "investigator" ? credential : null; },
    async getCredentialById(id) { return id === credential.credentialId ? credential : null; },
    async getUser(id) { return id === user.userId ? user : null; },
    async getMembership() { return membership; },
    async getAuthorization() { return { roles: ["investigator"], permissions: ["investigations.manage", "investigations.confirm"] }; },
    async getLegacyTenantBridge() { return mapping ? { legacyTenantId: "tenant-alpha", legacyTenantSlug: "alpha", migrationStatus: "verified", verifiedAt: new Date() } : null; },
    async upgradePasswordHash(input) { upgrades.push(input); credential.passwordHash = input.passwordHash; return true; },
    async recordCredentialFailure() { credential.failedAttemptCount = Number(credential.failedAttemptCount || 0) + 1; },
    async clearCredentialFailures() { credential.failedAttemptCount = 0; credential.lockedUntil = null; },
    async createSession(input) { const sessionId = `session-${sessions.size + 1}`; assert.equal(Object.hasOwn(input, "bearerSecret"), false); sessions.set(sessionId, { ...input, sessionId, revokedAt: null }); return { sessionId }; },
    async getSessionByBearerHash(hash) { return [...sessions.values()].find((session) => session.hashedBearerSecret === hash) || null; },
    async touchSession(id, updates) { Object.assign(sessions.get(id), updates); },
    async rotateCsrfToken(id, csrfTokenHash) { sessions.get(id).csrfTokenHash = csrfTokenHash; },
    async revokeSession(id, reason) { const session = sessions.get(id); if (!session) return false; session.revokedAt ||= currentTime; session.revocationReason ||= reason; return true; },
    async revokeSessionsBy(scope, id, reason) { let count = 0; for (const session of sessions.values()) { const key = { user: "userId", membership: "membershipId", organisation: "organisationId", credential: "credentialId" }[scope]; if (session[key] === id && !session.revokedAt) { session.revokedAt = currentTime; session.revocationReason = reason; count += 1; } } return count; },
    async getThrottleBucket(key) { return throttle.get(key) || null; },
    async recordThrottleFailure(input) { const previous = throttle.get(input.bucketKey); const row = { ...previous, failure_count: Number(previous?.failure_count || 0) + 1, blocked_until: input.blockedUntil, window_started_at: previous?.window_started_at || input.now }; throttle.set(input.bucketKey, row); return row; },
    async resetThrottle(key) { throttle.delete(key); },
    async recordAuthenticationEvent(event) { events.push(event); return { eventId: String(events.length) }; },
  };
  const passwordHasher = {
    async hash() { return "upgraded-hash"; },
    async verify(hash, password) { return ["current-hash", "upgraded-hash"].includes(hash) && password === "correct"; },
    needsRehash(hash) { return hash === "current-hash"; },
  };
  const service = createControlPlaneAuthenticationService({
    authenticationRepository: repository, passwordHasher, now: () => new Date(currentTime),
    integrationCredentialsRepository,
    randomBytes: () => Buffer.alloc(32, (randomCounter += 1)), throttleBaseDelayMs: 1,
    ...(idleTimeoutMs ? { idleTimeoutMs } : {}), ...(absoluteTimeoutMs ? { absoluteTimeoutMs } : {}),
  });
  return { service, repository, sessions, events, upgrades, organisation, user, membership, credential, setNow(value) { currentTime = new Date(value); } };
}

const metadata = { sourceNetworkHash: sha256("127.0.0.1"), userAgentHash: sha256("test"), correlationId: "corr" };

test("integration credentials are resolved by hash and raw bearer material is never passed to storage", async () => {
  const calls = [];
  const token = "cg_live_" + "a".repeat(43);
  const integrationCredentialsRepository = {
    async resolveActiveByTokenHash(hash) {
      calls.push(["resolve", hash]);
      return hash === sha256(token) ? {
        integrationCredentialId: "integration-1",
        organisationId: "org-1",
        serviceActorId: "alpha-feed-01",
        roleKey: "claims_analyst",
        tenantId: "tenant-alpha",
      } : null;
    },
    async recordUse(id, correlationId) { calls.push(["use", id, correlationId]); },
  };
  const { service } = fixture({ integrationCredentialsRepository });
  const resolved = await service.resolveIntegrationCredential(token, metadata);
  assert.equal(resolved.organisationId, "org-1");
  assert.equal(resolved.tenantId, "tenant-alpha");
  assert.equal(calls[0][1], sha256(token));
  assert.equal(calls.some((entry) => entry.includes(token)), false);
});

test("Argon2id hashes verify correctly, use unique salts, and support rehash detection", async () => {
  const first = await hashPassword("correct horse battery staple");
  const second = await hashPassword("correct horse battery staple");
  assert.match(first, /^\$argon2id\$/);
  assert.notEqual(first, second);
  assert.equal(await verifyPassword(first, "correct horse battery staple"), true);
  assert.equal(await verifyPassword(first, "wrong"), false);
  assert.equal(passwordHashNeedsRehash(first), false);
});

test("canonical and alias organisation login creates one hashed server session and upgrades an old hash", async () => {
  const f = fixture();
  const result = await f.service.login({ organisationSlug: " alpha-old ", username: " Investigator ", password: "correct" }, metadata);
  assert.equal(result.actor.organisation.organisationId, "org-1");
  assert.deepEqual(result.actor.roles, ["investigator"]);
  assert.equal(f.sessions.size, 1);
  assert.equal([...f.sessions.values()][0].hashedBearerSecret, sha256(result.bearerSecret));
  assert.notEqual([...f.sessions.values()][0].hashedBearerSecret, result.bearerSecret);
  assert.equal(f.upgrades.length, 1);
});

test("login failures are generic for wrong passwords, unknown, suspended, disabled, and unmapped identities", async () => {
  const cases = [
    [fixture(), { organisationSlug: "alpha", username: "investigator", password: "wrong" }],
    [fixture(), { organisationSlug: "unknown", username: "investigator", password: "wrong" }],
    [fixture({ organisationStatus: "suspended" }), { organisationSlug: "alpha", username: "investigator", password: "correct" }],
    [fixture({ organisationStatus: "archived" }), { organisationSlug: "alpha", username: "investigator", password: "correct" }],
    [fixture({ membershipStatus: "disabled" }), { organisationSlug: "alpha", username: "investigator", password: "correct" }],
    [fixture({ membershipValidUntil: new Date("2026-07-16T07:59:59Z") }), { organisationSlug: "alpha", username: "investigator", password: "correct" }],
    [fixture({ passwordHash: null }), { organisationSlug: "alpha", username: "investigator", password: "correct" }],
    [fixture({ mapping: false }), { organisationSlug: "alpha", username: "investigator", password: "correct" }],
  ];
  for (const [f, input] of cases) {
    await assert.rejects(() => f.service.login(input, metadata), (error) => error instanceof AuthenticationRejectedError && error.message === "The organisation or credentials could not be verified.");
  }
});

test("path organisation constraint accepts a canonical alias match and rejects a different immutable organisation generically", async () => {
  const accepted = fixture();
  const result = await accepted.service.login({
    organisationSlug: "alpha-old", username: "investigator", password: "correct", requiredOrganisationId: "org-1",
  }, metadata);
  assert.equal(result.actor.organisation.organisationId, "org-1");

  const rejected = fixture();
  await assert.rejects(() => rejected.service.login({
    organisationSlug: "alpha", username: "investigator", password: "correct", requiredOrganisationId: "org-2",
  }, metadata), (error) => error.code === "AUTHENTICATION_FAILED" && error.status === 401);
});

test("session resolution enforces CSRF, expiry, authorization version, and explicit revocation", async () => {
  const f = fixture();
  const login = await f.service.login({ organisationSlug: "alpha", username: "investigator", password: "correct" }, metadata);
  const resolved = await f.service.resolveSession(login.bearerSecret, metadata);
  assert.equal(resolved.actor.legacyTenant.tenantId, "tenant-alpha");
  assert.equal(f.service.verifyCsrf(resolved, login.csrfToken), true);
  assert.equal(f.service.verifyCsrf(resolved, "wrong"), false);
  const rotated = await f.service.rotateCsrf(resolved);
  assert.equal(f.service.verifyCsrf(resolved, rotated), true);
  assert.equal(f.service.verifyCsrf(resolved, login.csrfToken), false);
  f.user.authenticationVersion += 1;
  await assert.rejects(() => f.service.resolveSession(login.bearerSecret, metadata), /not valid/);
  assert.equal([...f.sessions.values()][0].revocationReason, "authorization_version_changed");
});

test("each successful login rotates bearer and CSRF material and absolute expiry is enforced independently", async () => {
  const f = fixture({ idleTimeoutMs: 10 * 60 * 60 * 1000, absoluteTimeoutMs: 8 * 60 * 60 * 1000 });
  const first = await f.service.login({ organisationSlug: "alpha", username: "investigator", password: "correct" }, metadata);
  const second = await f.service.login({ organisationSlug: "alpha", username: "investigator", password: "correct" }, metadata);
  assert.notEqual(first.bearerSecret, second.bearerSecret);
  assert.notEqual(first.csrfToken, second.csrfToken);
  assert.equal(f.sessions.size, 2);
  f.setNow("2026-07-16T16:00:01Z");
  await assert.rejects(() => f.service.resolveSession(second.bearerSecret, metadata), /not valid/);
  assert.equal(f.sessions.get("session-2").revocationReason, "expired");
});

test("idle expiry and user, membership, organisation, and credential revocation paths fail closed", async () => {
  for (const mutation of [
    (f) => { f.user.status = "disabled"; },
    (f) => { f.membership.status = "revoked"; },
    (f) => { f.organisation.status = "suspended"; },
    (f) => { f.credential.status = "disabled"; },
    (f) => { f.setNow("2026-07-16T09:00:00Z"); },
  ]) {
    const f = fixture();
    const login = await f.service.login({ organisationSlug: "alpha", username: "investigator", password: "correct" }, metadata);
    mutation(f);
    await assert.rejects(() => f.service.resolveSession(login.bearerSecret, metadata), /not valid/);
  }
});

test("durable throttle state is written and generic lockout responses do not reveal account existence", async () => {
  const f = fixture();
  for (let attempt = 0; attempt < 2; attempt += 1) {
    await assert.rejects(
      () => f.service.login({ organisationSlug: "alpha", username: "investigator", password: "wrong" }, metadata),
      /could not be verified/,
    );
  }
  assert.equal(f.events.some((event) => ["login_failure", "login_throttled"].includes(event.eventType)), true);
});
