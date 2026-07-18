import { applicationErrorResponse } from "../application-errors.js";
import { CLAIMGUARD_PERMISSIONS, hasPermission } from "../authorization-policy.js";
import { ForbiddenError } from "../application-errors.js";
import { runWithOperationalServices } from "../operational-service-context.js";

const OPERATIONAL_PREFIXES = Object.freeze([
  "/claims", "/investigations", "/detection", "/ledger", "/registry", "/simulator",
  "/internal/data-plane",
]);

export function requiresOperationalDataPlane(path) {
  return OPERATIONAL_PREFIXES.some((prefix) => path === prefix || path.startsWith(`${prefix}/`));
}

function resolveOperationalPermissionRequirement(path, method) {
  const upperMethod = String(method || "GET").toUpperCase();

  if ((path === "/claims" || path.startsWith("/claims/")) && upperMethod === "GET") {
    return { permissions: [CLAIMGUARD_PERMISSIONS.CLAIMS_VIEW_OWN], mode: "all" };
  }
  if (path === "/claims/ingest" && upperMethod === "POST") {
    return { permissions: [CLAIMGUARD_PERMISSIONS.CLAIMS_INGEST], mode: "all" };
  }

  if (path === "/investigations" && upperMethod === "POST") {
    return { permissions: [CLAIMGUARD_PERMISSIONS.INVESTIGATIONS_CREATE], mode: "all" };
  }
  if (path.startsWith("/investigations/") && upperMethod === "GET") {
    return { permissions: [CLAIMGUARD_PERMISSIONS.INVESTIGATIONS_VIEW], mode: "all" };
  }
  if (path.startsWith("/investigations/") && upperMethod === "PATCH") {
    return {
      permissions: [
        CLAIMGUARD_PERMISSIONS.INVESTIGATIONS_UPDATE_STATUS,
        CLAIMGUARD_PERMISSIONS.INVESTIGATIONS_CHANGE_PRIORITY,
      ],
      mode: "any",
    };
  }
  if (path.endsWith("/notes") && upperMethod === "POST") {
    return { permissions: [CLAIMGUARD_PERMISSIONS.INVESTIGATIONS_ADD_NOTE], mode: "all" };
  }
  if (path.endsWith("/evidence") && upperMethod === "POST") {
    return { permissions: [CLAIMGUARD_PERMISSIONS.INVESTIGATIONS_UPLOAD_EVIDENCE], mode: "all" };
  }
  if (path === "/investigations/confirm-fraud" && upperMethod === "POST") {
    return { permissions: [CLAIMGUARD_PERMISSIONS.INVESTIGATIONS_CONFIRM_FRAUD], mode: "all" };
  }

  if (path.startsWith("/detection/") && upperMethod === "GET") {
    return { permissions: [CLAIMGUARD_PERMISSIONS.REPORTS_VIEW_OWN], mode: "all" };
  }
  if (path === "/detection/analyze" && upperMethod === "POST") {
    return { permissions: [CLAIMGUARD_PERMISSIONS.DETECTION_MANAGE_TENANT], mode: "all" };
  }

  if (path.startsWith("/ledger/") && upperMethod === "GET") {
    return { permissions: [CLAIMGUARD_PERMISSIONS.FRAUD_REGISTRY_REVIEW_HISTORY], mode: "all" };
  }

  if (path === "/registry/search" && upperMethod === "GET") {
    return { permissions: [CLAIMGUARD_PERMISSIONS.FRAUD_REGISTRY_SEARCH], mode: "all" };
  }
  if (path.startsWith("/registry/history/") && upperMethod === "GET") {
    return { permissions: [CLAIMGUARD_PERMISSIONS.FRAUD_REGISTRY_REVIEW_HISTORY], mode: "all" };
  }
  if (path.startsWith("/registry/") && upperMethod === "GET") {
    return { permissions: [CLAIMGUARD_PERMISSIONS.FRAUD_REGISTRY_VIEW], mode: "all" };
  }

  if (path === "/simulator/status" && upperMethod === "GET") {
    return { permissions: [CLAIMGUARD_PERMISSIONS.SIMULATOR_STATUS_VIEW], mode: "all" };
  }
  if (path.startsWith("/simulator/") && upperMethod === "POST") {
    return { permissions: [CLAIMGUARD_PERMISSIONS.SIMULATOR_CONTROL], mode: "all" };
  }

  return null;
}

function isPermittedForOperationalPath(auth, path, method) {
  const requirement = resolveOperationalPermissionRequirement(path, method);
  if (!requirement) return true;

  if (requirement.mode === "any") {
    return requirement.permissions.some((permission) => hasPermission(auth, permission));
  }

  return requirement.permissions.every((permission) => hasPermission(auth, permission));
}

export function createDataPlaneMiddleware({ routeResolver, connectionManager, createServiceBundle, logger = null }) {
  if (!routeResolver || !connectionManager || !createServiceBundle) throw new TypeError("Data-plane middleware dependencies are required.");
  return async (c, next) => {
    if (!requiresOperationalDataPlane(c.req.path)) return next();
    const auth = c.get("authContext") || null;
    if (!auth?.is_authenticated) {
      const organisationId = c.get("dataPlaneOrganisationToRetire") || null;
      if (organisationId) await connectionManager.retireOrganisation?.(organisationId, "session_organisation_inactive");
      return next();
    }
    if (!isPermittedForOperationalPath(auth, c.req.path, c.req.method)) {
      return applicationErrorResponse(c, new ForbiddenError());
    }
    let lease = null;
    try {
      const dataPlaneContext = await routeResolver.resolve({
        organisationId: auth.organisation_id,
        actorId: auth.source === "session" ? auth.user_id : null,
        serviceIdentityId: auth.source === "internal_service" ? auth.user_id : null,
        correlationId: c.get("requestId") || null,
      });
      if (dataPlaneContext.routeType === "legacy_shared" && auth.tenant_id && auth.tenant_id !== dataPlaneContext.operationalTenantId) {
        const error = new Error("Authenticated tenant mapping does not match the active data-plane route.");
        error.code = "DATA_PLANE_TENANT_MISMATCH";
        error.status = 403;
        throw error;
      }
      c.set("dataPlaneContext", dataPlaneContext);
      c.req.raw.dataPlaneContext = dataPlaneContext;
      if (dataPlaneContext.routeType === "platform_none") {
        const error = new Error("This organisation has no private operational data plane.");
        error.code = "DATA_PLANE_NOT_AVAILABLE";
        error.status = 503;
        return applicationErrorResponse(c, error);
      }
      lease = await connectionManager.acquire(dataPlaneContext);
      const bundle = createServiceBundle(dataPlaneContext, lease.pool);
      return await runWithOperationalServices(bundle, async () => next());
    } catch (error) {
      if (["DATA_PLANE_ORGANISATION_INACTIVE", "DATA_PLANE_ROUTE_INACTIVE", "DATA_PLANE_SCHEMA_UNSUPPORTED"].includes(error?.code)) {
        await connectionManager.retireOrganisation?.(auth.organisation_id, error.code.toLowerCase());
      }
      logger?.("error", "data_plane_route_failed", {
        organisationId: auth.organisation_id || null,
        correlationId: c.get("requestId") || null,
        failureCategory: error?.code || error?.name || "data_plane_failure",
      });
      if (error?.status) return applicationErrorResponse(c, error);
      throw error;
    } finally {
      await lease?.release();
    }
  };
}
