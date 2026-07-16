import { getPermissionsForRoles, parseRoles } from "../authorization-policy.js";

function normalizeHeaderValue(value) {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function createAnonymousAuthContext({ source = "anonymous" } = {}) {
  return Object.freeze({
    is_authenticated: false,
    user_id: null,
    roles: Object.freeze([]),
    permissions: new Set(),
    tenant_id: null,
    source,
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

export function resolveAuthContextFromHeaders({ request } = {}) {
  const userId = normalizeHeaderValue(request?.headers?.get("x-claimguard-user"));
  const roleHeader = normalizeHeaderValue(request?.headers?.get("x-claimguard-role"));
  const userTenantId = normalizeHeaderValue(request?.headers?.get("x-claimguard-user-tenant"));
  const roles = parseRoles(roleHeader || "");

  if (!userId || !roleHeader || !userTenantId) {
    const hasPartialHeaderContext = Boolean(userId || roleHeader || userTenantId);
    return createAnonymousAuthContext({
      source: hasPartialHeaderContext ? "incomplete_header" : "anonymous",
    });
  }

  return createAuthenticatedAuthContext({
    userId,
    roles,
    tenantId: userTenantId || tenantContext?.tenant_id || null,
    source: "header",
  });
}

export function createHeaderAuthenticationProvider() {
  return {
    async resolveAuthContext({ request }) {
      return resolveAuthContextFromHeaders({ request });
    },
  };
}
