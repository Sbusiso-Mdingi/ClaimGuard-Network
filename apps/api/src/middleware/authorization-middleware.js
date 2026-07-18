import { createHeaderAuthenticationProvider } from "./auth-context.js";
import {
  evaluateTenantAccess,
  getOperationalRoutePolicyById,
  hasPermission,
  resolveOperationalRoutePermissionRequirement,
} from "../authorization-policy.js";
import {
  applicationErrorResponse,
  ForbiddenError,
  TenantMismatchError,
  UnauthenticatedError,
} from "../application-errors.js";

const OPERATIONAL_POLICY_PAYLOAD_CACHE_KEY = "operationalPolicyPayload";

function normalizeDistinctSchemeIds(schemeIds) {
  const normalized = (schemeIds || [])
    .filter((schemeId) => typeof schemeId === "string")
    .map((schemeId) => schemeId.trim())
    .filter(Boolean);

  return [...new Set(normalized)];
}

async function resolveResourceTenantIds({ tenantRepository, resourceSchemeIds }) {
  const schemeIds = normalizeDistinctSchemeIds(resourceSchemeIds);

  if (schemeIds.length === 0 || typeof tenantRepository?.lookupTenantBySchemeId !== "function") {
    return {
      tenantIds: [],
      unresolvedSchemeIds: [],
    };
  }

  const resolvedTenants = await Promise.all(
    schemeIds.map(async (schemeId) => ({
      schemeId,
      tenant: await tenantRepository.lookupTenantBySchemeId(schemeId),
    })),
  );

  return {
    tenantIds: resolvedTenants
      .map(({ tenant }) => tenant?.tenant_id || null)
      .filter(Boolean),
    unresolvedSchemeIds: resolvedTenants
      .filter(({ tenant }) => !tenant?.tenant_id)
      .map(({ schemeId }) => schemeId),
  };
}

export function createAuthenticationMiddleware({
  authenticationProvider = createHeaderAuthenticationProvider(),
} = {}) {
  return async (c, next) => {
    try {
      const resolved = await authenticationProvider.resolveAuthContext({ request: c.req.raw, tenantContext: null });
      const authContext = resolved?.authContext || resolved;
      c.set("authContext", authContext);
      c.set("resolvedSession", resolved?.resolvedSession || null);
      c.set("authenticationMetadata", resolved?.metadata || {});
      c.set("dataPlaneOrganisationToRetire", resolved?.dataPlaneOrganisationToRetire || null);
      c.req.raw.authContext = authContext;
      await next();
    } catch (error) {
      if (error?.status) return applicationErrorResponse(c, error);
      throw error;
    }
  };
}

export function createRequirePermissionMiddleware({ permission } = {}) {
  return async (c, next) => {
    const authContext = c.get("authContext") || null;

    if (!authContext?.is_authenticated) {
      return applicationErrorResponse(c, new UnauthenticatedError());
    }

    if (!hasPermission(authContext, permission)) {
      return applicationErrorResponse(c, new ForbiddenError());
    }

    await next();
  };
}

async function getOperationalPolicyPayload(c) {
  const cached = c.get(OPERATIONAL_POLICY_PAYLOAD_CACHE_KEY);
  if (cached !== undefined) return cached;

  const method = String(c.req.method || "GET").toUpperCase();
  if (!["POST", "PUT", "PATCH", "DELETE"].includes(method)) {
    c.set(OPERATIONAL_POLICY_PAYLOAD_CACHE_KEY, null);
    return null;
  }

  const contentType = String(c.req.header("content-type") || "").toLowerCase();
  if (!contentType.includes("application/json")) {
    c.set(OPERATIONAL_POLICY_PAYLOAD_CACHE_KEY, null);
    return null;
  }

  let payload = null;
  try {
    payload = await c.req.raw.clone().json();
  } catch {
    payload = null;
  }
  c.set(OPERATIONAL_POLICY_PAYLOAD_CACHE_KEY, payload);
  return payload;
}

function isPermissionRequirementSatisfied(authContext, requirement) {
  if (!requirement.permissions.length) return true;
  if (requirement.mode === "any") {
    return requirement.permissions.some((permission) => hasPermission(authContext, permission));
  }
  return requirement.permissions.every((permission) => hasPermission(authContext, permission));
}

export async function authorizeOperationalRouteRequest({ c, routePolicy } = {}) {
  const authContext = c.get("authContext") || null;
  if (!authContext?.is_authenticated) {
    return {
      ok: false,
      response: applicationErrorResponse(c, new UnauthenticatedError()),
    };
  }

  const payload = await getOperationalPolicyPayload(c);
  const requirement = resolveOperationalRoutePermissionRequirement({ routePolicy, payload });
  if (isPermissionRequirementSatisfied(authContext, requirement)) {
    return { ok: true, requirement };
  }

  return {
    ok: false,
    response: applicationErrorResponse(c, new ForbiddenError()),
  };
}

export function createRequireOperationalRouteAuthorizationMiddleware({ routeId } = {}) {
  const routePolicy = getOperationalRoutePolicyById(routeId);
  if (!routePolicy) throw new TypeError(`Unknown operational route policy id: ${routeId || "(empty)"}`);
  return async (c, next) => {
    const decision = await authorizeOperationalRouteRequest({ c, routePolicy });
    if (!decision.ok) return decision.response;
    await next();
  };
}

function createPermissionFailureResponse(c, permissions, mode) {
  const authContext = c.get("authContext") || null;

  if (!authContext?.is_authenticated) {
    return applicationErrorResponse(c, new UnauthenticatedError());
  }

  const permitted =
    mode === "any"
      ? permissions.some((permission) => hasPermission(authContext, permission))
      : permissions.every((permission) => hasPermission(authContext, permission));

  if (!permitted) {
    return applicationErrorResponse(c, new ForbiddenError());
  }

  return null;
}

export function createRequireAnyPermissionMiddleware({ permissions = [] } = {}) {
  return async (c, next) => {
    const response = createPermissionFailureResponse(c, permissions, "any");
    if (response) {
      return response;
    }

    await next();
  };
}

export function authorizePermissions({ c, permissions = [], mode = "all" } = {}) {
  const response = createPermissionFailureResponse(c, permissions, mode);
  return response
    ? {
        ok: false,
        response,
      }
    : {
        ok: true,
      };
}

export function createRequireTenantAccessMiddleware({ tenantRepository = null } = {}) {
  return async (c, next) => {
    const decision = await authorizeTenantScopedRequest({ c, tenantRepository });
    if (!decision.ok) {
      return decision.response;
    }
    await next();
  };
}

export async function authorizeTenantScopedRequest({
  c,
  tenantRepository = null,
  resourceTenantIds = [],
  resourceSchemeIds = [],
} = {}) {
  const authContext = c.get("authContext") || null;
  const tenantContext = c.get("tenantContext") || null;

  const resolvedResources = await resolveResourceTenantIds({
    tenantRepository,
    resourceSchemeIds,
  });

  if (resolvedResources.unresolvedSchemeIds.length > 0) {
    return {
      ok: false,
      response: applicationErrorResponse(c, new TenantMismatchError()),
    };
  }

  const decision = evaluateTenantAccess({
    authContext,
    tenantContext,
    resourceTenantIds: [...resourceTenantIds, ...resolvedResources.tenantIds],
    resourceSchemeIds,
  });

  if (!decision.allowed) {
    return {
      ok: false,
      response: applicationErrorResponse(c, new TenantMismatchError()),
    };
  }

  return {
    ok: true,
    decision,
  };
}
