import crypto from "node:crypto";

import { executorOr } from "./transaction.js";
import { normalizeOrganisationSlug, normalizeUsername, safeErrorSummary } from "./validation.js";

function jsonValue(value) {
  if (value == null || typeof value !== "string") return value || null;
  try { return JSON.parse(value); } catch { return null; }
}

function mapOrganisation(row) {
  if (!row) return null;
  return {
    organisationId: row.organisation_id,
    displayName: row.display_name,
    canonicalSlug: row.canonical_slug,
    organisationType: row.organisation_type,
    deploymentClass: row.deployment_class,
    status: row.organisation_status,
    activationState: row.activation_state,
    matchedSlug: row.matched_slug,
    matchedSlugType: row.slug_type,
    matchedSlugStatus: row.slug_status,
  };
}

function mapUser(row) {
  if (!row) return null;
  return {
    userId: row.user_id, displayName: row.display_name, canonicalContact: row.canonical_contact || null,
    status: row.status, authenticationVersion: Number(row.authentication_version), disabledAt: row.disabled_at || null,
  };
}

function mapMembership(row) {
  if (!row) return null;
  return {
    membershipId: row.membership_id, userId: row.user_id, organisationId: row.organisation_id,
    status: row.status, validFrom: row.valid_from || null, validUntil: row.valid_until || null,
  };
}

function mapCredential(row) {
  if (!row) return null;
  return {
    credentialId: row.credential_id, userId: row.user_id, organisationId: row.organisation_id,
    authenticationProvider: row.authentication_provider, normalizedUsername: row.normalized_username,
    passwordHash: row.password_hash || null, passwordAlgorithm: row.password_algorithm || null,
    passwordParameters: jsonValue(row.password_parameters), passwordVersion: Number(row.password_version || 0),
    status: row.status, failedAttemptCount: Number(row.failed_attempt_count || 0), lockedUntil: row.locked_until || null,
  };
}

function mapSession(row) {
  if (!row) return null;
  return {
    sessionId: row.session_id, hashedBearerSecret: row.hashed_bearer_secret, csrfTokenHash: row.csrf_token_hash,
    signingKeyId: row.signing_key_id, userId: row.user_id, organisationId: row.organisation_id,
    membershipId: row.membership_id, credentialId: row.credential_id || null, issuedAt: row.issued_at,
    lastActivityAt: row.last_activity_at, idleExpiresAt: row.idle_expires_at, absoluteExpiresAt: row.absolute_expires_at,
    revokedAt: row.revoked_at || null, revocationReason: row.revocation_reason || null,
    authorizationVersion: Number(row.authorization_version), rotationGeneration: Number(row.rotation_generation || 1),
    rotatedFromSessionId: row.rotated_from_session_id || null, clientMetadata: jsonValue(row.client_metadata),
  };
}

export function createAuthenticationRepository(defaultExecutor) {
  return {
    async resolveOrganisation(slug, { executor } = {}) {
      const [rows] = await executorOr(defaultExecutor, executor).execute(
        `SELECT o.organisation_id, o.display_name, o.canonical_slug, o.organisation_type, o.deployment_class,
                o.status AS organisation_status, o.activation_state, s.slug AS matched_slug,
                s.slug_type, s.status AS slug_status
         FROM organisation_slugs s JOIN organisations o ON o.organisation_id = s.organisation_id
         WHERE s.slug = ? LIMIT 2`,
        [normalizeOrganisationSlug(slug)],
      );
      return rows?.length === 1 ? mapOrganisation(rows[0]) : null;
    },

    async getOrganisationById(organisationId, { executor } = {}) {
      const [rows] = await executorOr(defaultExecutor, executor).execute(
        `SELECT o.organisation_id, o.display_name, o.canonical_slug, o.organisation_type, o.deployment_class,
                o.status AS organisation_status, o.activation_state, o.canonical_slug AS matched_slug,
                'canonical' AS slug_type, 'active' AS slug_status
         FROM organisations o WHERE o.organisation_id = ? LIMIT 1`,
        [organisationId],
      );
      return mapOrganisation(rows?.[0]);
    },

    async getInternalCredential({ organisationId, username }, { executor } = {}) {
      const [rows] = await executorOr(defaultExecutor, executor).execute(
        `SELECT * FROM credential_identities
         WHERE organisation_id = ? AND authentication_provider = 'local_password' AND normalized_username = ? LIMIT 1`,
        [organisationId, normalizeUsername(username)],
      );
      return mapCredential(rows?.[0]);
    },

    async getCredentialById(credentialId, { executor } = {}) {
      const [rows] = await executorOr(defaultExecutor, executor).execute(
        "SELECT * FROM credential_identities WHERE credential_id = ? LIMIT 1",
        [credentialId],
      );
      return mapCredential(rows?.[0]);
    },

    async getUser(userId, { executor } = {}) {
      const [rows] = await executorOr(defaultExecutor, executor).execute("SELECT * FROM users WHERE user_id = ? LIMIT 1", [userId]);
      return mapUser(rows?.[0]);
    },

    async getMembership({ userId, organisationId }, { executor } = {}) {
      const [rows] = await executorOr(defaultExecutor, executor).execute(
        "SELECT * FROM organisation_memberships WHERE user_id = ? AND organisation_id = ? LIMIT 1",
        [userId, organisationId],
      );
      return mapMembership(rows?.[0]);
    },

    async getAuthorization(membershipId, { executor } = {}) {
      const [rows] = await executorOr(defaultExecutor, executor).execute(
        `SELECT r.role_key, p.permission_key FROM membership_roles mr
         JOIN roles r ON r.role_id = mr.role_id
         LEFT JOIN role_permissions rp ON rp.role_id = r.role_id
         LEFT JOIN permissions p ON p.permission_id = rp.permission_id
         WHERE mr.membership_id = ? AND mr.revoked_at IS NULL ORDER BY r.role_key, p.permission_key`,
        [membershipId],
      );
      return {
        roles: [...new Set((rows || []).map((row) => row.role_key).filter(Boolean))],
        permissions: [...new Set((rows || []).map((row) => row.permission_key).filter(Boolean))],
      };
    },

    async getLegacyTenantBridge(organisationId, { executor } = {}) {
      const [rows] = await executorOr(defaultExecutor, executor).execute(
        `SELECT legacy_tenant_id, legacy_tenant_slug, migration_status, verified_at
         FROM legacy_tenant_mappings WHERE organisation_id = ? LIMIT 1`,
        [organisationId],
      );
      const row = rows?.[0];
      return row ? {
        legacyTenantId: row.legacy_tenant_id, legacyTenantSlug: row.legacy_tenant_slug,
        migrationStatus: row.migration_status, verifiedAt: row.verified_at || null,
      } : null;
    },

    async upgradePasswordHash({ credentialId, previousHash, passwordHash, parameters, version }, { executor } = {}) {
      const [result] = await executorOr(defaultExecutor, executor).execute(
        `UPDATE credential_identities SET password_hash = ?, password_algorithm = 'argon2id',
          password_parameters = ?, password_version = ?, password_changed_at = UTC_TIMESTAMP(3),
          failed_attempt_count = 0, locked_until = NULL
         WHERE credential_id = ? AND password_hash = ?`,
        [passwordHash, JSON.stringify(parameters), version, credentialId, previousHash],
      );
      return result.affectedRows === 1;
    },

    async recordCredentialFailure(credentialId, { lockedUntil = null } = {}, { executor } = {}) {
      await executorOr(defaultExecutor, executor).execute(
        `UPDATE credential_identities SET failed_attempt_count = failed_attempt_count + 1,
          locked_until = CASE WHEN ? IS NOT NULL THEN ? ELSE locked_until END
         WHERE credential_id = ?`,
        [lockedUntil, lockedUntil, credentialId],
      );
    },

    async clearCredentialFailures(credentialId, { executor } = {}) {
      await executorOr(defaultExecutor, executor).execute(
        "UPDATE credential_identities SET failed_attempt_count = 0, locked_until = NULL WHERE credential_id = ?",
        [credentialId],
      );
    },

    async createSession(input, { executor } = {}) {
      const sessionId = input.sessionId || crypto.randomUUID();
      await executorOr(defaultExecutor, executor).execute(
        `INSERT INTO login_sessions
          (session_id, hashed_bearer_secret, csrf_token_hash, signing_key_id, user_id, organisation_id,
           membership_id, credential_id, issued_at, last_activity_at, idle_expires_at, absolute_expires_at,
           authorization_version, rotation_generation, rotated_from_session_id, client_metadata)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [sessionId, input.hashedBearerSecret, input.csrfTokenHash, input.signingKeyId, input.userId,
          input.organisationId, input.membershipId, input.credentialId || null, input.issuedAt,
          input.lastActivityAt, input.idleExpiresAt, input.absoluteExpiresAt, input.authorizationVersion,
          input.rotationGeneration || 1, input.rotatedFromSessionId || null,
          input.clientMetadata ? JSON.stringify(input.clientMetadata) : null],
      );
      return { sessionId };
    },

    async getSessionByBearerHash(hashedBearerSecret, { executor } = {}) {
      const [rows] = await executorOr(defaultExecutor, executor).execute(
        "SELECT * FROM login_sessions WHERE hashed_bearer_secret = ? LIMIT 1",
        [hashedBearerSecret],
      );
      return mapSession(rows?.[0]);
    },

    async touchSession(sessionId, { lastActivityAt, idleExpiresAt }, { executor } = {}) {
      await executorOr(defaultExecutor, executor).execute(
        "UPDATE login_sessions SET last_activity_at = ?, idle_expires_at = ? WHERE session_id = ? AND revoked_at IS NULL",
        [lastActivityAt, idleExpiresAt, sessionId],
      );
    },

    async rotateCsrfToken(sessionId, csrfTokenHash, { executor } = {}) {
      await executorOr(defaultExecutor, executor).execute(
        "UPDATE login_sessions SET csrf_token_hash = ? WHERE session_id = ? AND revoked_at IS NULL",
        [csrfTokenHash, sessionId],
      );
    },

    async revokeSession(sessionId, reason, { executor } = {}) {
      const [result] = await executorOr(defaultExecutor, executor).execute(
        "UPDATE login_sessions SET revoked_at = COALESCE(revoked_at, UTC_TIMESTAMP(3)), revocation_reason = COALESCE(revocation_reason, ?) WHERE session_id = ?",
        [reason, sessionId],
      );
      return result.affectedRows > 0;
    },

    async revokeSessionsBy(scope, id, reason, { executor } = {}) {
      const columns = { user: "user_id", membership: "membership_id", organisation: "organisation_id", credential: "credential_id" };
      const column = columns[scope];
      if (!column) throw new TypeError("Unsupported session revocation scope.");
      const [result] = await executorOr(defaultExecutor, executor).execute(
        `UPDATE login_sessions SET revoked_at = UTC_TIMESTAMP(3), revocation_reason = ? WHERE ${column} = ? AND revoked_at IS NULL`,
        [reason, id],
      );
      return Number(result.affectedRows || 0);
    },

    async getThrottleBucket(bucketKey, { executor } = {}) {
      const [rows] = await executorOr(defaultExecutor, executor).execute(
        "SELECT * FROM login_throttle_buckets WHERE bucket_key = ? LIMIT 1",
        [bucketKey],
      );
      return rows?.[0] || null;
    },

    async recordThrottleFailure(input, { executor } = {}) {
      const db = executorOr(defaultExecutor, executor);
      await db.execute(
        `INSERT INTO login_throttle_buckets
          (bucket_key, source_network_hash, organisation_slug_hash, username_hash, failure_count,
           window_started_at, last_failure_at, blocked_until)
         VALUES (?, ?, ?, ?, 1, ?, ?, ?)
         ON DUPLICATE KEY UPDATE
          failure_count = IF(window_started_at < ?, 1, failure_count + 1),
          window_started_at = IF(window_started_at < ?, VALUES(window_started_at), window_started_at),
          last_failure_at = VALUES(last_failure_at), blocked_until = VALUES(blocked_until)`,
        [input.bucketKey, input.sourceNetworkHash, input.organisationSlugHash, input.usernameHash,
          input.now, input.now, input.blockedUntil, input.windowCutoff, input.windowCutoff],
      );
      return this.getThrottleBucket(input.bucketKey, { executor: db });
    },

    async resetThrottle(bucketKey, { executor } = {}) {
      await executorOr(defaultExecutor, executor).execute("DELETE FROM login_throttle_buckets WHERE bucket_key = ?", [bucketKey]);
    },

    async recordAuthenticationEvent(input, { executor } = {}) {
      const safe = input.safeError ? safeErrorSummary(input.safeError) : null;
      const eventId = input.eventId || crypto.randomUUID();
      await executorOr(defaultExecutor, executor).execute(
        `INSERT INTO authentication_events
          (event_id, organisation_id, organisation_candidate_hash, user_id, credential_id, event_type,
           source_network_hash, user_agent_hash, correlation_id, result, failure_category)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [eventId, input.organisationId || null, input.organisationCandidateHash || null, input.userId || null,
          input.credentialId || null, input.eventType, input.sourceNetworkHash || null, input.userAgentHash || null,
          input.correlationId || null, input.result, input.failureCategory || safe?.summary || null],
      );
      return { eventId };
    },
  };
}
