import crypto from "node:crypto";

import { ControlPlaneConflictError } from "./errors.js";
import { executorOr } from "./transaction.js";

function mapRow(row) {
  if (!row) return null;
  return {
    mappingId: row.mapping_id,
    legacyTenantId: row.legacy_tenant_id,
    legacyTenantSlug: row.legacy_tenant_slug,
    organisationId: row.organisation_id,
    migrationStatus: row.migration_status,
    routeId: row.route_id || null,
    verifiedAt: row.verified_at || null,
    migrationMetadata: typeof row.migration_metadata === "string" ? JSON.parse(row.migration_metadata) : row.migration_metadata,
  };
}

export function createLegacyTenantMappingsRepository(defaultExecutor) {
  return {
    async create(input, { executor } = {}) {
      const db = executorOr(defaultExecutor, executor);
      const mappingId = input.mappingId || crypto.randomUUID();
      try {
        await db.execute(
          `INSERT INTO legacy_tenant_mappings
            (mapping_id, legacy_tenant_id, legacy_tenant_slug, organisation_id, migration_status, route_id, verified_at, migration_metadata)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [mappingId, input.legacyTenantId, input.legacyTenantSlug, input.organisationId, input.migrationStatus || "mapped",
            input.routeId || null, input.verifiedAt || null, input.migrationMetadata ? JSON.stringify(input.migrationMetadata) : null],
        );
      } catch (error) {
        if (error?.code === "ER_DUP_ENTRY" || error?.errno === 1062) {
          throw new ControlPlaneConflictError("Legacy tenant ID, slug, or organisation is already mapped.", "LEGACY_MAPPING_CONFLICT");
        }
        throw error;
      }
      return this.getByLegacyTenantId(input.legacyTenantId, { executor: db });
    },

    async getByLegacyTenantId(legacyTenantId, { executor } = {}) {
      const [rows] = await executorOr(defaultExecutor, executor).execute(
        "SELECT * FROM legacy_tenant_mappings WHERE legacy_tenant_id = ? LIMIT 1",
        [legacyTenantId],
      );
      return mapRow(rows?.[0]);
    },

    async getByOrganisationId(organisationId, { executor } = {}) {
      const [rows] = await executorOr(defaultExecutor, executor).execute(
        "SELECT * FROM legacy_tenant_mappings WHERE organisation_id = ? LIMIT 2",
        [organisationId],
      );
      return rows?.length === 1 ? mapRow(rows[0]) : null;
    },

    async list({ executor } = {}) {
      const [rows] = await executorOr(defaultExecutor, executor).execute("SELECT * FROM legacy_tenant_mappings ORDER BY legacy_tenant_id");
      return (rows || []).map(mapRow);
    },
  };
}
