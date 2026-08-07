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

function fixture({
  passwordHash = "current-hash",
  organisationStatus = "active",
  membershipStatus = "active",
  userStatus = "active",
  credentialStatus = "active",
  mapping = true,
  membershipValidUntil = null,
  authenticationVersion = 3,
  authorizationVersion = 7,
  effectivePermissions = ["investigations.manage", "case.review_evidence"],
  idleTimeoutMs,
  absoluteTimeoutMs,
  integrationCredentialsRepository = null,
} = {}) {
  let currentTime = new Date("2026-07-16T08:00:00Z");
  let randomCounter = 0;
  const sessions = new Map();
  const throttle = new Map();
  const events = [];
  const upgrades = [];
  const resolutionCalls = [];
  const organisation = {
    organisationId: "org-1", displayName: "Alpha", canonicalSlug: "alpha", organisationType: "medical_scheme",
    deploymentClass: "demo", status: organisationStatus, activationState: "activated",
    matchedSlug: "alpha", matchedSlugType: "canonical", matchedSlugStatus: "active",
  };
  const user = { userId: "user-1", displayName: "User", status: userStatus, authenticationVersion };
  const membership = {
    membershipId: "membership-1", userId: "user-1", organisationId: "org-1",
    status: membershipStatus, validUntil: membershipValidUntil, authorizationVersion,
  };
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
    async getAuthorization() { return { roles: ["investigator"], permissions: ["role-name-permission-must-not-authorize"] }; },
    async getLegacyTenantBridge() { return mapping ? { legacyTenantId: "tenant-alpha", legacyTenantSlug: "alpha", migrationStatus: "verified", verifiedAt: new Date() } : null; },
    async upgradePasswordHash(input) { upgrades.push(input); credential.passwordHash = input.passwordHash; return true; },
    async recordCredentialFailure() { credential.failedAttemptCount = Number(credential.failedAttemptCount || 0) + 1; },
    async clearCredentialFailures() { credential.failedAttemptCount = 0; credential.lockedUntil = null; },
    async createSession(input) {
      const sessionId = `session-${sessions.size + 1}`;
      assert.equal(Object.hasOwn(input, "bearerSecret"), false);
      sessions.set(sessionId, { ...input, sessionId, revokedAt: null });
      return { sessionId };
    },
    async getSessionByBearerHash(hash) { return [...sessions.values()].find((session) => session.hashedBearerSecret === hash) || null; },
    async touchSession(id, updates) { Object.assign(sessions.get(id), updates); },
    async rotateCsrfToken(id, csrfTokenHash) { sessions.get(id).csrfTokenHash = csrfTokenHash; },
    async revokeSession(id, reason) { const session = sessions.get(id); if (!session) return false; session.revokedAt ||= currentTime; session.revocationReason ||= reason; return true; },
    async revokeSessionsBy(scope, id, reason) { let count = 0; for (const session of sessions.values()) { const key = { user: "userId", membership: "membershipId", organisation: "organisationId", credential: "credentialId" }[scope]; if (session[key] === id && !session.revokedAt) { session.revokedAt = currentTime; session.revocationReason = reason; count += 1; } } return count; },
    async revokeOtherSessionsByCredential(credentialId, currentSessionId, reason) { let count = 0; for (const session of sessions.values()) { if (session.credentialId === credentialId && session.sessionId !== currentSessionId && !session.revokedAt) { session.revokedAt = currentTime; session.revocationReason = reason; count += 1; } } return count; },
    async getThrottleBucket(key) { return throttle.get(key) || null; },
    async recordThrottleFailure(input) { const previous = throttle.get(input.bucketKey); const row = { ...previous, failure_count: Number(previous?.failure_count || 0) + 1, blocked_until: input.blockedUntil, window_started_at: previous?.window_started_at || input.now }; throttle.set(input.bucketKey, row); return row; },
    async resetThrottle(key) { throttle.delete(key); },
    async recordAuthenticationEvent(event) { events.push(event); return { eventId: String(events.length) }; },
  };
  const accessRepository = {
    async resolveEffectivePermissions(input) {
      resolutionCalls.push(input);
      return {
        organisationId: input.organisationId,
        userId: input.userId,
        membershipId: input.membershipId,
        permissionKeys: [...new Set(effectivePermissions)],
        permissions: [...new Set(effectivePermissions)].map((permission) => ({ permission, sources: [{ type: "system_role" }] })),
        resolvedAt: input.asOf,
      };
    },
  };
  const passwordHasher = {
    async hash(password) { return password === "replacement-password" ? "replacement-hash" : "upgraded-hash"; },
    async verify(hash, password) {
      if (["current-hash", "upgraded-hash"].includes(hash)) return password === "correct";
      return hash === "replacement-hash" && password === "replacement-password";
    },
    needsRehash(hash) { return hash === "current-hash"; },
  };
  const service = createControlPlaneAuthenticationService({
    authenticationRepository: repository,
    accessRepository,
    passwordHasher,
    now: () => new Date(currentTime),
    integrationCredentialsRepository,
    randomBytes: () => Buffer.alloc(32, (randomCounter += 1)),
    throttleBaseDelayMs: 1,
    ...(idleTimeoutMs ? { idleTimeoutMs } : {}),
    ...(absoluteTimeoutMs ? { absoluteTimeoutMs } : {}),
  });
  return {
    service, repository, accessRepository, resolutionCalls, sessions, events, upgrades,
    organisation, user, membership, credential,
    setNow(value) { currentTime = new Date(value); },
  };
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

test("login stores distinct authentication and authorization versions and resolves current permissions", async () => {
  const f = fixture({ authenticationVersion: 3, authorizationVersion: 11 });
  const result = await f.service.login({ organisationSlug: " alpha-old ", username: " Investigator ", password: "correct" }, metadata);
  const stored = [...f.sessions.values()][0];
  assert.equal(result.actor.organisation.organisationId, "org-1");
  assert.deepEqual(result.actor.roles, ["investigator"]);
  assert.deepEqual(result.actor.permissions, ["investigations.manage", "case.review_evidence"]);
  assert.equal(stored.authenticationVersion, 3);
  assert.equal(stored.authorizationVersion, 11);
  assert.notEqual(stored.authenticationVersion, stored.authorizationVersion);
  assert.equal(stored.hashedBearerSecret, sha256(result.bearerSecret));
  assert.notEqual(stored.hashedBearerSecret, result.bearerSecret);
  assert.equal(f.upgrades.length, 1);
  assert.equal(f.resolutionCalls.length, 1);
});

test("login fails closed when either authoritative version is unavailable", async () => {
  for (const options of [
    { authenticationVersion: null, authorizationVersion: 7 },
    { authenticationVersion: 3, authorizationVersion: null },
  ]) {
    const f = fixture(options);
    await assert.rejects(
      () => f.service.login({ organisationSlug: "alpha", username: "investigator", password: "correct" }, metadata),
      (error) => error.code === "AUTHENTICATION_FAILED",
    );
    assert.equal(f.sessions.size, 0);
  }
});

test("sensitive actions require a fresh password check bound to the current session identity", async () => {
  const f = fixture();
  const login = await f.service.login({ organisationSlug: "alpha", username: "investigator", password: "correct" }, metadata);
  const resolved = await f.service.resolveSession(login.bearerSecret, metadata);
  const reauthenticated = await f.service.reauthenticate(resolved, "correct", metadata);
  assert.equal(reauthenticated.userId, "user-1");
  assert.equal(reauthenticated.credentialId, "credential-1");
  assert.deepEqual(f.events.slice(-1).map((event) => [event.eventType, event.result]), [["reauthentication_success", "success"]]);
  await assert.rejects(
    () => f.service.reauthenticate(resolved, "wrong", metadata),
    (error) => error instanceof AuthenticationRejectedError && error.code === "AUTHENTICATION_FAILED",
  );
  assert.deepEqual(f.events.slice(-1).map((event) => [event.eventType, event.result]), [["reauthentication_failure", "failure"]]);
});

test("password changes verify the current secret, replace the Argon2id hash, and revoke other sessions", async () => {
  const f = fixture();
  const first = await f.service.login({ organisationSlug: "alpha", username: "investigator", password: "correct" }, metadata);
  const second = await f.service.login({ organisationSlug: "alpha", username: "investigator", password: "correct" }, metadata);
  const resolved = await f.service.resolveSession(second.bearerSecret, metadata);
  const changed = await f.service.changePassword(resolved, { currentPassword: "correct", newPassword: "replacement-password" }, metadata);
  assert.equal(changed.changed, true);
  assert.equal(changed.otherSessionsRevoked, 1);
  assert.equal(f.credential.passwordHash, "replacement-hash");
  assert.equal(f.sessions.get("session-1").revocationReason, "password_changed");
  assert.equal(f.sessions.get("session-2").revokedAt, null);
  assert.deepEqual(f.events.slice(-1).map((event) => [event.eventType, event.result]), [["password_changed", "success"]]);
  await assert.rejects(() => f.service.resolveSession(first.bearerSecret, metadata), /not valid/);
});

test("password changes reject a wrong current password and password reuse with audited failures", async () => {
  const f = fixture();
  const login = await f.service.login({ organisationSlug: "alpha", username: "investigator", password: "correct" }, metadata);
  const resolved = await f.service.resolveSession(login.bearerSecret, metadata);
  await assert.rejects(
    () => f.service.changePassword(resolved, { currentPassword: "wrong", newPassword: "replacement-password" }, metadata),
    (error) => error.code === "AUTHENTICATION_FAILED",
  );
  await assert.rejects(
    () => f.service.changePassword(resolved, { currentPassword: "correct", newPassword: "correct" }, metadata),
    (error) => error.code === "PASSWORD_REUSE",
  );
  assert.deepEqual(
    f.events.slice(-2).map((event) => [event.eventType, event.result, event.failureCategory]),
    [
      ["password_changed", "failure", "invalid_current_password"],
      ["password_changed", "failure", "password_reuse"],
    ],
  );
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
  const result = await accepted.service.login({ organisationSlug: "alpha-old", username: "investigator", password: "correct", requiredOrganisationId: "org-1" }, metadata);
  assert.equal(result.actor.organisation.organisationId, "org-1");
  const rejected = fixture();
  await assert.rejects(() => rejected.service.login({ organisationSlug: "alpha", username: "investigator", password: "correct", requiredOrganisationId: "org-2" }, metadata), (error) => error.code === "AUTHENTICATION_FAILED" && error.status === 401);
});

test("session resolution distinguishes authentication and authorization version failures", async () => {
  const authenticationChanged = fixture({ authenticationVersion: 3, authorizationVersion: 7 });
  const authnLogin = await authenticationChanged.service.login({ organisationSlug: "alpha", username: "investigator", password: "correct" }, metadata);
  authenticationChanged.user.authenticationVersion = 4;
  await assert.rejects(() => authenticationChanged.service.resolveSession(authnLogin.bearerSecret, metadata), /not valid/);
  assert.equal([...authenticationChanged.sessions.values()][0].revocationReason, "authentication_version_changed");

  const authorizationChanged = fixture({ authenticationVersion: 3, authorizationVersion: 7 });
  const authzLogin = await authorizationChanged.service.login({ organisationSlug: "alpha", username: "investigator", password: "correct" }, metadata);
  const staleSession = [...authorizationChanged.sessions.values()][0];
  authorizationChanged.membership.authorizationVersion = 8;
  await assert.rejects(
    () => authorizationChanged.service.resolveSession(authzLogin.bearerSecret, metadata),
    (error) => error.code === "ACCESS_AUTHORIZATION_VERSION_STALE" && error.status === 409,
  );
  assert.equal(staleSession.authorizationVersion, 7);
  assert.equal(staleSession.revokedAt, null);
  assert.equal(authorizationChanged.resolutionCalls.length, 1);
  assert.deepEqual(
    authorizationChanged.events.slice(-1).map((event) => [event.eventType, event.failureCategory]),
    [["authorization_version_mismatch", "authorization_version_mismatch"]],
  );
});

test("matching session versions re-resolve current permissions and preserve CSRF", async () => {
  const f = fixture();
  const login = await f.service.login({ organisationSlug: "alpha", username: "investigator", password: "correct" }, metadata);
  const resolved = await f.service.resolveSession(login.bearerSecret, metadata);
  assert.equal(resolved.actor.legacyTenant.tenantId, "tenant-alpha");
  assert.deepEqual(resolved.actor.permissions, ["investigations.manage", "case.review_evidence"]);
  assert.equal(f.resolutionCalls.length, 2);
  assert.equal(f.service.verifyCsrf(resolved, login.csrfToken), true);
  assert.equal(f.service.verifyCsrf(resolved, "wrong"), false);
  const rotated = await f.service.rotateCsrf(resolved);
  assert.equal(f.service.verifyCsrf(resolved, rotated), true);
  assert.equal(f.service.verifyCsrf(resolved, login.csrfToken), false);
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