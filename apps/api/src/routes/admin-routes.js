import { createBackendHealth, createBackendInfo } from "@claimguard/shared-schema";

export function registerAdminRoutes(app, { reportService, dataPlaneRuntime = null }) {
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
  app.get("/internal/data-plane/health", (c) => {
    const context = c.get("dataPlaneContext") || null;
    if (!context) return c.json({ available: false, code: "DATA_PLANE_CONTEXT_REQUIRED", message: "Verified data-plane context is required." }, 503);
    const pool = dataPlaneRuntime?.connectionManager?.metrics().pools.find((entry) =>
      entry.organisationId === context.organisationId && entry.routeId === context.routeId && entry.routeGeneration === context.routeGeneration,
    ) || null;
    return c.json({
      available: true,
      route: { type: context.routeType, schemaCompatible: true },
      pool: pool ? {
        activeRequests: pool.activeRequests,
        retiring: pool.retiring,
        lastSuccessfulConnectionAt: pool.lastSuccessfulConnectionAt,
        lastFailureCategory: pool.lastFailureCategory,
      } : null,
    });
  });
}
