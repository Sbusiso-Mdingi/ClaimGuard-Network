import { CLAIMGUARD_PERMISSIONS } from "../authorization-policy.js";
import {
  createRequirePermissionMiddleware,
  createRequireTenantAccessMiddleware,
} from "../middleware/authorization-middleware.js";

export function registerDetectionRoutes(app, { reportService, tenantRepository = null }) {
  const requireReportPermission = createRequirePermissionMiddleware({
    permission: CLAIMGUARD_PERMISSIONS.REPORTS_VIEW_OWN,
  });
  const requireTenantAccess = createRequireTenantAccessMiddleware({ tenantRepository });

  app.get("/detection/report", requireReportPermission, requireTenantAccess, async (c) => {
    const result = await reportService.getDetectionReport(c.get("tenantContext"));
    return c.json(result.body, result.status);
  });

  app.get("/detection/graph", requireReportPermission, requireTenantAccess, async (c) => {
    const result = await reportService.getDetectionGraph(c.get("tenantContext"));
    return c.json(result.body, result.status);
  });

  app.get("/detection/risk", requireReportPermission, requireTenantAccess, async (c) => {
    const result = await reportService.getDetectionRisk(c.get("tenantContext"));
    return c.json(result.body, result.status);
  });

  app.post(
    "/detection/analyze",
    createRequirePermissionMiddleware({
      permission: CLAIMGUARD_PERMISSIONS.DETECTION_MANAGE_TENANT,
    }),
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
