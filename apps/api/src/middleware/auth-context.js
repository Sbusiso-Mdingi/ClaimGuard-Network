import { getPermissionsForRoles, parseRoles } from "../authorization-policy.js";

function normalizeHeaderValue(value) {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function createAnonymousAuthContext({ tenantContext = null } = {}) {
  return Object.freeze({
    is_authenticated: false,
    user_id: null,
    roles: Object.freeze([]),
    permissions: new Set(),
    tenant_id: tenantContext?.tenant_id || null,
    source: "anonymous",
  });
}

export function createAuthenticatedAuthContext({
  userId,
  roles,
  tenantId,
  source = "header",
} = {}) {
  const normalizedRoles = Object.freeze([...(roles || [])]);

  return Object.freeze({
    is_authenticated: true,
    user_id: userId,
    roles: normalizedRoles,
    permissions: getPermissionsForRoles(normalizedRoles),
    tenant_id: tenantId || null,
    source,
  });
}

export function resolveAuthContextFromHeaders({ request, tenantContext = null } = {}) {
  const userId = normalizeHeaderValue(request?.headers?.get("x-claimguard-user"));
  if (!userId) {
    return createAnonymousAuthContext({ tenantContext });
  }

  const roleHeader = normalizeHeaderValue(request?.headers?.get("x-claimguard-role"));
  const userTenantId = normalizeHeaderValue(request?.headers?.get("x-claimguard-user-tenant"));
  const roles = parseRoles(roleHeader || "");

  return createAuthenticatedAuthContext({
    userId,
    roles,
    tenantId: userTenantId || tenantContext?.tenant_id || null,
    source: "header",
  });
}

export function createHeaderAuthenticationProvider() {
  return {
    async resolveAuthContext({ request, tenantContext }) {
      return resolveAuthContextFromHeaders({ request, tenantContext });
    },
  };
}
