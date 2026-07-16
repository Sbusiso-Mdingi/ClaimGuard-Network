export const LEGACY_DEFAULT_TENANT_ID = "tenant_default";
export const LEGACY_DEFAULT_TENANT_SLUG = "default";

function normalizeTenantRow(row, schemeId = null) {
  if (!row) {
    return null;
  }

  return {
    tenant_id: row.tenant_id,
    tenant_slug: row.tenant_slug,
    tenant_name: row.tenant_name,
    status: row.status,
    scheme_id: schemeId,
  };
}

export function createTenantRepository(pool, { dataPlaneContext = null, allowLegacyDefault = false } = {}) {
  if (!pool || typeof pool.query !== "function") {
    throw new Error("A mysql2 pool with query support is required for tenant repository.");
  }
  const canonicalTenantId = dataPlaneContext?.operationalTenantId || null;

  function scoped(row) {
    const tenant = normalizeTenantRow(row);
    return canonicalTenantId && tenant?.tenant_id !== canonicalTenantId ? null : tenant;
  }

  return {
    async lookupTenantById(tenantId) {
      if (!tenantId) {
        return null;
      }

      const [rows] = await pool.query(
        `
          SELECT tenant_id, tenant_slug, tenant_name, status
          FROM tenants
          WHERE tenant_id = ?
          LIMIT 1
        `,
        [tenantId],
      );

      return scoped(rows?.[0] ?? null);
    },

    async lookupTenantBySlug(tenantSlug) {
      if (!tenantSlug) {
        return null;
      }

      const [rows] = await pool.query(
        `
          SELECT tenant_id, tenant_slug, tenant_name, status
          FROM tenants
          WHERE tenant_slug = ?
          LIMIT 1
        `,
        [tenantSlug],
      );

      return scoped(rows?.[0] ?? null);
    },

    async lookupTenantBySchemeId(schemeId) {
      if (!schemeId) {
        return null;
      }

      const [medicalSchemeRows] = await pool.query(
        `
          SELECT t.tenant_id, t.tenant_slug, t.tenant_name, t.status
          FROM medical_schemes ms
          JOIN tenants t ON t.tenant_id = ms.tenant_id
          WHERE ms.scheme_id = ?
          LIMIT 1
        `,
        [schemeId],
      );

      if (medicalSchemeRows?.[0]) {
        const tenant = scoped(medicalSchemeRows[0]);
        return tenant ? { ...tenant, scheme_id: schemeId } : null;
      }

      const [legacySchemeRows] = await pool.query(
        `
          SELECT t.tenant_id, t.tenant_slug, t.tenant_name, t.status
          FROM schemes s
          JOIN tenants t ON t.tenant_id = s.tenant_id
          WHERE s.scheme_id = ?
          LIMIT 1
        `,
        [schemeId],
      );

      const tenant = scoped(legacySchemeRows?.[0] ?? null);
      return tenant ? { ...tenant, scheme_id: schemeId } : null;
    },

    async getDefaultTenant({ defaultTenantId = null } = {}) {
      if (!allowLegacyDefault) {
        const error = new Error("Implicit default tenant selection is disabled for routed operational access.");
        error.code = "IMPLICIT_TENANT_FALLBACK_DISABLED";
        throw error;
      }
      if (defaultTenantId) {
        const configuredTenant = await this.lookupTenantById(defaultTenantId);
        if (configuredTenant) {
          return configuredTenant;
        }
      }

      const slugDefault = await this.lookupTenantBySlug(LEGACY_DEFAULT_TENANT_SLUG);
      if (slugDefault) {
        return slugDefault;
      }

      return this.lookupTenantById(LEGACY_DEFAULT_TENANT_ID);
    },

    async validateTenantExists(tenantId) {
      const tenant = await this.lookupTenantById(tenantId);
      return Boolean(tenant);
    },
  };
}
