import { applicationErrorResponse } from "../application-errors.js";
import { runWithOperationalServices } from "../operational-service-context.js";

const OPERATIONAL_PREFIXES = Object.freeze([
  "/claims", "/investigations", "/detection", "/ledger", "/registry", "/simulator",
  "/internal/data-plane",
]);

export function requiresOperationalDataPlane(path) {
  return OPERATIONAL_PREFIXES.some((prefix) => path === prefix || path.startsWith(`${prefix}/`));
}

export function createDataPlaneMiddleware({ routeResolver, connectionManager, createServiceBundle, logger = null }) {
  if (!routeResolver || !connectionManager || !createServiceBundle) throw new TypeError("Data-plane middleware dependencies are required.");
  return async (c, next) => {
    if (!requiresOperationalDataPlane(c.req.path)) return next();
    const auth = c.get("authContext") || null;
    if (!auth?.is_authenticated) return next();
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
