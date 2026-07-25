import { CLAIMGUARD_PERMISSIONS } from "../authorization-policy.js";
import { createRequirePermissionMiddleware } from "../middleware/authorization-middleware.js";

function actorFromContext(c) {
  const auth = c.get("authContext") || {};
  return {
    type: "user",
    id: auth.user_id || null,
    organisationId: auth.organisation_id || null,
    source: "scheme-admin-api",
    correlationId: c.get("requestId") || null,
  };
}

function emptyProcessingCounts() {
  return {
    queued: 0,
    processing: 0,
    retrying: 0,
    failed: 0,
    scored: 0,
    notScored: 0,
  };
}

function normalizeStrategy(strategy) {
  if (!strategy) return null;
  return {
    strategyId: strategy.strategyId || strategy.strategy_id || null,
    strategyType: strategy.strategyType || strategy.strategy_type || null,
    modelDeploymentId: strategy.modelDeploymentId || strategy.model_deployment_id || null,
    activatedAt: strategy.activatedAt || strategy.activated_at || null,
    activatedBy: strategy.activatedBy || strategy.activated_by || null,
    changeReason: strategy.changeReason || strategy.change_reason || null,
  };
}

async function buildOperationalOverview({ claimsReadRepository, detectionStrategyRepository, tenantContext }) {
  const processing = emptyProcessingCounts();
  const investigationStatus = {};
  let totalClaims = 0;
  let claimsWithInvestigations = 0;
  let page = 1;
  let totalPages = 1;

  if (claimsReadRepository?.listClaims) {
    do {
      const result = await claimsReadRepository.listClaims({ page, pageSize: 100 });
      const claims = Array.isArray(result?.claims) ? result.claims : [];
      totalClaims = Number(result?.pagination?.total || totalClaims || claims.length);
      totalPages = Math.max(1, Number(result?.pagination?.totalPages || 1));

      for (const claim of claims) {
        const status = claim?.processingStatus || claim?.processing?.status || "not_scored";
        if (status === "queued") processing.queued += 1;
        else if (status === "processing") processing.processing += 1;
        else if (status === "retrying") processing.retrying += 1;
        else if (status === "failed") processing.failed += 1;
        else if (status === "scored") processing.scored += 1;
        else processing.notScored += 1;

        const investigation = claim?.investigation || null;
        if (investigation) {
          claimsWithInvestigations += 1;
          const key = String(investigation.status || "unknown").toLowerCase();
          investigationStatus[key] = (investigationStatus[key] || 0) + 1;
        }
      }

      page += 1;
    } while (page <= totalPages);
  }

  const activeStrategy = detectionStrategyRepository?.getActiveStrategy
    ? await detectionStrategyRepository.getActiveStrategy(tenantContext)
    : null;

  const completedClaims = processing.scored + processing.failed;
  const scoringCompletionRate = totalClaims > 0
    ? Math.round((processing.scored / totalClaims) * 10_000) / 100
    : 0;

  return {
    generatedAt: new Date().toISOString(),
    claims: {
      total: totalClaims,
      scored: processing.scored,
      awaitingScoring: processing.queued + processing.processing + processing.retrying,
      failed: processing.failed,
      notScored: processing.notScored,
      completionRate: scoringCompletionRate,
      terminalCount: completedClaims,
    },
    processing,
    investigations: {
      claimsWithInvestigations,
      byStatus: investigationStatus,
    },
    detectionStrategy: normalizeStrategy(activeStrategy),
  };
}

export function registerSchemeAdminRoutes(app, {
  controlPlaneService,
  claimsReadRepository = null,
  detectionStrategyRepository = null,
} = {}) {
  const requireSchemeUsersManage = createRequirePermissionMiddleware({
    permission: CLAIMGUARD_PERMISSIONS.USERS_MANAGE_TENANT,
  });
  const requireTenantStatusView = createRequirePermissionMiddleware({
    permission: CLAIMGUARD_PERMISSIONS.TENANT_STATUS_VIEW,
  });

  app.get("/admin/scheme/overview", requireTenantStatusView, async (c) => {
    if (!claimsReadRepository?.listClaims) {
      return c.json({ available: false, code: "NOT_CONFIGURED", message: "Scheme operations overview is not configured." }, 503);
    }

    try {
      const overview = await buildOperationalOverview({
        claimsReadRepository,
        detectionStrategyRepository,
        tenantContext: c.get("tenantContext") || null,
      });
      return c.json({ available: true, overview });
    } catch (error) {
      return c.json({
        available: false,
        code: "OVERVIEW_FETCH_FAILED",
        message: "Failed to load the scheme operations overview.",
      }, 500);
    }
  });

  app.get("/admin/scheme/users", requireSchemeUsersManage, async (c) => {
    if (!controlPlaneService?.listUsersByOrganisation) {
      return c.json({ available: false, code: "NOT_CONFIGURED", message: "User management is not configured." }, 404);
    }
    const actor = actorFromContext(c);
    try {
      const users = await controlPlaneService.listUsersByOrganisation(actor.organisationId, actor);
      return c.json({ available: true, users });
    } catch (error) {
      return c.json({ available: false, code: "FETCH_FAILED", message: "Failed to list users." }, 500);
    }
  });

  app.post("/admin/scheme/users", requireSchemeUsersManage, async (c) => {
    if (!controlPlaneService?.createSchemeUser) {
      return c.json({ available: false, code: "NOT_CONFIGURED", message: "User management is not configured." }, 404);
    }
    const actor = actorFromContext(c);
    const payload = await c.req.json().catch(() => ({}));
    const { displayName, username, password, roleKey } = payload;

    if (!displayName || !username || !password || !roleKey) {
      return c.json({ available: false, code: "INVALID_INPUT", message: "displayName, username, password, and roleKey are required." }, 400);
    }
    if (password.length < 8) {
      return c.json({ available: false, code: "WEAK_PASSWORD", message: "Password must be at least 8 characters." }, 400);
    }

    try {
      const result = await controlPlaneService.createSchemeUser({
        organisationId: actor.organisationId,
        displayName,
        username,
        password,
        roleKey,
      }, actor);

      return c.json({
        available: true,
        user: { userId: result.user.userId, displayName: result.user.displayName },
      }, 201);
    } catch (error) {
      const status = Number.isInteger(error?.status) ? error.status : 400;
      const code = error?.code || "USER_CREATE_FAILED";
      return c.json({ available: false, code, message: error?.message || "Failed to create user." }, status);
    }
  });

  app.delete("/admin/scheme/users/:userId", requireSchemeUsersManage, async (c) => {
    if (!controlPlaneService?.disableSchemeUser) {
      return c.json({ available: false, code: "NOT_CONFIGURED", message: "User management is not configured." }, 404);
    }
    const actor = actorFromContext(c);
    const userId = c.req.param("userId");

    try {
      const user = await controlPlaneService.disableSchemeUser({
        organisationId: actor.organisationId,
        userId,
      }, actor);

      return c.json({ available: true, user });
    } catch (error) {
      const status = Number.isInteger(error?.status) ? error.status : 400;
      const code = error?.code || "USER_DISABLE_FAILED";
      return c.json({ available: false, code, message: error?.message || "Failed to disable user." }, status);
    }
  });
}
