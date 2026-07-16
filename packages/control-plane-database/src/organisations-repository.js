import crypto from "node:crypto";

import { ControlPlaneConflictError } from "./errors.js";
import { executorOr } from "./transaction.js";
import { normalizeOrganisationSlug, ORGANISATION_STATUSES, ORGANISATION_TYPES, requireEnum } from "./validation.js";

function mapOrganisation(row) {
  if (!row) return null;
  return {
    organisationId: row.organisation_id,
    displayName: row.display_name,
    canonicalSlug: row.canonical_slug,
    organisationType: row.organisation_type,
    deploymentClass: row.deployment_class,
    status: row.status,
    activationState: row.activation_state,
    legacyMappingStatus: row.legacy_mapping_status,
    metadataVersion: Number(row.metadata_version),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    activatedAt: row.activated_at || null,
    suspendedAt: row.suspended_at || null,
    suspensionReason: row.suspension_reason || null,
  };
}

function duplicateToConflict(error, message) {
  if (error?.code === "ER_DUP_ENTRY" || error?.errno === 1062) {
    throw new ControlPlaneConflictError(message, "ORGANISATION_CONFLICT");
  }
  throw error;
}

export function createOrganisationsRepository(defaultExecutor) {
  return {
    async createDraft({ organisationId = crypto.randomUUID(), displayName, canonicalSlug, organisationType, deploymentClass }, { executor } = {}) {
      const slug = normalizeOrganisationSlug(canonicalSlug);
      requireEnum(organisationType, ORGANISATION_TYPES, "organisation_type");
      requireEnum(deploymentClass, ["local", "demo", "pilot", "production"], "deployment_class");
      const db = executorOr(defaultExecutor, executor);
      try {
        await db.execute(
          `INSERT INTO organisations
            (organisation_id, display_name, canonical_slug, organisation_type, deployment_class, status, activation_state)
           VALUES (?, ?, ?, ?, ?, 'draft', 'not_activated')`,
          [organisationId, String(displayName || "").trim(), slug, organisationType, deploymentClass],
        );
        await db.execute(
          `INSERT INTO organisation_slugs (slug, organisation_id, slug_type, status)
           VALUES (?, ?, 'canonical', 'active')`,
          [slug, organisationId],
        );
      } catch (error) {
        duplicateToConflict(error, "Organisation ID or canonical slug already exists.");
      }
      return this.getById(organisationId, { executor: db });
    },

    async getById(organisationId, { executor } = {}) {
      const [rows] = await executorOr(defaultExecutor, executor).execute(
        "SELECT * FROM organisations WHERE organisation_id = ? LIMIT 1",
        [organisationId],
      );
      return mapOrganisation(rows?.[0]);
    },

    async getBySlug(slug, { executor } = {}) {
      const normalized = normalizeOrganisationSlug(slug);
      const [rows] = await executorOr(defaultExecutor, executor).execute(
        `SELECT o.* FROM organisation_slugs s
         JOIN organisations o ON o.organisation_id = s.organisation_id
         WHERE s.slug = ? AND s.status IN ('active', 'redirect') LIMIT 1`,
        [normalized],
      );
      return mapOrganisation(rows?.[0]);
    },

    async reserveSlug(slug, { organisationId = null, slugType = "reserved", redirectToSlug = null, executor } = {}) {
      const normalized = normalizeOrganisationSlug(slug);
      requireEnum(slugType, ["canonical", "alias", "reserved"], "slug_type");
      if ((slugType === "canonical" || slugType === "alias") && !organisationId) {
        throw new TypeError(`${slugType} slugs require an organisationId.`);
      }
      if (slugType === "alias" && !redirectToSlug) throw new TypeError("Alias slugs require redirectToSlug.");
      const redirect = redirectToSlug ? normalizeOrganisationSlug(redirectToSlug) : null;
      const db = executorOr(defaultExecutor, executor);
      try {
        await db.execute(
          `INSERT INTO organisation_slugs (slug, organisation_id, slug_type, status, redirect_to_slug)
           VALUES (?, ?, ?, ?, ?)`,
          [normalized, organisationId, slugType, slugType === "alias" ? "redirect" : slugType === "canonical" ? "active" : "reserved", redirect],
        );
      } catch (error) {
        duplicateToConflict(error, "Organisation slug is already reserved.");
      }
      return normalized;
    },

    async updateStatus(organisationId, status, { suspensionReason = null, executor } = {}) {
      requireEnum(status, ORGANISATION_STATUSES, "organisation_status");
      const db = executorOr(defaultExecutor, executor);
      await db.execute(
        `UPDATE organisations SET status = ?,
           activation_state = CASE
             WHEN ? = 'active' THEN 'activated'
             WHEN ? = 'suspended' THEN 'suspended'
             WHEN ? = 'archived' THEN 'deactivated'
             ELSE activation_state
           END,
           activated_at = CASE WHEN ? = 'active' THEN COALESCE(activated_at, UTC_TIMESTAMP(3)) ELSE activated_at END,
           suspended_at = CASE WHEN ? = 'suspended' THEN UTC_TIMESTAMP(3) ELSE suspended_at END,
           suspension_reason = CASE WHEN ? = 'suspended' THEN ? ELSE suspension_reason END,
           metadata_version = metadata_version + 1
         WHERE organisation_id = ?`,
        [status, status, status, status, status, status, status, suspensionReason, organisationId],
      );
      return this.getById(organisationId, { executor: db });
    },

    async count({ executor } = {}) {
      const [rows] = await executorOr(defaultExecutor, executor).execute("SELECT COUNT(*) AS count FROM organisations");
      return Number(rows?.[0]?.count || 0);
    },

    async list({ executor } = {}) {
      const [rows] = await executorOr(defaultExecutor, executor).execute("SELECT * FROM organisations ORDER BY canonical_slug");
      return (rows || []).map(mapOrganisation);
    },
  };
}
