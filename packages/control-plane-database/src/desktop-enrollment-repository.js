import crypto from "node:crypto";

import { executorOr } from "./transaction.js";

function parseJson(value) {
  if (value == null) return null;
  if (typeof value === "object" && !Buffer.isBuffer(value)) return value;
  try {
    return JSON.parse(Buffer.isBuffer(value) ? value.toString("utf8") : value);
  } catch {
    return null;
  }
}

function assertDigest(value, fieldName) {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) {
    throw new TypeError(`${fieldName} must be a lowercase SHA-256 digest.`);
  }
  return value;
}

function mapActivationKey(row) {
  if (!row) return null;
  return {
    activationKeyId: row.activation_key_id,
    organisationId: row.organisation_id,
    organisationDisplayName: row.display_name || null,
    organisationSlug: row.canonical_slug || null,
    organisationStatus: row.organisation_status || null,
    organisationActivationState: row.activation_state || null,
    organisationType: row.organisation_type || null,
    activationKeyHash: row.activation_key_hash,
    status: row.status,
    maximumUses: Number(row.maximum_uses),
    useCount: Number(row.use_count),
    issuedBy: row.issued_by,
    issuedAt: row.issued_at,
    expiresAt: row.expires_at,
    usedAt: row.used_at || null,
    revokedAt: row.revoked_at || null,
    revokedBy: row.revoked_by || null,
    revocationReason: row.revocation_reason || null,
    deviceLimit: row.device_limit == null ? null : Number(row.device_limit),
    offlineGraceDays: Number(row.offline_grace_days || 7),
  };
}

function mapDevice(row) {
  if (!row) return null;
  return {
    deviceEnrollmentId: row.device_enrollment_id,
    organisationId: row.organisation_id,
    organisationDisplayName: row.display_name || null,
    organisationSlug: row.canonical_slug || null,
    installationId: row.installation_id,
    devicePublicKey: parseJson(row.device_public_key),
    publicKeyThumbprint: row.public_key_thumbprint,
    status: row.status,
    documentVersion: Number(row.document_version),
    signingKeyId: row.signing_key_id,
    permittedApiOrigin: row.permitted_api_origin,
    environment: row.environment,
    activatedAt: row.activated_at,
    lastSeenAt: row.last_seen_at,
    expiresAt: row.expires_at,
    offlineGraceExpiresAt: row.offline_grace_expires_at,
    revokedAt: row.revoked_at || null,
    revokedBy: row.revoked_by || null,
    revocationReason: row.revocation_reason || null,
  };
}

function mapAudit(row) {
  return {
    desktopAuditEventId: row.desktop_audit_event_id,
    organisationId: row.organisation_id || null,
    activationKeyId: row.activation_key_id || null,
    deviceEnrollmentId: row.device_enrollment_id || null,
    actorType: row.actor_type,
    actorId: row.actor_id || null,
    action: row.action,
    outcome: row.outcome,
    failureCategory: row.failure_category || null,
    details: parseJson(row.event_details),
    correlationId: row.correlation_id || null,
    occurredAt: row.occurred_at,
  };
}

export function createDesktopEnrollmentRepository(defaultExecutor) {
  return {
    async getPolicy(organisationId, { executor } = {}) {
      const [rows] = await executorOr(defaultExecutor, executor).execute(
        `SELECT organisation_id, device_limit, activation_key_lifetime_hours, offline_grace_days
         FROM organisation_desktop_policies WHERE organisation_id = ? LIMIT 1`,
        [organisationId],
      );
      const row = rows?.[0];
      return row ? {
        organisationId: row.organisation_id,
        deviceLimit: Number(row.device_limit),
        activationKeyLifetimeHours: Number(row.activation_key_lifetime_hours),
        offlineGraceDays: Number(row.offline_grace_days),
      } : null;
    },

    async setPolicy({ organisationId, deviceLimit, activationKeyLifetimeHours, offlineGraceDays }, { executor } = {}) {
      await executorOr(defaultExecutor, executor).execute(
        `INSERT INTO organisation_desktop_policies
           (organisation_id, device_limit, activation_key_lifetime_hours, offline_grace_days)
         VALUES (?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE
           device_limit = VALUES(device_limit),
           activation_key_lifetime_hours = VALUES(activation_key_lifetime_hours),
           offline_grace_days = VALUES(offline_grace_days)`,
        [organisationId, deviceLimit, activationKeyLifetimeHours, offlineGraceDays],
      );
      return this.getPolicy(organisationId, { executor });
    },

    async createActivationKey(input, { executor } = {}) {
      if (Object.hasOwn(input, "activationKey") || Object.hasOwn(input, "rawKey")) {
        throw new TypeError("Raw organisation activation keys are not accepted by persistence.");
      }
      const activationKeyId = input.activationKeyId || crypto.randomUUID();
      await executorOr(defaultExecutor, executor).execute(
        `INSERT INTO organisation_activation_keys
           (activation_key_id, organisation_id, activation_key_hash, status, maximum_uses,
            use_count, issued_by, issued_at, expires_at)
         VALUES (?, ?, ?, 'pending', ?, 0, ?, ?, ?)`,
        [activationKeyId, input.organisationId, assertDigest(input.activationKeyHash, "activationKeyHash"),
          input.maximumUses || 1, input.issuedBy, input.issuedAt, input.expiresAt],
      );
      return { activationKeyId };
    },

    async getActivationKeyByHash(activationKeyHash, { executor, forUpdate = false } = {}) {
      const [rows] = await executorOr(defaultExecutor, executor).execute(
        `SELECT k.*, o.display_name, o.canonical_slug, o.organisation_type, o.status AS organisation_status,
                o.activation_state, p.device_limit,
                COALESCE(p.offline_grace_days, 7) AS offline_grace_days
         FROM organisation_activation_keys k
         JOIN organisations o ON o.organisation_id = k.organisation_id
         LEFT JOIN organisation_desktop_policies p ON p.organisation_id = k.organisation_id
         WHERE k.activation_key_hash = ? LIMIT 1${forUpdate ? " FOR UPDATE" : ""}`,
        [assertDigest(activationKeyHash, "activationKeyHash")],
      );
      return mapActivationKey(rows?.[0]);
    },

    async getActivationKeyById(activationKeyId, { executor } = {}) {
      const [rows] = await executorOr(defaultExecutor, executor).execute(
        `SELECT k.*, o.display_name, o.canonical_slug, o.organisation_type, o.status AS organisation_status,
                o.activation_state, p.device_limit,
                COALESCE(p.offline_grace_days, 7) AS offline_grace_days
         FROM organisation_activation_keys k
         JOIN organisations o ON o.organisation_id = k.organisation_id
         LEFT JOIN organisation_desktop_policies p ON p.organisation_id = k.organisation_id
         WHERE k.activation_key_id = ? LIMIT 1`,
        [activationKeyId],
      );
      return mapActivationKey(rows?.[0]);
    },

    async listActivationKeys(organisationId, { executor } = {}) {
      const [rows] = await executorOr(defaultExecutor, executor).execute(
        `SELECT k.* FROM organisation_activation_keys k
         WHERE k.organisation_id = ? ORDER BY k.issued_at DESC, k.activation_key_id DESC`,
        [organisationId],
      );
      return (rows || []).map(mapActivationKey).map(({ activationKeyHash: _hash, ...safe }) => safe);
    },

    async consumeActivationKey(activationKeyId, usedAt, { executor } = {}) {
      const [result] = await executorOr(defaultExecutor, executor).execute(
        `UPDATE organisation_activation_keys
         SET use_count = use_count + 1,
             used_at = COALESCE(used_at, ?),
             status = IF(use_count + 1 >= maximum_uses, 'used', status)
         WHERE activation_key_id = ? AND status = 'pending' AND expires_at > ?
           AND revoked_at IS NULL AND use_count < maximum_uses`,
        [usedAt, activationKeyId, usedAt],
      );
      return Number(result.affectedRows || 0) === 1;
    },

    async revokeActivationKey({ activationKeyId, organisationId, revokedBy, revokedAt, reason }, { executor } = {}) {
      const [result] = await executorOr(defaultExecutor, executor).execute(
        `UPDATE organisation_activation_keys
         SET status = 'revoked', revoked_at = ?, revoked_by = ?, revocation_reason = ?
         WHERE activation_key_id = ? AND organisation_id = ? AND status = 'pending'`,
        [revokedAt, revokedBy, reason || "administrative", activationKeyId, organisationId],
      );
      return Number(result.affectedRows || 0) === 1;
    },

    async countActiveDevices(organisationId, at, { executor } = {}) {
      const [rows] = await executorOr(defaultExecutor, executor).execute(
        `SELECT COUNT(*) AS total FROM desktop_device_enrollments
         WHERE organisation_id = ? AND status = 'active' AND revoked_at IS NULL AND expires_at > ?`,
        [organisationId, at],
      );
      return Number(rows?.[0]?.total || 0);
    },

    async lockOrganisationForDesktopEnrollment(organisationId, { executor } = {}) {
      const [rows] = await executorOr(defaultExecutor, executor).execute(
        "SELECT organisation_id, organisation_type, status, activation_state FROM organisations WHERE organisation_id = ? LIMIT 1 FOR UPDATE",
        [organisationId],
      );
      const row = rows?.[0];
      return row ? {
        organisationId: row.organisation_id,
        organisationType: row.organisation_type,
        status: row.status,
        activationState: row.activation_state,
      } : null;
    },

    async createDevice(input, { executor } = {}) {
      const deviceEnrollmentId = input.deviceEnrollmentId || crypto.randomUUID();
      await executorOr(defaultExecutor, executor).execute(
        `INSERT INTO desktop_device_enrollments
           (device_enrollment_id, organisation_id, activation_key_id, installation_id,
            device_public_key, public_key_thumbprint, status, document_version, signing_key_id,
            permitted_api_origin, environment, activated_at, last_seen_at, expires_at,
            offline_grace_expires_at)
         VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?, ?, ?)`,
        [deviceEnrollmentId, input.organisationId, input.activationKeyId, input.installationId,
          JSON.stringify(input.devicePublicKey), assertDigest(input.publicKeyThumbprint, "publicKeyThumbprint"),
          input.documentVersion, input.signingKeyId, input.permittedApiOrigin, input.environment,
          input.activatedAt, input.activatedAt, input.expiresAt, input.offlineGraceExpiresAt],
      );
      return { deviceEnrollmentId };
    },

    async getDeviceById(deviceEnrollmentId, { executor, forUpdate = false } = {}) {
      const [rows] = await executorOr(defaultExecutor, executor).execute(
        `SELECT d.*, o.display_name, o.canonical_slug
         FROM desktop_device_enrollments d
         JOIN organisations o ON o.organisation_id = d.organisation_id
         WHERE d.device_enrollment_id = ? LIMIT 1${forUpdate ? " FOR UPDATE" : ""}`,
        [deviceEnrollmentId],
      );
      return mapDevice(rows?.[0]);
    },

    async getDeviceByInstallationId(installationId, { executor, forUpdate = false } = {}) {
      const [rows] = await executorOr(defaultExecutor, executor).execute(
        `SELECT d.*, o.display_name, o.canonical_slug
         FROM desktop_device_enrollments d
         JOIN organisations o ON o.organisation_id = d.organisation_id
         WHERE d.installation_id = ? LIMIT 1${forUpdate ? " FOR UPDATE" : ""}`,
        [installationId],
      );
      return mapDevice(rows?.[0]);
    },

    async reactivateDevice(input, { executor } = {}) {
      const [result] = await executorOr(defaultExecutor, executor).execute(
        `UPDATE desktop_device_enrollments
         SET activation_key_id = ?, device_public_key = ?, public_key_thumbprint = ?,
             status = 'active', document_version = ?, signing_key_id = ?,
             permitted_api_origin = ?, environment = ?, activated_at = ?, last_seen_at = ?,
             expires_at = ?, offline_grace_expires_at = ?, revoked_at = NULL,
             revoked_by = NULL, revocation_reason = NULL
         WHERE device_enrollment_id = ? AND organisation_id = ?
           AND (status IN ('revoked', 'expired') OR expires_at <= ?)`,
        [input.activationKeyId, JSON.stringify(input.devicePublicKey),
          assertDigest(input.publicKeyThumbprint, "publicKeyThumbprint"), input.documentVersion,
          input.signingKeyId, input.permittedApiOrigin, input.environment, input.activatedAt,
          input.activatedAt, input.expiresAt, input.offlineGraceExpiresAt,
          input.deviceEnrollmentId, input.organisationId, input.activatedAt],
      );
      return Number(result.affectedRows || 0) === 1;
    },

    async listDevices(organisationId, { executor } = {}) {
      const [rows] = await executorOr(defaultExecutor, executor).execute(
        `SELECT d.*, o.display_name, o.canonical_slug
         FROM desktop_device_enrollments d
         JOIN organisations o ON o.organisation_id = d.organisation_id
         WHERE d.organisation_id = ? ORDER BY d.activated_at DESC, d.device_enrollment_id DESC`,
        [organisationId],
      );
      return (rows || []).map(mapDevice).map(({ devicePublicKey: _key, publicKeyThumbprint: _thumbprint, ...safe }) => safe);
    },

    async revokeDevice({ deviceEnrollmentId, organisationId, revokedBy, revokedAt, reason }, { executor } = {}) {
      const [result] = await executorOr(defaultExecutor, executor).execute(
        `UPDATE desktop_device_enrollments
         SET status = 'revoked', revoked_at = ?, revoked_by = ?, revocation_reason = ?
         WHERE device_enrollment_id = ? AND organisation_id = ? AND status = 'active'`,
        [revokedAt, revokedBy, reason || "administrative", deviceEnrollmentId, organisationId],
      );
      return Number(result.affectedRows || 0) === 1;
    },

    async touchDevice(deviceEnrollmentId, seenAt, { executor } = {}) {
      await executorOr(defaultExecutor, executor).execute(
        `UPDATE desktop_device_enrollments SET last_seen_at = ?
         WHERE device_enrollment_id = ? AND status = 'active'`,
        [seenAt, deviceEnrollmentId],
      );
    },

    async renewDeviceGrace({ deviceEnrollmentId, seenAt, offlineGraceExpiresAt }, { executor } = {}) {
      const [result] = await executorOr(defaultExecutor, executor).execute(
        `UPDATE desktop_device_enrollments
         SET last_seen_at = ?, offline_grace_expires_at = ?
         WHERE device_enrollment_id = ? AND status = 'active' AND revoked_at IS NULL
           AND expires_at > ?`,
        [seenAt, offlineGraceExpiresAt, deviceEnrollmentId, seenAt],
      );
      return Number(result.affectedRows || 0) === 1;
    },

    async consumeProofNonce({ nonceHash, deviceEnrollmentId, issuedAt, expiresAt }, { executor } = {}) {
      const db = executorOr(defaultExecutor, executor);
      try {
        await db.execute(
          `INSERT INTO desktop_device_proof_nonces
             (nonce_hash, device_enrollment_id, issued_at, expires_at)
           VALUES (?, ?, ?, ?)`,
          [assertDigest(nonceHash, "nonceHash"), deviceEnrollmentId, issuedAt, expiresAt],
        );
        return true;
      } catch (error) {
        if (error?.code === "ER_DUP_ENTRY") return false;
        throw error;
      }
    },

    async getActivationRateLimit(bucketKey, { executor } = {}) {
      const [rows] = await executorOr(defaultExecutor, executor).execute(
        "SELECT * FROM desktop_activation_rate_limits WHERE bucket_key = ? LIMIT 1",
        [assertDigest(bucketKey, "bucketKey")],
      );
      return rows?.[0] || null;
    },

    async recordActivationFailure({ bucketKey, sourceNetworkHash, now, blockedUntil, windowCutoff }, { executor } = {}) {
      await executorOr(defaultExecutor, executor).execute(
        `INSERT INTO desktop_activation_rate_limits
           (bucket_key, source_network_hash, failure_count, window_started_at, last_failure_at, blocked_until)
         VALUES (?, ?, 1, ?, ?, ?)
         ON DUPLICATE KEY UPDATE
           failure_count = IF(window_started_at < ?, 1, failure_count + 1),
           window_started_at = IF(window_started_at < ?, VALUES(window_started_at), window_started_at),
           last_failure_at = VALUES(last_failure_at), blocked_until = VALUES(blocked_until)`,
        [assertDigest(bucketKey, "bucketKey"), assertDigest(sourceNetworkHash, "sourceNetworkHash"),
          now, now, blockedUntil, windowCutoff, windowCutoff],
      );
    },

    async clearActivationRateLimit(bucketKey, { executor } = {}) {
      await executorOr(defaultExecutor, executor).execute(
        "DELETE FROM desktop_activation_rate_limits WHERE bucket_key = ?",
        [assertDigest(bucketKey, "bucketKey")],
      );
    },

    async recordAudit(input, { executor } = {}) {
      const desktopAuditEventId = input.desktopAuditEventId || crypto.randomUUID();
      await executorOr(defaultExecutor, executor).execute(
        `INSERT INTO desktop_activation_audit_events
           (desktop_audit_event_id, organisation_id, activation_key_id, device_enrollment_id,
            actor_type, actor_id, action, outcome, failure_category, event_details,
            source_network_hash, correlation_id, occurred_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [desktopAuditEventId, input.organisationId || null, input.activationKeyId || null,
          input.deviceEnrollmentId || null, input.actorType, input.actorId || null, input.action,
          input.outcome, input.failureCategory || null,
          input.details == null ? null : JSON.stringify(input.details), input.sourceNetworkHash || null,
          input.correlationId || null, input.occurredAt || new Date()],
      );
      return { desktopAuditEventId };
    },

    async listAudit(organisationId, { limit = 100, executor } = {}) {
      const safeLimit = Math.max(1, Math.min(500, Number(limit) || 100));
      const [rows] = await executorOr(defaultExecutor, executor).execute(
        `SELECT * FROM desktop_activation_audit_events
         WHERE organisation_id = ? ORDER BY occurred_at DESC, desktop_audit_event_id DESC
         LIMIT ${safeLimit}`,
        [organisationId],
      );
      return (rows || []).map(mapAudit);
    },
  };
}
