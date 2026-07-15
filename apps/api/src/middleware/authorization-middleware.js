import { createHeaderAuthenticationProvider } from "./auth-context.js";
import { evaluateTenantAccess, hasPermission } from "../authorization-policy.js";

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
    const tenantContext = c.get("tenantContext") || null;

    const authContext = await authenticationProvider.resolveAuthContext({
      request: c.req.raw,
      tenantContext,
    });

    c.set("authContext", authContext);
    c.req.raw.authContext = authContext;
    await next();
  };
}

export function createRequirePermissionMiddleware({ permission } = {}) {
  return async (c, next) => {
    const authContext = c.get("authContext") || null;

    if (!authContext?.is_authenticated) {
      return c.json(
        {
          available: false,
          message: "Authentication is required.",
        },
        401,
      );
    }

    if (!hasPermission(authContext, permission)) {
      return c.json(
        {
          available: false,
          message: "You do not have permission to perform this operation.",
        },
        403,
      );
    }

    await next();
  };
}

function createPermissionFailureResponse(c, permissions, mode) {
  const authContext = c.get("authContext") || null;

  if (!authContext?.is_authenticated) {
    return c.json(
      {
        available: false,
        message: "Authentication is required.",
      },
      401,
    );
  }

  const permitted =
    mode === "any"
      ? permissions.some((permission) => hasPermission(authContext, permission))
      : permissions.every((permission) => hasPermission(authContext, permission));

  if (!permitted) {
    return c.json(
      {
        available: false,
        message: "You do not have permission to perform this operation.",
      },
      403,
    );
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
      response: c.json(
        {
          available: false,
          message: "Tenant authorization failed for this request.",
        },
        403,
      ),
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
      response: c.json(
        {
          available: false,
          message: "Tenant authorization failed for this request.",
        },
        403,
      ),
    };
  }

  return {
    ok: true,
    decision,
  };
}
