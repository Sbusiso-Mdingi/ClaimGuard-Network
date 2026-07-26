import { createBackendHealth, createBackendInfo } from "@claimguard/shared-schema";
import {
  DetectionStrategyConflictError,
} from "@claimguard/database";
import { OPERATIONAL_ROUTE_IDS } from "../authorization-policy.js";
import {
  createRequireOperationalRouteAuthorizationMiddleware,
} from "../middleware/authorization-middleware.js";
import {
  DetectionModelSelectionError,
  projectDetectionModelSelection,
  resolveDetectionModelSelection,
} from "../detection-model-selection.js";

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
      pools.map((entry) => entry?.lastFailureCategory || null).filter(Boolean),
    )];

    return {
      totalPools: pools.length,
      retiringPools,
      activeRequestTotal,
      lastSuccessfulConnectionAt,
      lastFailureCategories,
    };
  }

  app.get("/live", (c) => c.json({
    status: "ok",
    service: "api",
    live: true,
    timestamp: new Date().toISOString(),
  }));

  app.get("/ready", async (c) => {
    const readiness = await reportService.checkReadiness();
    const dataPlaneReadiness = dataPlaneRuntime?.checkReadiness
      ? await dataPlaneRuntime.checkReadiness()
      : { ready: true, checks: {} };
    const ready = readiness.ready && dataPlaneReadiness.ready;
    return c.json({
      status: ready ? (readiness.degraded ? "degraded" : "ok") : "degraded",
      service: "api",
      ready,
      checks: { ...readiness.checks, ...dataPlaneReadiness.checks },
      timestamp: new Date().toISOString(),
    }, ready ? 200 : 503);
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
      entry.organisationId === context.organisationId
      && entry.routeId === context.routeId
      && entry.routeGeneration === context.routeGeneration,
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
    const storedStrategy = await detectionStrategyRepository.getActiveStrategy(tenantContext);
    const strategy = {
      ...projectDetectionModelSelection(storedStrategy, tenantContext),
      strategyId: storedStrategy.strategyId,
    };
    return c.json({ available: true, strategy });
  });

  app.put("/detection/strategy", requireDetectionStrategyUpdate, async (c) => {
    if (!detectionStrategyRepository) {
      return c.json({ available: false, message: "Detection strategy repository not available" }, 503);
    }

    const tenantContext = c.get("tenantContext");
    const payload = await c.req.json().catch(() => ({}));
    const permittedKeys = new Set([
      "strategyType",
      "modelDeploymentId",
      "changeReason",
      "expectedActiveStrategyId",
    ]);

    if (Object.keys(payload).some((key) => !permittedKeys.has(key))) {
      return c.json({ available: false, message: "The strategy payload contains unsupported fields." }, 400);
    }

    const authContext = c.get("authContext");
    const actor = String(authContext?.user_id || "").trim();
    if (!actor) {
      return c.json({ available: false, message: "Authenticated actor identity is unavailable." }, 401);
    }

    const changeReason = String(payload.changeReason || "").trim();
    if (!changeReason || changeReason.length > 500) {
      return c.json({ available: false, message: "changeReason must contain 1–500 characters." }, 400);
    }

    const expectedActiveStrategyId =
      Number(payload.expectedActiveStrategyId);
    if (
      !Number.isSafeInteger(expectedActiveStrategyId)
      || expectedActiveStrategyId <= 0
    ) {
      return c.json({
        available: false,
        code: "EXPECTED_ACTIVE_STRATEGY_REQUIRED",
        message:
          "expectedActiveStrategyId must identify the strategy "
          + "that was reviewed before this change.",
      }, 400);
    }

    try {
      const resolved = resolveDetectionModelSelection(payload, tenantContext);
      const storedStrategy = await detectionStrategyRepository.setStrategy(
        tenantContext,
        {
          ...resolved.repositoryChange,
          actor,
          changeReason,
          expectedActiveStrategyId,
        },
      );

      return c.json({
        available: true,
        strategy: {
          ...resolved.publicSelection,
          strategyId: storedStrategy?.strategyId || null,
          changed: storedStrategy?.changed,
        },
      });
    } catch (error) {
      if (error instanceof DetectionModelSelectionError) {
        return c.json({
          available: false,
          code: error.code,
          message: error.message,
        }, error.status);
      }
      if (
        error instanceof DetectionStrategyConflictError
        || error?.code === "DETECTION_STRATEGY_CONFLICT"
      ) {
        return c.json({
          available: false,
          code: "DETECTION_STRATEGY_CONFLICT",
          message: error.message,
        }, 409);
      }
      throw error;
    }
  });
}
