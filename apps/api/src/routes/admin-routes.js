import { createBackendHealth, createBackendInfo } from "@claimguard/shared-schema";
import { OPERATIONAL_ROUTE_IDS, CLAIMGUARD_PERMISSIONS } from "../authorization-policy.js";
import {
  createRequireOperationalRouteAuthorizationMiddleware,
} from "../middleware/authorization-middleware.js";

export function registerAdminRoutes(app, { reportService, dataPlaneRuntime = null, detectionStrategyRepository = null, tenantRepository = null }) {
  const requireInternalDataPlaneHealth = createRequireOperationalRouteAuthorizationMiddleware({
    routeId: OPERATIONAL_ROUTE_IDS.INTERNAL_DATA_PLANE_HEALTH,
  });
  const requireDetectionStrategyView = createRequireOperationalRouteAuthorizationMiddleware({
    routeId: OPERATIONAL_ROUTE_IDS.DETECTION_STRATEGY_VIEW,
  });
  const requireDetectionStrategyUpdate = createRequireOperationalRouteAuthorizationMiddleware({
    routeId: OPERATIONAL_ROUTE_IDS.DETECTION_STRATEGY_UPDATE,
  });

  function summarizePools(metrics = { pools: [] }) {
    const pools = Array.isArray(metrics?.pools) ? metrics.pools : [];
    const retiringPools = pools.filter((entry) => Boolean(entry?.retiring)).length;
    const activeRequestTotal = pools.reduce((sum, entry) => sum + Number(entry?.activeRequests || 0), 0);
    const lastSuccessfulConnectionAt = pools
      .map((entry) => entry?.lastSuccessfulConnectionAt || null)
      .filter(Boolean)
      .sort()
      .at(-1) || null;
    const lastFailureCategories = [...new Set(
      pools
        .map((entry) => entry?.lastFailureCategory || null)
        .filter(Boolean),
    )];

    return {
      totalPools: pools.length,
      retiringPools,
      activeRequestTotal,
      lastSuccessfulConnectionAt,
      lastFailureCategories,
    };
  }

  app.get("/live", (c) => {
    return c.json({
      status: "ok",
      service: "api",
      live: true,
      timestamp: new Date().toISOString(),
    });
  });

  app.get("/ready", async (c) => {
    const readiness = await reportService.checkReadiness();
    const dataPlaneReadiness = dataPlaneRuntime?.checkReadiness ? await dataPlaneRuntime.checkReadiness() : { ready: true, checks: {} };
    const ready = readiness.ready && dataPlaneReadiness.ready;
    const statusCode = ready ? 200 : 503;
    const status = ready ? (readiness.degraded ? "degraded" : "ok") : "degraded";

    return c.json(
      {
        status,
        service: "api",
        ready,
        checks: { ...readiness.checks, ...dataPlaneReadiness.checks },
        timestamp: new Date().toISOString(),
      },
      statusCode,
    );
  });

  app.get("/health", (c) => c.json(createBackendHealth()));
  app.get("/meta", (c) => c.json(createBackendInfo()));
  app.get("/internal/data-plane/health", requireInternalDataPlaneHealth, async (c) => {
    const context = c.get("dataPlaneContext") || null;
    const readiness = dataPlaneRuntime?.checkReadiness
      ? await dataPlaneRuntime.checkReadiness()
      : { ready: true, checks: {} };
    const metrics = dataPlaneRuntime?.connectionManager?.metrics?.() || { pools: [] };

    if (!context) {
      return c.json({
        available: true,
        route: {
          type: "platform_diagnostic",
          schemaCompatible: Boolean(readiness?.checks?.schemaCompatible ?? true),
        },
        readiness,
        pool: summarizePools(metrics),
      });
    }

    const pool = metrics.pools.find((entry) =>
      entry.organisationId === context.organisationId && entry.routeId === context.routeId && entry.routeGeneration === context.routeGeneration,
    ) || null;
    return c.json({
      available: true,
      route: { type: context.routeType, schemaCompatible: true },
      readiness,
      pool: pool ? {
        activeRequests: pool.activeRequests,
        retiring: pool.retiring,
        lastSuccessfulConnectionAt: pool.lastSuccessfulConnectionAt,
        lastFailureCategory: pool.lastFailureCategory,
      } : null,
    });
  });

  app.get("/detection/strategy", requireDetectionStrategyView, async (c) => {
    if (!detectionStrategyRepository) {
      return c.json({ available: false, message: "Detection strategy repository not available" }, 503);
    }
    const tenantContext = c.get("tenantContext");
    const strategy = await detectionStrategyRepository.getActiveStrategy(tenantContext);
    return c.json({ available: true, strategy });
  });

  app.put("/detection/strategy", requireDetectionStrategyUpdate, async (c) => {
    if (!detectionStrategyRepository) {
      return c.json({ available: false, message: "Detection strategy repository not available" }, 503);
    }
    const tenantContext = c.get("tenantContext");
    const payload = await c.req.json().catch(() => ({}));

    if (!payload.strategyType) {
      return c.json({ available: false, message: "strategyType is required" }, 400);
    }

    if (payload.strategyType === "ml_endpoint" && !payload.endpointUrl) {
      return c.json({ available: false, message: "endpointUrl is required for ml_endpoint strategy" }, 400);
    }

    // customModelImageSecret is optional; it should be the name of a Key Vault secret storing the model image URL
    const strategy = await detectionStrategyRepository.setStrategy(tenantContext, {
      strategyType: payload.strategyType,
      endpointUrl: payload.endpointUrl,
      customModelImageSecret: payload.customModelImageSecret,
    });

    return c.json({ available: true, strategy });
  });
}
