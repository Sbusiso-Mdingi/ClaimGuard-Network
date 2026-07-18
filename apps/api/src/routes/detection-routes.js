import { OPERATIONAL_ROUTE_IDS } from "../authorization-policy.js";
import {
  createRequireOperationalRouteAuthorizationMiddleware,
  createRequireTenantAccessMiddleware,
} from "../middleware/authorization-middleware.js";

export function registerDetectionRoutes(app, { reportService, tenantRepository = null }) {
  const requireDetectionReport = createRequireOperationalRouteAuthorizationMiddleware({
    routeId: OPERATIONAL_ROUTE_IDS.DETECTION_REPORT,
  });
  const requireDetectionGraph = createRequireOperationalRouteAuthorizationMiddleware({
    routeId: OPERATIONAL_ROUTE_IDS.DETECTION_GRAPH,
  });
  const requireDetectionRisk = createRequireOperationalRouteAuthorizationMiddleware({
    routeId: OPERATIONAL_ROUTE_IDS.DETECTION_RISK,
  });
  const requireDetectionAnalyze = createRequireOperationalRouteAuthorizationMiddleware({
    routeId: OPERATIONAL_ROUTE_IDS.DETECTION_ANALYZE,
  });
  const requireTenantAccess = createRequireTenantAccessMiddleware({ tenantRepository });

  app.get("/detection/report", requireDetectionReport, requireTenantAccess, async (c) => {
    const result = await reportService.getDetectionReport(c.get("tenantContext"));
    return c.json(result.body, result.status);
  });

  app.get("/detection/graph", requireDetectionGraph, requireTenantAccess, async (c) => {
    const result = await reportService.getDetectionGraph(c.get("tenantContext"));
    return c.json(result.body, result.status);
  });

  app.get("/detection/risk", requireDetectionRisk, requireTenantAccess, async (c) => {
    const result = await reportService.getDetectionRisk(c.get("tenantContext"));
    return c.json(result.body, result.status);
  });

  app.post(
    "/detection/analyze",
    requireDetectionAnalyze,
    requireTenantAccess,
    async (c) => {
      const payload = await c.req.json().catch(() => null);
      if (!payload || !Array.isArray(payload.claims)) {
        return c.json(
          {
            available: false,
            message: "Request body must include a claims array.",
          },
          400,
        );
      }

      const result = await reportService.analyze(payload);
      return c.json(result.body, result.status);
    },
  );
}
