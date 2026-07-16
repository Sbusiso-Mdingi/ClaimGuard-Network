import {
  authorizePermissions,
  createRequireAnyPermissionMiddleware,
  createRequirePermissionMiddleware,
} from "../middleware/authorization-middleware.js";
import { CLAIMGUARD_PERMISSIONS, CLAIMGUARD_ROLES } from "../authorization-policy.js";
import {
  investigationErrorResponse,
  investigationRepositoryUnavailable,
  loadInvestigationOrFail,
} from "./http-response-helpers.js";

function workflowActor(c) {
  const authContext = c.get("authContext") || {};
  const roles = Array.isArray(authContext.roles) ? authContext.roles : [];
  const actorRole = roles.includes(CLAIMGUARD_ROLES.INVESTIGATOR)
    ? CLAIMGUARD_ROLES.INVESTIGATOR
    : roles.includes(CLAIMGUARD_ROLES.PLATFORM_ADMINISTRATOR)
      ? CLAIMGUARD_ROLES.PLATFORM_ADMINISTRATOR
      : roles[0] || "unknown";

  return {
    actorId: authContext.user_id || null,
    actorRole,
    tenantId: c.get("tenantContext")?.tenant_id || authContext.tenant_id || null,
  };
}

function workflowErrorResponse(c, error, fallbackMessage) {
  const isTypedError = Number.isInteger(error?.status) && typeof error?.code === "string";
  const status = isTypedError ? error.status : 500;
  return c.json(
    {
      available: false,
      code: isTypedError ? error.code : "fraud_workflow_failed",
      message: isTypedError ? error.message : fallbackMessage,
    },
    status,
  );
}

export function registerInvestigationsRoutes(
  app,
  {
    investigationService,
    fraudConfirmationService,
    fraudReversalService,
    tenantRepository = null,
    logger,
  } = {},
) {
  app.post(
    "/investigations",
    createRequireAnyPermissionMiddleware({
      permissions: [CLAIMGUARD_PERMISSIONS.INVESTIGATIONS_CREATE],
    }),
    async (c) => {
      if (!investigationService.hasMethod("createInvestigation")) {
        return investigationRepositoryUnavailable(c);
      }

      const payload = await c.req.json().catch(() => null);
      const assignedBy = c.get("authContext")?.user_id || null;

      try {
        const investigation = await investigationService.createInvestigation({
          claimId: payload?.claimId,
          assignedInvestigator: payload?.assignedInvestigator || null,
          assignedBy,
          priority: payload?.priority,
        });

        return c.json({ available: true, investigation }, 201);
      } catch (error) {
        return investigationErrorResponse(c, error);
      }
    },
  );

  app.get(
    "/investigations/:id",
    createRequirePermissionMiddleware({
      permission: CLAIMGUARD_PERMISSIONS.INVESTIGATIONS_VIEW,
    }),
    async (c) => {
      if (!investigationService.hasMethod("getInvestigationDetails")) {
        return investigationRepositoryUnavailable(c);
      }

      try {
        const investigation = await investigationService.getInvestigationDetails(c.req.param("id"));
        if (!investigation) {
          return c.json(
            {
              available: false,
              message: "The investigation was not found in the active tenant.",
            },
            404,
          );
        }

        return c.json({ available: true, investigation }, 200);
      } catch (error) {
        return investigationErrorResponse(c, error);
      }
    },
  );

  app.patch("/investigations/:id", async (c) => {
    if (!investigationService.hasMethod("updateInvestigation")) {
      return investigationRepositoryUnavailable(c);
    }

    const payload = await c.req.json().catch(() => null);
    const hasStatus = payload && Object.hasOwn(payload, "status");
    const hasPriority = payload && Object.hasOwn(payload, "priority");

    if (!hasStatus && !hasPriority) {
      return c.json(
        {
          available: false,
          message: "status or priority must be provided.",
        },
        400,
      );
    }

    const requiredPermissions = [
      ...(hasStatus ? [CLAIMGUARD_PERMISSIONS.INVESTIGATIONS_UPDATE_STATUS] : []),
      ...(hasPriority ? [CLAIMGUARD_PERMISSIONS.INVESTIGATIONS_CHANGE_PRIORITY] : []),
    ];
    const permissionDecision = authorizePermissions({
      c,
      permissions: requiredPermissions,
      mode: "all",
    });

    if (!permissionDecision.ok) {
      return permissionDecision.response;
    }

    try {
      const investigation = await investigationService.updateInvestigation({
        investigationId: c.req.param("id"),
        status: hasStatus ? payload.status : undefined,
        priority: hasPriority ? payload.priority : undefined,
      });

      return c.json({ available: true, investigation }, 200);
    } catch (error) {
      return investigationErrorResponse(c, error);
    }
  });

  app.post(
    "/investigations/:id/notes",
    createRequireAnyPermissionMiddleware({
      permissions: [CLAIMGUARD_PERMISSIONS.INVESTIGATIONS_ADD_NOTE],
    }),
    async (c) => {
      if (!investigationService.hasMethod("getInvestigationById") || !investigationService.hasMethod("addNote")) {
        return investigationRepositoryUnavailable(c);
      }

      const investigationId = c.req.param("id");
      const loaded = await loadInvestigationOrFail(c, investigationService, investigationId);
      if (!loaded.ok) {
        return loaded.response;
      }

      const payload = await c.req.json().catch(() => null);
      try {
        const note = await investigationService.addNote({
          investigationId,
          author: c.get("authContext")?.user_id || null,
          text: payload?.text,
          noteType: payload?.noteType,
        });

        return c.json({ available: true, note }, 201);
      } catch (error) {
        return investigationErrorResponse(c, error);
      }
    },
  );

  app.post(
    "/investigations/:id/evidence",
    createRequirePermissionMiddleware({
      permission: CLAIMGUARD_PERMISSIONS.INVESTIGATIONS_UPLOAD_EVIDENCE,
    }),
    async (c) => {
      if (!investigationService.hasMethod("getInvestigationById") || !investigationService.hasMethod("registerEvidence")) {
        return investigationRepositoryUnavailable(c);
      }

      const investigationId = c.req.param("id");
      const loaded = await loadInvestigationOrFail(c, investigationService, investigationId);
      if (!loaded.ok) {
        return loaded.response;
      }

      const payload = await c.req.json().catch(() => null);
      try {
        const evidence = await investigationService.registerEvidence({
          investigationId,
          filename: payload?.filename,
          description: payload?.description,
          uploadedBy: c.get("authContext")?.user_id || null,
          evidenceType: payload?.evidenceType,
        });

        return c.json({ available: true, evidence }, 201);
      } catch (error) {
        return investigationErrorResponse(c, error);
      }
    },
  );

  app.post(
    "/investigations/confirm-fraud",
    createRequirePermissionMiddleware({
      permission: CLAIMGUARD_PERMISSIONS.INVESTIGATIONS_CONFIRM_FRAUD,
    }),
    async (c) => {
      if (!fraudConfirmationService.isLedgerConfigured()) {
        return c.json(
          {
            available: false,
            message: "Ledger repository is not configured for investigator confirmation writes.",
          },
          503,
        );
      }

      const payload = await c.req.json().catch(() => null);
      const investigationId = payload?.investigationId;
      const reason = payload?.reason;

      if (!investigationId || !reason) {
        return c.json(
          {
            available: false,
            message: "investigationId and reason are required.",
          },
          400,
        );
      }

      try {
        const actor = workflowActor(c);
        const result = await fraudConfirmationService.confirmFraud({
          investigationId,
          requestedClaimId: payload?.claimId || null,
          reason,
          ...actor,
          correlationId: c.get("requestId") || null,
          idempotencyKey: c.req.header("idempotency-key") || payload?.idempotencyKey || null,
        });

        return c.json(
          {
            available: true,
            entry: result.entry,
            registryEntry: result.registryEntry,
            replayed: result.replayed,
          },
          result.replayed ? 200 : 201,
        );
      } catch (error) {
        logger?.("error", "fraud_confirmation_failed", {
          requestId: c.get("requestId") || null,
          message: error?.message || "Failed to persist confirmed fraud decision.",
        });

        return workflowErrorResponse(c, error, "Failed to persist confirmed fraud decision.");
      }
    },
  );

  app.post(
    "/investigations/reverse-fraud",
    createRequirePermissionMiddleware({
      permission: CLAIMGUARD_PERMISSIONS.INVESTIGATIONS_CONFIRM_FRAUD,
    }),
    async (c) => {
      if (!fraudReversalService.isLedgerConfigured()) {
        return c.json(
          {
            available: false,
            message: "Ledger repository is not configured for fraud reversal writes.",
          },
          503,
        );
      }

      const payload = await c.req.json().catch(() => null);
      const investigationId = payload?.investigationId;
      const reason = payload?.reason;

      if (!investigationId || !reason) {
        return c.json(
          {
            available: false,
            message: "investigationId and reason are required.",
          },
          400,
        );
      }

      try {
        const actor = workflowActor(c);
        const result = await fraudReversalService.reverseFraud({
          investigationId,
          requestedClaimId: payload?.claimId || null,
          reason,
          ...actor,
          correlationId: c.get("requestId") || null,
          idempotencyKey: c.req.header("idempotency-key") || payload?.idempotencyKey || null,
        });

        return c.json(
          {
            available: true,
            entry: result.entry,
            registryEntry: result.registryEntry,
            replayed: result.replayed,
          },
          result.replayed ? 200 : 201,
        );
      } catch (error) {
        logger?.("error", "fraud_reversal_failed", {
          requestId: c.get("requestId") || null,
          message: error?.message || "Failed to reverse fraud decision.",
        });

        return workflowErrorResponse(c, error, "Failed to reverse fraud decision.");
      }
    },
  );
}
