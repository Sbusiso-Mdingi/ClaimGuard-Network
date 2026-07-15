import { createBackendHealth, createBackendInfo } from "@claimguard/shared-schema";

export function registerAdminRoutes(app, { reportService }) {
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
    const statusCode = readiness.ready ? 200 : 503;
    const status = readiness.ready ? (readiness.degraded ? "degraded" : "ok") : "degraded";

    return c.json(
      {
        status,
        service: "api",
        ready: readiness.ready,
        checks: readiness.checks,
        timestamp: new Date().toISOString(),
      },
      statusCode,
    );
  });

  app.get("/health", (c) => c.json(createBackendHealth()));
  app.get("/meta", (c) => c.json(createBackendInfo()));
}
