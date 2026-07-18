import { OPERATIONAL_ROUTE_IDS } from "../authorization-policy.js";
import { createRequireOperationalRouteAuthorizationMiddleware } from "../middleware/authorization-middleware.js";

function unavailable(c) {
  return c.json({
    available: false,
    code: "SIMULATOR_STATE_UNAVAILABLE",
    message: "Simulator durable state is not configured.",
  }, 503);
}

function projectStatus(instance) {
  if (!instance) return null;
  return {
    instanceId: instance.id,
    scope: instance.scopeKey,
    scopeType: instance.scopeType,
    mode: instance.mode,
    status: instance.status,
    storyKey: instance.storyKey,
    seed: instance.seed,
    tickIntervalMs: instance.tickIntervalMs,
    simulatedAt: instance.simulatedAt,
    tickNumber: instance.tickNumber,
    checkpointVersion: instance.checkpointVersion,
    updatedAt: instance.updatedAt,
    startedAt: instance.startedAt,
    pausedAt: instance.pausedAt,
    stoppedAt: instance.stoppedAt,
    lastSuccessfulTickAt: instance.lastSuccessfulTickAt,
    lastCorrelationId: instance.lastCorrelationId,
    lastError: instance.lastError,
    lease: instance.lease ? {
      active: true,
      leaseExpiresAt: instance.lease.leaseExpiresAt,
      heartbeatAt: instance.lease.heartbeatAt,
      fencingToken: instance.lease.fencingToken,
    } : { active: false },
  };
}

function errorResponse(c, error) {
  const typed = Number.isInteger(error?.status) && typeof error?.code === "string";
  return c.json({
    available: false,
    code: typed ? error.code : "SIMULATOR_CONTROL_FAILED",
    message: typed ? error.message : "Simulator control could not be updated.",
  }, typed ? error.status : 500);
}

export function registerSimulationRoutes(app, { simulationStateRepository } = {}) {
  const requireStatus = createRequireOperationalRouteAuthorizationMiddleware({ routeId: OPERATIONAL_ROUTE_IDS.SIMULATOR_STATUS });
  const requireStart = createRequireOperationalRouteAuthorizationMiddleware({ routeId: OPERATIONAL_ROUTE_IDS.SIMULATOR_START });
  const requirePause = createRequireOperationalRouteAuthorizationMiddleware({ routeId: OPERATIONAL_ROUTE_IDS.SIMULATOR_PAUSE });
  const requireResume = createRequireOperationalRouteAuthorizationMiddleware({ routeId: OPERATIONAL_ROUTE_IDS.SIMULATOR_RESUME });
  const requireStop = createRequireOperationalRouteAuthorizationMiddleware({ routeId: OPERATIONAL_ROUTE_IDS.SIMULATOR_STOP });
  const requireMode = createRequireOperationalRouteAuthorizationMiddleware({ routeId: OPERATIONAL_ROUTE_IDS.SIMULATOR_MODE });

  const controlMiddlewareByAction = Object.freeze({
    start: requireStart,
    pause: requirePause,
    resume: requireResume,
    stop: requireStop,
  });

  app.get("/simulator/status", requireStatus, async (c) => {
    if (!simulationStateRepository?.getStatus) return unavailable(c);
    try {
      const status = await simulationStateRepository.getStatus();
      return c.json({ available: true, simulator: projectStatus(status) }, 200);
    } catch (error) {
      return errorResponse(c, error);
    }
  });

  for (const action of ["start", "pause", "resume", "stop"]) {
    app.post(`/simulator/${action}`, controlMiddlewareByAction[action], async (c) => {
      if (!simulationStateRepository?.command) return unavailable(c);
      try {
        await simulationStateRepository.command({
          action,
          actorId: c.get("authContext")?.user_id,
          correlationId: c.get("requestId"),
        });
        return c.json({ available: true, simulator: projectStatus(await simulationStateRepository.getStatus()) }, 200);
      } catch (error) {
        return errorResponse(c, error);
      }
    });
  }

  app.post("/simulator/mode", requireMode, async (c) => {
    if (!simulationStateRepository?.command) return unavailable(c);
    const payload = await c.req.json().catch(() => null);
    try {
      await simulationStateRepository.command({
        action: "mode",
        actorId: c.get("authContext")?.user_id,
        correlationId: c.get("requestId"),
        mode: payload?.mode,
        storyKey: payload?.storyKey,
      });
      return c.json({ available: true, simulator: projectStatus(await simulationStateRepository.getStatus()) }, 200);
    } catch (error) {
      return errorResponse(c, error);
    }
  });
}
