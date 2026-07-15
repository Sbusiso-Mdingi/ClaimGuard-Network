import {
  INVESTIGATION_STATUS,
  FraudRegistryConflictError,
  FraudRegistryValidationError,
  isFraudConfirmationPermitted,
} from "@claimguard/database";

import {
  authorizePermissions,
  authorizeTenantScopedRequest,
  createRequireAnyPermissionMiddleware,
  createRequirePermissionMiddleware,
} from "../middleware/authorization-middleware.js";
import { CLAIMGUARD_PERMISSIONS } from "../authorization-policy.js";
import {
  investigationErrorResponse,
  investigationRepositoryUnavailable,
  loadInvestigationOrFail,
  registryErrorResponse,
  sharedRegistryUnavailable,
} from "./http-response-helpers.js";

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
      const claimId = payload?.claimId;
      const investigatorId = payload?.investigatorId;
      const reason = payload?.reason;

      if (!investigationId || !claimId || !investigatorId || !reason) {
        return c.json(
          {
            available: false,
            message: "investigationId, claimId, investigatorId, and reason are required.",
          },
          400,
        );
      }

      if (!investigationService.hasMethod("getInvestigationById")) {
        return investigationRepositoryUnavailable(c);
      }

      let investigation;
      try {
        const loaded = await loadInvestigationOrFail(c, investigationService, investigationId);
        if (!loaded.ok) {
          return loaded.response;
        }
        investigation = loaded.investigation;
      } catch (error) {
        return investigationErrorResponse(c, error);
      }

      if (investigation.claimId !== claimId) {
        return c.json(
          {
            available: false,
            message: "claimId must match the investigation claim.",
          },
          400,
        );
      }

      if (!isFraudConfirmationPermitted(investigation)) {
        return c.json(
          {
            available: false,
            message:
              investigation.status === INVESTIGATION_STATUS.CONFIRMED_FRAUD
                ? "This investigation has already published a fraud decision."
                : "Investigation status must be CONFIRMED_FRAUD before fraud can be confirmed.",
          },
          409,
        );
      }

      const tenantDecision = await authorizeTenantScopedRequest({
        c,
        tenantRepository,
        resourceTenantIds: [investigation.tenantId],
        resourceSchemeIds: [payload?.schemeId].filter(Boolean),
      });

      if (!tenantDecision.ok) {
        return tenantDecision.response;
      }

      try {
        const result = await fraudConfirmationService.confirmFraud({
          payload,
          investigation,
          requestId: c.get("requestId") || null,
        });

        return c.json({ available: true, entry: result.entry, registryEntry: result.registryEntry }, 201);
      } catch (error) {
        logger?.("error", "fraud_confirmation_failed", {
          requestId: c.get("requestId") || null,
          message: error?.message || "Failed to persist confirmed fraud decision.",
        });

        return c.json(
          {
            available: false,
            message: error?.message || "Failed to persist confirmed fraud decision.",
          },
          400,
        );
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

      if (!fraudReversalService.isRegistryConfigured()) {
        return sharedRegistryUnavailable(c);
      }

      const payload = await c.req.json().catch(() => null);
      const investigationId = payload?.investigationId;
      const claimId = payload?.claimId;
      const investigatorId = payload?.investigatorId;
      const reason = payload?.reason;

      if (!investigationId || !claimId || !investigatorId || !reason) {
        return c.json(
          {
            available: false,
            message: "investigationId, claimId, investigatorId, and reason are required.",
          },
          400,
        );
      }

      if (!investigationService.hasMethod("getInvestigationById")) {
        return investigationRepositoryUnavailable(c);
      }

      let investigation;
      try {
        const loaded = await loadInvestigationOrFail(c, investigationService, investigationId);
        if (!loaded.ok) {
          return loaded.response;
        }

        investigation = loaded.investigation;
      } catch (error) {
        return investigationErrorResponse(c, error);
      }

      if (investigation.claimId !== claimId) {
        return c.json(
          {
            available: false,
            message: "claimId must match the investigation claim.",
          },
          400,
        );
      }

      const tenantDecision = await authorizeTenantScopedRequest({
        c,
        tenantRepository,
        resourceTenantIds: [investigation.tenantId],
      });

      if (!tenantDecision.ok) {
        return tenantDecision.response;
      }

      try {
        const result = await fraudReversalService.reverseFraud({
          payload,
          investigation,
          requestId: c.get("requestId") || null,
        });

        if (!result.ok) {
          return c.json(result.body, result.status);
        }

        return c.json(
          {
            available: true,
            entry: result.entry,
            registryEntry: result.registryEntry,
          },
          201,
        );
      } catch (error) {
        logger?.("error", "fraud_reversal_failed", {
          requestId: c.get("requestId") || null,
          message: error?.message || "Failed to reverse fraud decision.",
        });

        if (error instanceof FraudRegistryConflictError || error instanceof FraudRegistryValidationError) {
          return registryErrorResponse(c, error);
        }

        return c.json(
          {
            available: false,
            message: error?.message || "Failed to reverse fraud decision.",
          },
          400,
        );
      }
    },
  );
}
