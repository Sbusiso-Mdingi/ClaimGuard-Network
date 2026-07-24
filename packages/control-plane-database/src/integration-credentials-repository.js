import crypto from "node:crypto";

import { ControlPlaneConflictError, ControlPlaneNotFoundError } from "./errors.js";
import { executorOr } from "./transaction.js";

const SHA256_PATTERN = /^[a-f0-9]{64}$/;

function mapCredential(row) {
  if (!row) return null;
  return {
    integrationCredentialId: row.integration_credential_id,
    organisationId: row.organisation_id,
    displayName: row.display_name,
    serviceActorId: row.service_actor_id,
    tokenPrefix: row.token_prefix,
    roleKey: row.role_key,
    status: row.status,
    expiresAt: row.expires_at || null,
    lastUsedAt: row.last_used_at || null,
    lastUsedCorrelationId: row.last_used_correlation_id || null,
    revokedAt: row.revoked_at || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function requireHash(value) {
  if (!SHA256_PATTERN.test(String(value || ""))) {
    throw new TypeError("tokenHash must be a SHA-256 hex digest.");
  }
  return value;
}

function activeRouteIsUsable(route) {
  return Boolean(
    route
      && !route.retired_at
      && route.provisioning_status === "active"
      && !["suspended", "unreachable"].includes(route.health_status),
  );
}

export function createIntegrationCredentialsRepository(defaultExecutor) {
  return {
    async create(input, { executor } = {}) {
      const db = executorOr(defaultExecutor, executor);
      const integrationCredentialId = input.integrationCredentialId || crypto.randomUUID();
      const displayName = String(input.displayName || "Claims server").trim().slice(0, 128);
      const serviceActorId = String(input.serviceActorId || "").trim().toLowerCase().slice(0, 128);
      const tokenPrefix = String(input.tokenPrefix || "").trim().slice(0, 24);
      if (!displayName || !serviceActorId || !tokenPrefix) {
        throw new TypeError("displayName, serviceActorId, and tokenPrefix are required.");
      }
      try {
        await db.execute(
          `INSERT INTO organisation_integration_credentials
            (integration_credential_id, organisation_id, display_name, service_actor_id,
             token_prefix, token_hash, role_key, created_by, expires_at)
           VALUES (?, ?, ?, ?, ?, ?, 'claims_analyst', ?, ?)`,
          [integrationCredentialId, input.organisationId, displayName, serviceActorId,
            tokenPrefix, requireHash(input.tokenHash), input.createdBy || null, input.expiresAt || null],
        );
      } catch (error) {
        if (error?.code === "ER_DUP_ENTRY" || error?.errno === 1062) {
          throw new ControlPlaneConflictError(
            "An active integration with that service actor already exists.",
            "INTEGRATION_CREDENTIAL_CONFLICT",
          );
        }
        throw error;
      }
      return this.getById(integrationCredentialId, { executor: db });
    },

    async getById(integrationCredentialId, { executor } = {}) {
      const [rows] = await executorOr(defaultExecutor, executor).execute(
        "SELECT * FROM organisation_integration_credentials WHERE integration_credential_id = ? LIMIT 1",
        [integrationCredentialId],
      );
      return mapCredential(rows?.[0]);
    },

    async listForOrganisation(organisationId, { executor } = {}) {
      const [rows] = await executorOr(defaultExecutor, executor).execute(
        `SELECT * FROM organisation_integration_credentials
         WHERE organisation_id = ? ORDER BY created_at DESC`,
        [organisationId],
      );
      return (rows || []).map(mapCredential);
    },

    async resolveActiveByTokenHash(tokenHash, { executor } = {}) {
      const db = executorOr(defaultExecutor, executor);
      const [credentialRows] = await db.execute(
        `SELECT c.*, o.status AS organisation_status, o.activation_state,
                o.organisation_type, o.canonical_slug
         FROM organisation_integration_credentials c
         JOIN organisations o ON o.organisation_id = c.organisation_id
         WHERE c.token_hash = ? AND c.status = 'active'
           AND (c.expires_at IS NULL OR c.expires_at > UTC_TIMESTAMP(3))
         LIMIT 2`,
        [requireHash(tokenHash)],
      );
      if ((credentialRows || []).length !== 1) return null;

      const credential = credentialRows[0];
      if (credential.organisation_type !== "medical_scheme"
        || credential.organisation_status !== "active"
        || credential.activation_state !== "activated") {
        return null;
      }

      const [routeRows] = await db.execute(
        `SELECT route_id, route_type, provisioning_status, health_status,
                retired_at, active_at
         FROM data_plane_routes
         WHERE organisation_id = ?
           AND active_route_slot = organisation_id
         ORDER BY route_generation DESC
         LIMIT 2`,
        [credential.organisation_id],
      );
      if ((routeRows || []).length !== 1) return null;

      const route = routeRows[0];
      if (!activeRouteIsUsable(route)) return null;

      let tenantId = null;
      if (route.route_type === "private_database") {
        if (!route.active_at || !credential.canonical_slug) return null;
        tenantId = credential.organisation_id;
      } else if (route.route_type === "legacy_shared") {
        const [mappingRows] = await db.execute(
          `SELECT legacy_tenant_id, migration_status, verified_at
           FROM legacy_tenant_mappings
           WHERE organisation_id = ?
             AND route_id = ?
           LIMIT 2`,
          [credential.organisation_id, route.route_id],
        );
        if ((mappingRows || []).length !== 1) return null;

        const mapping = mappingRows[0];
        if (mapping.migration_status !== "verified"
          || !mapping.verified_at
          || !mapping.legacy_tenant_id) {
          return null;
        }
        tenantId = mapping.legacy_tenant_id;
      } else {
        return null;
      }

      return {
        ...mapCredential(credential),
        tenantId,
      };
    },

    async recordUse(integrationCredentialId, correlationId, { executor } = {}) {
      await executorOr(defaultExecutor, executor).execute(
        `UPDATE organisation_integration_credentials
         SET last_used_at = UTC_TIMESTAMP(3), last_used_correlation_id = ?
         WHERE integration_credential_id = ? AND status = 'active'`,
        [correlationId ? String(correlationId).slice(0, 128) : null, integrationCredentialId],
      );
    },

    async revoke({ integrationCredentialId, organisationId, revokedBy = null }, { executor } = {}) {
      const db = executorOr(defaultExecutor, executor);
      const [result] = await db.execute(
        `UPDATE organisation_integration_credentials
         SET status = 'revoked', revoked_at = COALESCE(revoked_at, UTC_TIMESTAMP(3)),
             revoked_by = COALESCE(revoked_by, ?)
         WHERE integration_credential_id = ? AND organisation_id = ? AND status = 'active'`,
        [revokedBy, integrationCredentialId, organisationId],
      );
      if (result.affectedRows !== 1) {
        throw new ControlPlaneNotFoundError(
          "Active integration credential was not found.",
          "INTEGRATION_CREDENTIAL_NOT_FOUND",
        );
      }
      return this.getById(integrationCredentialId, { executor: db });
    },
  };
}
