import { ForbiddenError, TenantMismatchError } from "./application-errors.js";

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
  authContext = null,
  tenantRepository = null,
} = {}) {
  if (!authContext?.is_authenticated) {
    return createTenantContext({
      tenant_id: null,
      tenant_slug: null,
      scheme_id: null,
      source: "anonymous",
    });
  }

  const membershipTenant = normalizeHeaderValue(authContext.tenant_id);
  if (!membershipTenant) {
    if (authContext.organisation?.organisationType === "platform") {
      return createTenantContext({ tenant_id: null, tenant_slug: null, scheme_id: null, source: "platform_no_private_tenant" });
    }
    throw new ForbiddenError("Authenticated operational tenant mapping is required.");
  }

  const requestTenantHeader = authContext.source === "session"
    ? null
    : normalizeHeaderValue(request?.headers?.get("x-claimguard-tenant"));
  let tenant = null;

  if (tenantRepository) {
    const byId = await tenantRepository.lookupTenantById(membershipTenant);
    const bySlug = byId ? null : await tenantRepository.lookupTenantBySlug(membershipTenant);
    tenant = byId || bySlug;

    if (!tenant) {
      throw new ForbiddenError("Authenticated tenant membership could not be resolved.");
    }
  } else {
    tenant = {
      tenant_id: membershipTenant,
      tenant_slug: null,
      scheme_id: null,
    };
  }

  if (requestTenantHeader) {
    let requestedTenantId = requestTenantHeader;

    if (tenantRepository) {
      const requestedById = await tenantRepository.lookupTenantById(requestTenantHeader);
      const requestedBySlug = requestedById
        ? null
        : await tenantRepository.lookupTenantBySlug(requestTenantHeader);
      requestedTenantId = (requestedById || requestedBySlug)?.tenant_id || null;
    }

    if (!requestedTenantId || requestedTenantId !== tenant.tenant_id) {
      throw new TenantMismatchError();
    }
  }

  return createTenantContext({
    tenant_id: tenant.tenant_id,
    tenant_slug: tenant.tenant_slug || null,
    scheme_id: tenant.scheme_id || null,
    source: "authenticated_membership",
  });
}
