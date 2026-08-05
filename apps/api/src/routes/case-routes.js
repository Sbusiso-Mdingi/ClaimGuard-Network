import { ZodError } from "zod";

import {
  PROHIBITED_CASE_REQUEST_FIELDS,
  caseActionSuccessResponseSchema,
  parseCaseActionRequest,
} from "@claimguard/shared-schema/case-workflow";
import {
  createRequirePermissionMiddleware,
} from "../middleware/authorization-middleware.js";
import { CLAIMGUARD_PERMISSIONS } from "../authorization-policy.js";
import { registerLegacyCaseWriteGuards } from "./legacy-case-write-guards.js";

const DEFERRED_ACTIONS = new Set([
  "activate-network-notice",
  "publish-registry",
  "network-notice-active",
  "correct-or-withdraw",
  "expire-or-supersede",
]);

const STATUS_BY_CODE = Object.freeze({
  CASE_ROLE_NOT_AUTHORISED: 403,
  CASE_NOT_FOUND: 404,
  CASE_TRANSITION_NOT_PERMITTED: 409,
  CASE_STATE_VERSION_CONFLICT: 409,
  CASE_IDEMPOTENCY_MISMATCH: 409,
  CASE_REVIEWER_INDEPENDENCE_REQUIRED: 409,
  NETWORK_NOTICE_GOVERNANCE_REQUIRED: 409,
  CASE_PROCESS_REQUIREMENTS_INCOMPLETE: 422,
  CASE_OUTCOME_CODE_NOT_CONFIGURED: 503,
  CASE_OUTCOME_CODE_NOT_ALLOWED: 422,
});

function safeError(c, { code, message, status }) {
  return c.json({
    available: false,
    code,
    message,
    correlationId: c.get("requestId") || "unavailable",
  }, status);
}

function validateIdempotencyKey(c) {
  const key = c.req.header("idempotency-key");
  if (typeof key !== "string" || !key.trim()) {
    return {
      ok: false,
      response: safeError(c, {
        code: "MISSING_IDEMPOTENCY_KEY",
        message: "Idempotency-Key is required for every case action.",
        status: 400,
      }),
    };
  }
  const normalized = key.trim();
  if (normalized.length > 128) {
    return {
      ok: false,
      response: safeError(c, {
        code: "INVALID_IDEMPOTENCY_KEY",
        message: "Idempotency-Key must be at most 128 characters.",
        status: 400,
      }),
    };
  }
  return { ok: true, key: normalized };
}

function prohibitedField(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  if (Object.hasOwn(payload, "idempotencyKey")) return "idempotencyKey";
  return PROHIBITED_CASE_REQUEST_FIELDS.find((field) => Object.hasOwn(payload, field)) || null;
}

function validationError(c, error) {
  const invalidVersion = error instanceof ZodError
    && error.issues.some((issue) => issue.path?.[0] === "expectedStateVersion");
  return safeError(c, {
    code: invalidVersion ? "INVALID_EXPECTED_STATE_VERSION" : "INVALID_CASE_ACTION_REQUEST",
    message: invalidVersion
      ? "expectedStateVersion must be a positive bounded integer."
      : "The case action request does not satisfy the governed action contract.",
    status: 400,
  });
}

function domainError(c, error) {
  const originalCode = typeof error?.code === "string" ? error.code : null;
  if (originalCode === "CASE_TENANT_MISMATCH") {
    return safeError(c, {
      code: "CASE_NOT_FOUND",
      message: "The case was not found in the active tenant.",
      status: 404,
    });
  }
  const status = STATUS_BY_CODE[originalCode] || (Number.isInteger(error?.status) ? error.status : 500);
  return safeError(c, {
    code: originalCode || "CASE_ACTION_FAILED",
    message: originalCode ? error.message : "The case action could not be completed.",
    status,
  });
}

export function registerCaseRoutes(app, { caseWorkflowService, logger = null } = {}) {
  registerLegacyCaseWriteGuards(app);

  const requireCaseAction = createRequirePermissionMiddleware({
    permission: CLAIMGUARD_PERMISSIONS.FRAUD_REGISTRY_REVIEW_HISTORY,
  });

  app.get(
    "/api/v1/cases/:caseId",
    requireCaseAction,
    async (c) => {
      if (!caseWorkflowService?.isConfigured?.()) {
        return safeError(c, {
          code: "CASE_WORKFLOW_UNAVAILABLE",
          message: "The governed case workflow is temporarily unavailable.",
          status: 503,
        });
      }
      try {
        const result = await caseWorkflowService.getCase({
          caseId: c.req.param("caseId"),
          authContext: c.get("authContext") || null,
          tenantContext: c.get("tenantContext") || null,
        });
        return c.json({
          available: true,
          case: result.case,
          allowedActions: result.allowedActions,
          correlationId: c.get("requestId") || "unavailable",
        }, 200);
      } catch (error) {
        logger?.("warn", "case_detail_rejected", {
          caseId: c.req.param("caseId"),
          actorId: c.get("authContext")?.user_id || null,
          correlationId: c.get("requestId") || null,
          errorCode: error?.code || "CASE_DETAIL_FAILED",
        });
        return domainError(c, error);
      }
    },
  );

  app.post(
    "/api/v1/cases/:caseId/actions/:action",
    requireCaseAction,
    async (c) => {
      const action = c.req.param("action");
      if (DEFERRED_ACTIONS.has(action)) {
        return safeError(c, {
          code: "NETWORK_NOTICE_GOVERNANCE_REQUIRED",
          message: "Network-notice lifecycle actions require separate sharing governance.",
          status: 409,
        });
      }

      const payload = await c.req.json().catch(() => null);
      const forbidden = prohibitedField(payload);
      if (forbidden) {
        logger?.("warn", "case_action_spoofing_rejected", {
          caseId: c.req.param("caseId"),
          actorId: c.get("authContext")?.user_id || null,
          correlationId: c.get("requestId") || null,
          field: forbidden,
        });
        return safeError(c, {
          code: "PROHIBITED_CASE_CONTEXT_FIELD",
          message: "Trusted case context fields must not be supplied by the client.",
          status: 400,
        });
      }

      let parsedPayload;
      try {
        parsedPayload = parseCaseActionRequest(action, payload);
      } catch (error) {
        return validationError(c, error);
      }
      if (!parsedPayload) {
        return safeError(c, {
          code: "INVALID_CASE_ACTION",
          message: "The requested case action is not recognised.",
          status: 404,
        });
      }

      const idempotency = validateIdempotencyKey(c);
      if (!idempotency.ok) return idempotency.response;

      if (!caseWorkflowService?.isConfigured?.()) {
        return safeError(c, {
          code: "CASE_WORKFLOW_UNAVAILABLE",
          message: "The governed case workflow is temporarily unavailable.",
          status: 503,
        });
      }

      try {
        const result = await caseWorkflowService.performAction({
          caseId: c.req.param("caseId"),
          action,
          authContext: c.get("authContext") || null,
          tenantContext: c.get("tenantContext") || null,
          correlationId: c.get("requestId") || null,
          idempotencyKey: idempotency.key,
          payload: parsedPayload,
        });
        const response = caseActionSuccessResponseSchema.parse({
          caseId: result.case.caseId,
          state: result.case.currentState,
          stateVersion: result.case.stateVersion,
          transitionEventId: result.transitionEventId,
          operationId: result.operationId,
          correlationId: result.correlationId,
          replayed: result.replayed === true,
        });

        logger?.("info", result.replayed ? "case_action_replayed" : "case_action_completed", {
          caseId: response.caseId,
          transitionEventId: response.transitionEventId,
          operationId: response.operationId,
          actorId: c.get("authContext")?.user_id || null,
          role: (c.get("authContext")?.roles || [])[0] || null,
          correlationId: response.correlationId,
          state: response.state,
        });
        return c.json(response, result.replayed ? 200 : 201);
      } catch (error) {
        logger?.("warn", "case_action_rejected", {
          caseId: c.req.param("caseId"),
          actorId: c.get("authContext")?.user_id || null,
          correlationId: c.get("requestId") || null,
          errorCode: error?.code || "CASE_ACTION_FAILED",
        });
        return domainError(c, error);
      }
    },
  );
}
