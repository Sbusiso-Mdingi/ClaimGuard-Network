import {
  createRequireOperationalRouteAuthorizationMiddleware,
} from "../middleware/authorization-middleware.js";
import { CLAIMGUARD_ROLES, OPERATIONAL_ROUTE_IDS } from "../authorization-policy.js";
import { createEvidenceUploadBodyLimit } from "./evidence-upload-middleware.js";
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

function expectedVersion(c, prefix) {
  const raw = String(c.req.header("if-match") || "").replace(/^W\//, "").replace(/^\"|\"$/g, "");
  const match = raw.match(new RegExp(`^${prefix}-(\\d+)$`));
  return match ? Number(match[1]) : null;
}

function requireVersion(c, prefix, noun) {
  const version = expectedVersion(c, prefix);
  if (version) return { ok: true, version };
  return {
    ok: false,
    response: c.json({
      available: false,
      code: "PRECONDITION_REQUIRED",
      message: `A current ${noun} record version is required.`,
    }, 428),
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

async function eligibleAssignee(identityRepository, organisationId, userId) {
  if (!identityRepository?.listUsersByOrganisation) return null;
  const users = await identityRepository.listUsersByOrganisation(organisationId);
  return users.some((user) => user.userId === userId
    && user.userStatus === "active"
    && user.membershipStatus === "active"
    && user.roles?.includes(CLAIMGUARD_ROLES.INVESTIGATOR));
}

export function registerInvestigationsRoutes(
  app,
  {
    investigationService,
    fraudConfirmationService,
    fraudReversalService,
    tenantRepository = null,
    identityRepository = null,
    logger,
  } = {},
) {
  const enforceEvidenceBodyLimit = createEvidenceUploadBodyLimit();
  const respondToInvestigationError = (c, error, event) =>
    investigationErrorResponse(c, error, { logger, event });

  const requireInvestigationsCreate = createRequireOperationalRouteAuthorizationMiddleware({
    routeId: OPERATIONAL_ROUTE_IDS.INVESTIGATIONS_CREATE,
  });
  const requireInvestigationsView = createRequireOperationalRouteAuthorizationMiddleware({
    routeId: OPERATIONAL_ROUTE_IDS.INVESTIGATIONS_VIEW,
  });
  const requireInvestigationsPatch = createRequireOperationalRouteAuthorizationMiddleware({
    routeId: OPERATIONAL_ROUTE_IDS.INVESTIGATIONS_PATCH,
  });
  const requireInvestigationsAddNote = createRequireOperationalRouteAuthorizationMiddleware({
    routeId: OPERATIONAL_ROUTE_IDS.INVESTIGATIONS_ADD_NOTE,
  });
  const requireInvestigationsUploadEvidence = createRequireOperationalRouteAuthorizationMiddleware({
    routeId: OPERATIONAL_ROUTE_IDS.INVESTIGATIONS_UPLOAD_EVIDENCE,
  });
  const requireInvestigationsConfirmFraud = createRequireOperationalRouteAuthorizationMiddleware({
    routeId: OPERATIONAL_ROUTE_IDS.INVESTIGATIONS_CONFIRM_FRAUD,
  });
  const requireInvestigationsReverseFraud = createRequireOperationalRouteAuthorizationMiddleware({
    routeId: OPERATIONAL_ROUTE_IDS.INVESTIGATIONS_REVERSE_FRAUD,
  });

  app.post(
    "/investigations",
    requireInvestigationsCreate,
    async (c) => {
      if (!investigationService.hasMethod("createInvestigation")) {
        return investigationRepositoryUnavailable(c);
      }

      const payload = await c.req.json().catch(() => null);
      const assignedBy = c.get("authContext")?.user_id || null;
      const version = requireVersion(c, "claim", "claim");
      if (!version.ok) return version.response;

      try {
        if (payload?.assignedInvestigator) {
          const eligible = await eligibleAssignee(
            identityRepository,
            c.get("authContext")?.organisation_id || null,
            payload.assignedInvestigator,
          );
          if (eligible === null) {
            return c.json({ available: false, code: "INVESTIGATOR_DIRECTORY_UNAVAILABLE", message: "Investigator assignment is temporarily unavailable." }, 503);
          }
          if (!eligible) {
            return c.json({ available: false, code: "INVESTIGATOR_NOT_ELIGIBLE", message: "The selected investigator is not active in this medical scheme." }, 409);
          }
        }
        const investigation = await investigationService.createInvestigation({
          claimId: payload?.claimId,
          assignedInvestigator: payload?.assignedInvestigator || null,
          assignedBy,
          priority: payload?.priority,
          expectedClaimVersion: version.version,
          correlationId: c.get("requestId") || null,
        });

        c.header("ETag", `W/\"investigation-${investigation.recordVersion}\"`);
        return c.json({ available: true, investigation }, 201);
      } catch (error) {
        return respondToInvestigationError(c, error, "investigation_create_failed");
      }
    },
  );

  app.get(
    "/investigations/queue",
    requireInvestigationsView,
    async (c) => {
      if (!investigationService.hasMethod("listInvestigations")) {
        return investigationRepositoryUnavailable(c);
      }

      try {
        const result = await investigationService.listInvestigations({
          page: c.req.query("page"),
          pageSize: c.req.query("pageSize"),
          status: c.req.query("status") || null,
          priority: c.req.query("priority") || null,
          search: c.req.query("search") || null,
          assignment: c.req.query("assignment") || "all",
          actorId: c.get("authContext")?.user_id || null,
        });
        return c.json({ available: true, ...result }, 200);
      } catch (error) {
        return respondToInvestigationError(c, error, "investigation_queue_list_failed");
      }
    },
  );

  app.get(
    "/investigations/:id",
    requireInvestigationsView,
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

        c.header("ETag", `W/\"investigation-${investigation.recordVersion}\"`);
        return c.json({ available: true, investigation }, 200);
      } catch (error) {
        return respondToInvestigationError(c, error, "investigation_detail_failed");
      }
    },
  );

  app.patch("/investigations/:id", requireInvestigationsPatch, async (c) => {
    if (!investigationService.hasMethod("updateInvestigation")) {
      return investigationRepositoryUnavailable(c);
    }

    const payload = await c.req.json().catch(() => null);
    const hasStatus = payload && Object.hasOwn(payload, "status");
    const hasPriority = payload && Object.hasOwn(payload, "priority");
    const hasAssignment = payload && Object.hasOwn(payload, "assignedInvestigator");

    if (!hasStatus && !hasPriority && !hasAssignment) {
      return c.json(
        {
          available: false,
          message: "status, priority, or assignedInvestigator must be provided.",
        },
        400,
      );
    }
    const version = requireVersion(c, "investigation", "investigation");
    if (!version.ok) return version.response;

    try {
      if (hasAssignment && payload.assignedInvestigator) {
        const eligible = await eligibleAssignee(
          identityRepository,
          c.get("authContext")?.organisation_id || null,
          payload.assignedInvestigator,
        );
        if (eligible === null) {
          return c.json({ available: false, code: "INVESTIGATOR_DIRECTORY_UNAVAILABLE", message: "Investigator assignment is temporarily unavailable." }, 503);
        }
        if (!eligible) {
          return c.json({ available: false, code: "INVESTIGATOR_NOT_ELIGIBLE", message: "The selected investigator is not active in this medical scheme." }, 409);
        }
      }
      const investigation = await investigationService.updateInvestigation({
        investigationId: c.req.param("id"),
        status: hasStatus ? payload.status : undefined,
        priority: hasPriority ? payload.priority : undefined,
        assignedInvestigator: hasAssignment ? payload.assignedInvestigator : undefined,
        expectedRecordVersion: version.version,
        actorId: c.get("authContext")?.user_id || null,
        correlationId: c.get("requestId") || null,
      });

      c.header("ETag", `W/\"investigation-${investigation.recordVersion}\"`);
      return c.json({ available: true, investigation }, 200);
    } catch (error) {
      return respondToInvestigationError(c, error, "investigation_update_failed");
    }
  });

  app.post(
    "/investigations/:id/notes",
    requireInvestigationsAddNote,
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
      const version = requireVersion(c, "investigation", "investigation");
      if (!version.ok) return version.response;
      try {
        const result = await investigationService.addNote({
          investigationId,
          author: c.get("authContext")?.user_id || null,
          text: payload?.text,
          noteType: payload?.noteType,
          expectedRecordVersion: version.version,
          correlationId: c.get("requestId") || null,
        });

        const note = result?.note || result;
        const investigation = result?.investigation || null;
        if (investigation) c.header("ETag", `W/\"investigation-${investigation.recordVersion}\"`);
        return c.json({ available: true, note, investigation }, 201);
      } catch (error) {
        return respondToInvestigationError(c, error, "investigation_note_create_failed");
      }
    },
  );

  app.post(
    "/investigations/:id/evidence",
    enforceEvidenceBodyLimit,
    requireInvestigationsUploadEvidence,
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
      const version = requireVersion(c, "investigation", "investigation");
      if (!version.ok) return version.response;
      try {
        const result = await investigationService.uploadEvidence({
          tenantId: c.get("tenantContext")?.tenant_id || null,
          investigationId,
          filename: payload?.filename,
          description: payload?.description,
          uploadedBy: c.get("authContext")?.user_id || null,
          evidenceType: payload?.evidenceType,
          contentType: payload?.contentType,
          contentBase64: payload?.contentBase64,
          expectedRecordVersion: version.version,
          correlationId: c.get("requestId") || null,
        });

        const evidence = result?.evidence || result;
        const investigation = result?.investigation || null;
        if (investigation) c.header("ETag", `W/\"investigation-${investigation.recordVersion}\"`);
        return c.json({ available: true, evidence, investigation }, 201);
      } catch (error) {
        return respondToInvestigationError(c, error, "investigation_evidence_create_failed");
      }
    },
  );

  app.post(
    "/investigations/confirm-fraud",
    requireInvestigationsConfirmFraud,
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
    requireInvestigationsReverseFraud,
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
