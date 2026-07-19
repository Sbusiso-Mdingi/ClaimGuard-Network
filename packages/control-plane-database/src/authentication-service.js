import crypto from "node:crypto";

import { AuthenticationRejectedError, SessionRejectedError } from "./errors.js";
import {
  ARGON2ID_VERSION,
  DEFAULT_ARGON2ID_PARAMETERS,
  hashPassword,
  passwordHashNeedsRehash,
  passwordParametersRecord,
  verifyPassword,
} from "./password.js";
import { normalizeOrganisationSlug, normalizeUsername } from "./validation.js";

const SHA256_PATTERN = /^[a-f0-9]{64}$/;

export function sha256(value) {
  return crypto.createHash("sha256").update(String(value || "")).digest("hex");
}

function secureToken(randomBytes = crypto.randomBytes) {
  return randomBytes(32).toString("base64url");
}

function asDate(value) {
  if (value instanceof Date) return value;
  return value ? new Date(value) : null;
}

function isFuture(value, now) {
  const date = asDate(value);
  return Boolean(date && date.getTime() > now.getTime());
}

function isPast(value, now) {
  const date = asDate(value);
  return Boolean(date && date.getTime() <= now.getTime());
}

function safeSourceMetadata(metadata = {}) {
  return {
    sourceNetworkHash: SHA256_PATTERN.test(metadata.sourceNetworkHash || "") ? metadata.sourceNetworkHash : null,
    userAgentHash: SHA256_PATTERN.test(metadata.userAgentHash || "") ? metadata.userAgentHash : null,
    correlationId: metadata.correlationId ? String(metadata.correlationId).slice(0, 128) : null,
  };
}

function validOrganisation(organisation) {
  return Boolean(
    organisation &&
    ["active", "redirect"].includes(organisation.matchedSlugStatus) &&
    ["canonical", "alias"].includes(organisation.matchedSlugType) &&
    organisation.status === "active" &&
    organisation.activationState === "activated",
  );
}

function validMembership(membership, now) {
  return Boolean(
    membership?.status === "active" &&
    (!membership.validFrom || !isFuture(membership.validFrom, now)) &&
    (!membership.validUntil || !isPast(membership.validUntil, now)),
  );
}

function validLegacyBridge(organisation, bridge) {
  if (organisation.organisationType === "platform") return bridge == null;
  return Boolean(bridge?.migrationStatus === "verified" && bridge.verifiedAt && bridge.legacyTenantId);
}

function actorProjection({ organisation, user, membership, credential, authorization, bridge }) {
  return {
    user: { userId: user.userId, displayName: user.displayName },
    organisation: {
      organisationId: organisation.organisationId,
      displayName: organisation.displayName,
      canonicalSlug: organisation.canonicalSlug,
      organisationType: organisation.organisationType,
      deploymentClass: organisation.deploymentClass,
    },
    membership: { membershipId: membership.membershipId },
    credential: { credentialId: credential.credentialId },
    roles: Object.freeze([...authorization.roles]),
    permissions: Object.freeze([...authorization.permissions]),
    authorizationVersion: user.authenticationVersion,
    legacyTenant: bridge ? {
      tenantId: bridge.legacyTenantId,
      tenantSlug: bridge.legacyTenantSlug,
    } : null,
  };
}

export function createControlPlaneAuthenticationService({
  authenticationRepository,
  integrationCredentialsRepository = null,
  now = () => new Date(),
  randomBytes = crypto.randomBytes,
  passwordHasher = { hash: hashPassword, verify: verifyPassword, needsRehash: passwordHashNeedsRehash },
  argon2Parameters = DEFAULT_ARGON2ID_PARAMETERS,
  idleTimeoutMs = 30 * 60 * 1000,
  absoluteTimeoutMs = 8 * 60 * 60 * 1000,
  throttleWindowMs = 15 * 60 * 1000,
  throttleMaxAttempts = 8,
  throttleBaseDelayMs = 500,
  throttleMaxDelayMs = 30 * 1000,
  throttleLockoutMs = 15 * 60 * 1000,
} = {}) {
  if (!authenticationRepository) throw new TypeError("authenticationRepository is required.");
  const dummyHash = Promise.resolve().then(() => passwordHasher.hash(secureToken(randomBytes), argon2Parameters));

  async function recordEvent(eventType, result, metadata, references = {}, failureCategory = null) {
    return authenticationRepository.recordAuthenticationEvent({
      eventType,
      result,
      ...safeSourceMetadata(metadata),
      organisationCandidateHash: references.organisationCandidateHash || null,
      organisationId: references.organisationId || null,
      userId: references.userId || null,
      credentialId: references.credentialId || null,
      failureCategory,
    });
  }

  function throttleIdentity({ sourceNetworkHash, organisationSlug, username }) {
    const organisationSlugHash = sha256(organisationSlug);
    const usernameHash = sha256(username);
    return {
      sourceNetworkHash: SHA256_PATTERN.test(sourceNetworkHash || "") ? sourceNetworkHash : sha256("unknown-source"),
      organisationSlugHash,
      usernameHash,
      bucketKey: sha256(`${sourceNetworkHash || "unknown-source"}:${organisationSlugHash}:${usernameHash}`),
    };
  }

  async function rejectLogin(reason, metadata, references, throttle) {
    const timestamp = now();
    const existing = await authenticationRepository.getThrottleBucket(throttle.bucketKey);
    const windowStarted = asDate(existing?.window_started_at);
    const previousFailures = windowStarted && timestamp.getTime() - windowStarted.getTime() <= throttleWindowMs
      ? Number(existing.failure_count || 0)
      : 0;
    const failureCount = previousFailures + 1;
    const progressiveDelay = Math.min(throttleBaseDelayMs * (2 ** Math.max(0, failureCount - 1)), throttleMaxDelayMs);
    const delay = failureCount >= throttleMaxAttempts ? Math.max(progressiveDelay, throttleLockoutMs) : progressiveDelay;
    const blockedUntil = new Date(timestamp.getTime() + delay);
    await authenticationRepository.recordThrottleFailure({
      ...throttle,
      now: timestamp,
      blockedUntil,
      windowCutoff: new Date(timestamp.getTime() - throttleWindowMs),
    });
    const locked = failureCount >= throttleMaxAttempts;
    if (references.credentialId && authenticationRepository.recordCredentialFailure) {
      await authenticationRepository.recordCredentialFailure(references.credentialId, { lockedUntil: locked ? blockedUntil : null });
    }
    await recordEvent(locked ? "credential_temporarily_locked" : "login_failure", locked ? "locked" : "failure", metadata, references, reason);
    throw new AuthenticationRejectedError(reason);
  }

  async function validateSession(session, bearerSecret, metadata, { touch = true } = {}) {
    const timestamp = now();
    const references = session ? {
      organisationId: session.organisationId, userId: session.userId, credentialId: session.credentialId,
    } : {};
    const invalidate = async (reason) => {
      await authenticationRepository.revokeSession(session.sessionId, reason);
      await recordEvent("session_revoked", "failure", metadata, references, reason);
      throw new SessionRejectedError(reason, { organisationId: session.organisationId });
    };
    if (!session || session.revokedAt) throw new SessionRejectedError("revoked_or_unknown_session");
    if (isPast(session.absoluteExpiresAt, timestamp) || isPast(session.idleExpiresAt, timestamp)) {
      await authenticationRepository.revokeSession(session.sessionId, "expired");
      await recordEvent("session_expired", "failure", metadata, references, "session_expired");
      throw new SessionRejectedError("session_expired");
    }

    const [resolvedOrganisation, user] = await Promise.all([
      authenticationRepository.getOrganisationById(session.organisationId),
      authenticationRepository.getUser(session.userId),
    ]);
    const membership = await authenticationRepository.getMembership({ userId: session.userId, organisationId: session.organisationId });
    const credential = session.credentialId
      ? await authenticationRepository.getCredentialById(session.credentialId)
      : null;
    if (!resolvedOrganisation || resolvedOrganisation.status !== "active" || resolvedOrganisation.activationState !== "activated") {
      return invalidate("organisation_inactive");
    }
    if (!user || user.status !== "active") {
      return invalidate("user_inactive");
    }
    if (!validMembership(membership, timestamp)) {
      return invalidate("membership_inactive");
    }
    if (credential && (credential.status !== "active" || isFuture(credential.lockedUntil, timestamp))) {
      return invalidate("credential_inactive");
    }
    if (user.authenticationVersion !== session.authorizationVersion) {
      await authenticationRepository.revokeSession(session.sessionId, "authorization_version_changed");
      await recordEvent("authorization_version_mismatch", "failure", metadata, references, "authorization_version_mismatch");
      throw new SessionRejectedError("authorization_version_mismatch");
    }
    const [authorization, bridge] = await Promise.all([
      authenticationRepository.getAuthorization(membership.membershipId),
      authenticationRepository.getLegacyTenantBridge(session.organisationId),
    ]);
    if (!validLegacyBridge(resolvedOrganisation, bridge)) return invalidate("legacy_tenant_bridge_unavailable");
    if (touch) {
      const idleExpiresAt = new Date(Math.min(timestamp.getTime() + idleTimeoutMs, asDate(session.absoluteExpiresAt).getTime()));
      await authenticationRepository.touchSession(session.sessionId, { lastActivityAt: timestamp, idleExpiresAt });
      session.lastActivityAt = timestamp;
      session.idleExpiresAt = idleExpiresAt;
    }
    return {
      session,
      bearerSecret,
      actor: actorProjection({ organisation: resolvedOrganisation, user, membership, credential: credential || { credentialId: session.credentialId }, authorization, bridge }),
    };
  }

  return {
    async resolveIntegrationCredential(bearerSecret, metadata = {}) {
      if (!integrationCredentialsRepository || typeof bearerSecret !== "string" || bearerSecret.length < 43) {
        return null;
      }
      const credential = await integrationCredentialsRepository.resolveActiveByTokenHash(sha256(bearerSecret));
      if (!credential) return null;
      await integrationCredentialsRepository.recordUse(
        credential.integrationCredentialId,
        safeSourceMetadata(metadata).correlationId,
      );
      return Object.freeze({
        integrationCredentialId: credential.integrationCredentialId,
        serviceActorId: credential.serviceActorId,
        roleKey: credential.roleKey,
        tenantId: credential.tenantId,
        organisationId: credential.organisationId,
      });
    },

    async resolveOrganisationCandidate(slug) {
      try {
        const organisation = await authenticationRepository.resolveOrganisation(normalizeOrganisationSlug(slug));
        return validOrganisation(organisation) ? {
          organisationId: organisation.organisationId,
          canonicalSlug: organisation.canonicalSlug,
        } : null;
      } catch {
        return null;
      }
    },

    async login({ organisationSlug, username, password, requiredOrganisationId = null }, metadata = {}) {
      let normalizedSlug;
      let normalizedUsername;
      try {
        normalizedSlug = normalizeOrganisationSlug(organisationSlug);
        normalizedUsername = normalizeUsername(username);
      } catch {
        normalizedSlug = String(organisationSlug || "").trim().toLowerCase();
        normalizedUsername = String(username || "").trim().toLowerCase();
      }
      const throttle = throttleIdentity({ sourceNetworkHash: metadata.sourceNetworkHash, organisationSlug: normalizedSlug, username: normalizedUsername });
      const references = { organisationCandidateHash: throttle.organisationSlugHash };
      const timestamp = now();
      const bucket = await authenticationRepository.getThrottleBucket(throttle.bucketKey);
      if (bucket?.blocked_until && isFuture(bucket.blocked_until, timestamp)) {
        await recordEvent("login_throttled", "throttled", metadata, references, "throttled");
        throw new AuthenticationRejectedError("throttled");
      }

      let organisation = null;
      try { organisation = await authenticationRepository.resolveOrganisation(normalizedSlug); } catch { /* generic failure */ }
      if (organisation) references.organisationId = organisation.organisationId;
      const credential = organisation
        ? await authenticationRepository.getInternalCredential({ organisationId: organisation.organisationId, username: normalizedUsername })
        : null;
      if (credential) {
        references.credentialId = credential.credentialId;
        references.userId = credential.userId;
      }
      const candidateHash = credential?.passwordHash || await dummyHash;
      const passwordMatches = await passwordHasher.verify(candidateHash, typeof password === "string" ? password : "");

      if (!validOrganisation(organisation) || (requiredOrganisationId && organisation.organisationId !== requiredOrganisationId)) {
        return rejectLogin("invalid_organisation", metadata, references, throttle);
      }
      if (!credential || credential.authenticationProvider !== "local_password" || !credential.passwordHash) {
        return rejectLogin("invalid_credential", metadata, references, throttle);
      }
      if (!passwordMatches) return rejectLogin("invalid_credential", metadata, references, throttle);
      if (credential.status !== "active" || isFuture(credential.lockedUntil, timestamp)) {
        return rejectLogin("credential_inactive", metadata, references, throttle);
      }
      const [user, membership, bridge] = await Promise.all([
        authenticationRepository.getUser(credential.userId),
        authenticationRepository.getMembership({ userId: credential.userId, organisationId: organisation.organisationId }),
        authenticationRepository.getLegacyTenantBridge(organisation.organisationId),
      ]);
      if (!user || user.status !== "active") return rejectLogin("user_inactive", metadata, references, throttle);
      if (!validMembership(membership, timestamp)) return rejectLogin("membership_inactive", metadata, references, throttle);
      if (!validLegacyBridge(organisation, bridge)) return rejectLogin("legacy_tenant_bridge_unavailable", metadata, references, throttle);
      const authorization = await authenticationRepository.getAuthorization(membership.membershipId);
      if (authorization.roles.length === 0) return rejectLogin("authorization_unavailable", metadata, references, throttle);

      if (passwordHasher.needsRehash(credential.passwordHash, argon2Parameters)) {
        const upgraded = await passwordHasher.hash(password, argon2Parameters);
        await authenticationRepository.upgradePasswordHash({
          credentialId: credential.credentialId, previousHash: credential.passwordHash, passwordHash: upgraded,
          parameters: passwordParametersRecord(argon2Parameters), version: ARGON2ID_VERSION,
        });
      }
      await authenticationRepository.resetThrottle(throttle.bucketKey);
      if (authenticationRepository.clearCredentialFailures) await authenticationRepository.clearCredentialFailures(credential.credentialId);
      const bearerSecret = secureToken(randomBytes);
      const csrfToken = secureToken(randomBytes);
      const absoluteExpiresAt = new Date(timestamp.getTime() + absoluteTimeoutMs);
      const idleExpiresAt = new Date(Math.min(timestamp.getTime() + idleTimeoutMs, absoluteExpiresAt.getTime()));
      const session = {
        hashedBearerSecret: sha256(bearerSecret), csrfTokenHash: sha256(csrfToken), signingKeyId: "opaque-v1",
        userId: user.userId, organisationId: organisation.organisationId, membershipId: membership.membershipId,
        credentialId: credential.credentialId, issuedAt: timestamp, lastActivityAt: timestamp,
        idleExpiresAt, absoluteExpiresAt, authorizationVersion: user.authenticationVersion,
        clientMetadata: { sourceNetworkHash: metadata.sourceNetworkHash || null, userAgentHash: metadata.userAgentHash || null },
      };
      const created = await authenticationRepository.createSession(session);
      session.sessionId = created.sessionId;
      await recordEvent("login_success", "success", metadata, references);
      return {
        bearerSecret, csrfToken, session,
        actor: actorProjection({ organisation, user, membership, credential, authorization, bridge }),
      };
    },

    async resolveSession(bearerSecret, metadata = {}, options = {}) {
      if (typeof bearerSecret !== "string" || bearerSecret.length < 40) throw new SessionRejectedError("invalid_session_secret");
      const session = await authenticationRepository.getSessionByBearerHash(sha256(bearerSecret));
      return validateSession(session, bearerSecret, metadata, options);
    },

    async rotateCsrf(resolvedSession) {
      const csrfToken = secureToken(randomBytes);
      await authenticationRepository.rotateCsrfToken(resolvedSession.session.sessionId, sha256(csrfToken));
      resolvedSession.session.csrfTokenHash = sha256(csrfToken);
      return csrfToken;
    },

    verifyCsrf(resolvedSession, token) {
      if (typeof token !== "string" || !resolvedSession?.session?.csrfTokenHash) return false;
      const actual = Buffer.from(sha256(token), "hex");
      const expected = Buffer.from(resolvedSession.session.csrfTokenHash, "hex");
      return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
    },

    async logout(resolvedSession, metadata = {}) {
      if (!resolvedSession?.session) return false;
      const revoked = await authenticationRepository.revokeSession(resolvedSession.session.sessionId, "logout");
      await recordEvent("logout", "success", metadata, {
        organisationId: resolvedSession.session.organisationId, userId: resolvedSession.session.userId,
        credentialId: resolvedSession.session.credentialId,
      });
      return revoked;
    },

    revokeSession: (sessionId, reason = "administrative") => authenticationRepository.revokeSession(sessionId, reason),
    revokeUserSessions: (userId, reason = "user_disabled") => authenticationRepository.revokeSessionsBy("user", userId, reason),
    revokeMembershipSessions: (membershipId, reason = "membership_disabled") => authenticationRepository.revokeSessionsBy("membership", membershipId, reason),
    revokeOrganisationSessions: (organisationId, reason = "organisation_suspended") => authenticationRepository.revokeSessionsBy("organisation", organisationId, reason),
    revokeCredentialSessions: (credentialId, reason = "credential_disabled") => authenticationRepository.revokeSessionsBy("credential", credentialId, reason),
    recordSecurityEvent: recordEvent,
  };
}
