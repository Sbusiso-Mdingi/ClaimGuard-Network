import { LEGACY_DEFAULT_TENANT_ID, LEGACY_DEFAULT_TENANT_SLUG } from "@claimguard/database";

export function createTenantContext({ tenant_id = null, tenant_slug = null, scheme_id = null, source }) {
  return Object.freeze({
    tenant_id,
    tenant_slug,
    scheme_id,
    source,
  });
}

function normalizeHeaderValue(value) {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export async function resolveTenantContext({
  request,
  tenantRepository = null,
  defaultTenantId = process.env.DEFAULT_TENANT_ID || null,
  nodeEnv = process.env.NODE_ENV || "development",
  legacyDefaultTenantId = LEGACY_DEFAULT_TENANT_ID,
} = {}) {
  const isDevelopment = nodeEnv !== "production";
  const requestTenantHeader = normalizeHeaderValue(request?.headers?.get("x-claimguard-tenant"));

  if (requestTenantHeader && isDevelopment && tenantRepository) {
    const byId = await tenantRepository.lookupTenantById(requestTenantHeader);
    const bySlug = byId ? null : await tenantRepository.lookupTenantBySlug(requestTenantHeader);
    const tenant = byId || bySlug;

    if (tenant) {
      return createTenantContext({
        tenant_id: tenant.tenant_id,
        tenant_slug: tenant.tenant_slug,
        scheme_id: tenant.scheme_id || null,
        source: "header",
      });
    }
  }

  if (defaultTenantId && tenantRepository) {
    const configured = await tenantRepository.lookupTenantById(defaultTenantId);
    if (configured) {
      return createTenantContext({
        tenant_id: configured.tenant_id,
        tenant_slug: configured.tenant_slug,
        scheme_id: configured.scheme_id || null,
        source: "default_config",
      });
    }
  }

  if (tenantRepository) {
    const legacyDefault = await tenantRepository.getDefaultTenant({
      defaultTenantId: legacyDefaultTenantId,
    });

    if (legacyDefault) {
      return createTenantContext({
        tenant_id: legacyDefault.tenant_id,
        tenant_slug: legacyDefault.tenant_slug,
        scheme_id: legacyDefault.scheme_id || null,
        source: "legacy_fallback",
      });
    }
  }

  const fallbackTenantId = defaultTenantId || legacyDefaultTenantId || null;
  const fallbackTenantSlug =
    fallbackTenantId === LEGACY_DEFAULT_TENANT_ID ? LEGACY_DEFAULT_TENANT_SLUG : null;

  return createTenantContext({
    tenant_id: fallbackTenantId,
    tenant_slug: fallbackTenantSlug,
    scheme_id: null,
    source: "legacy_fallback",
  });
}