import crypto from "node:crypto";

import {
  CASE_ERROR_CODE,
  CASE_PERMISSION,
  CASE_STATE,
  CasePolicyError,
  stableStringify,
} from "@claimguard/database";

export const CASE_ACTION = Object.freeze({
  BEGIN_TRIAGE: "begin-triage",
  DISMISS: "dismiss",
  BEGIN_MONITORING: "begin-monitoring",
  OPEN_INVESTIGATION: "open-investigation",
  RECORD_NOTICE: "record-notice",
  RECORD_RESPONSE_PENDING: "record-response-pending",
  BEGIN_EVIDENCE_REVIEW: "begin-evidence-review",
  COMPLETE_INVESTIGATION_REPORT: "complete-investigation-report",
  SUBMIT_OUTCOME_REVIEW: "submit-outcome-review",
  APPROVE_OUTCOME: "approve-outcome",
  CLOSE_UNSUBSTANTIATED: "close-unsubstantiated",
  OPEN_APPEAL_OR_REVIEW: "open-appeal-or-review",
  RETURN_FOR_FURTHER_EVIDENCE: "return-for-further-evidence",
});

const ACTION_POLICY = Object.freeze({
  [CASE_ACTION.BEGIN_TRIAGE]: Object.freeze({
    toState: CASE_STATE.TRIAGE_PENDING,
    permission: CASE_PERMISSION.TRIAGE,
  }),
  [CASE_ACTION.DISMISS]: Object.freeze({
    toState: CASE_STATE.DISMISSED,
    permission: CASE_PERMISSION.DISMISS,
  }),
  [CASE_ACTION.BEGIN_MONITORING]: Object.freeze({
    toState: CASE_STATE.MONITORING,
    permission: CASE_PERMISSION.MONITOR,
  }),
  [CASE_ACTION.OPEN_INVESTIGATION]: Object.freeze({
    toState: CASE_STATE.INVESTIGATION_OPEN,
    permission: CASE_PERMISSION.OPEN_INVESTIGATION,
  }),
  [CASE_ACTION.RECORD_NOTICE]: Object.freeze({
    toState: CASE_STATE.NOTICE_RECORDED,
    permission: CASE_PERMISSION.RECORD_NOTICE,
  }),
  [CASE_ACTION.RECORD_RESPONSE_PENDING]: Object.freeze({
    toState: CASE_STATE.RESPONSE_PENDING,
    permission: CASE_PERMISSION.RECORD_RESPONSE,
  }),
  [CASE_ACTION.BEGIN_EVIDENCE_REVIEW]: Object.freeze({
    toState: CASE_STATE.EVIDENCE_REVIEW,
    permission: CASE_PERMISSION.REVIEW_EVIDENCE,
  }),
  [CASE_ACTION.COMPLETE_INVESTIGATION_REPORT]: Object.freeze({
    toState: CASE_STATE.INVESTIGATION_REPORT_COMPLETED,
    permission: CASE_PERMISSION.COMPLETE_REPORT,
  }),
  [CASE_ACTION.SUBMIT_OUTCOME_REVIEW]: Object.freeze({
    toState: CASE_STATE.OUTCOME_REVIEW_PENDING,
    permission: CASE_PERMISSION.SUBMIT_OUTCOME_REVIEW,
  }),
  [CASE_ACTION.APPROVE_OUTCOME]: Object.freeze({
    toState: CASE_STATE.OUTCOME_APPROVED,
    permission: CASE_PERMISSION.APPROVE_OUTCOME,
  }),
  [CASE_ACTION.CLOSE_UNSUBSTANTIATED]: Object.freeze({
    toState: CASE_STATE.CLOSED_UNSUBSTANTIATED,
    permission: CASE_PERMISSION.CLOSE_UNSUBSTANTIATED,
  }),
  [CASE_ACTION.OPEN_APPEAL_OR_REVIEW]: Object.freeze({
    toState: CASE_STATE.APPEAL_OR_REVIEW,
    permission: CASE_PERMISSION.OPEN_APPEAL_OR_REVIEW,
  }),
  [CASE_ACTION.RETURN_FOR_FURTHER_EVIDENCE]: Object.freeze({
    toState: CASE_STATE.EVIDENCE_REVIEW,
    permission: CASE_PERMISSION.RETURN_FOR_FURTHER_EVIDENCE,
  }),
});

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function requiredString(value, fieldName, maxLength = 255) {
  if (typeof value !== "string" || !value.trim()) {
    throw new CasePolicyError(
      `${fieldName} is required.`,
      CASE_ERROR_CODE.VALIDATION_FAILED,
    );
  }
  const normalized = value.trim();
  if (normalized.length > maxLength) {
    throw new CasePolicyError(
      `${fieldName} is too long.`,
      CASE_ERROR_CODE.VALIDATION_FAILED,
    );
  }
  return normalized;
}

function expectedVersion(value) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 2_147_483_647) {
    throw new CasePolicyError(
      "A positive bounded case state version is required.",
      CASE_ERROR_CODE.VALIDATION_FAILED,
    );
  }
  return parsed;
}

function trustedActor({ authContext, tenantContext, requiredPermission }) {
  const actorId = requiredString(authContext?.user_id, "authenticated actor ID");
  const authTenantId = requiredString(authContext?.tenant_id, "authenticated tenant ID", 64);
  const routedTenantId = requiredString(tenantContext?.tenant_id, "routed tenant ID", 64);

  if (authTenantId !== routedTenantId) {
    throw new CasePolicyError(
      "Authenticated and routed tenant context do not match.",
      CASE_ERROR_CODE.TENANT_MISMATCH,
    );
  }

  const authoritativePermissions = authContext?.permissions instanceof Set
    ? authContext.permissions
    : new Set(Array.isArray(authContext?.permissions) ? authContext.permissions : []);
  if (requiredPermission && !authoritativePermissions.has(requiredPermission)) {
    throw new CasePolicyError(
      "The authenticated actor lacks the required case permission.",
      CASE_ERROR_CODE.ROLE_NOT_AUTHORISED,
    );
  }

  return {
    actorId,
    actorPermission: requiredPermission || null,
    tenantId: routedTenantId,
  };
}

export function resolveCaseAction(action) {
  return ACTION_POLICY[action] || null;
}

export function createCaseWorkflowService({ caseWorkflowRepository = null } = {}) {
  return {
    isConfigured() {
      return Boolean(
        caseWorkflowRepository
        && typeof caseWorkflowRepository.getCase === "function"
        && typeof caseWorkflowRepository.transitionCase === "function"
      );
    },

    async getCase({ caseId, authContext, tenantContext }) {
      if (!this.isConfigured()) {
        throw new Error("Case workflow repository is not configured.");
      }
      trustedActor({ authContext, tenantContext, requiredPermission: null });
      return caseWorkflowRepository.getCase(requiredString(caseId, "caseId", 64));
    },

    async performAction({
      caseId,
      action,
      authContext,
      tenantContext,
      correlationId,
      idempotencyKey,
      payload = {},
    }) {
      if (!this.isConfigured()) {
        throw new Error("Case workflow repository is not configured.");
      }

      const policy = resolveCaseAction(action);
      if (!policy) {
        throw new CasePolicyError(
          "The requested case action is not recognised.",
          CASE_ERROR_CODE.TRANSITION_NOT_PERMITTED,
        );
      }

      const normalizedCaseId = requiredString(caseId, "caseId", 64);
      const normalizedCorrelationId = requiredString(correlationId, "correlationId", 128);
      const normalizedIdempotencyKey = requiredString(idempotencyKey, "idempotencyKey", 128);
      const actor = trustedActor({
        authContext,
        tenantContext,
        requiredPermission: policy.permission,
      });
      const operationId = sha256(stableStringify({
        tenantId: actor.tenantId,
        caseId: normalizedCaseId,
        idempotencyKey: normalizedIdempotencyKey,
      }));

      const result = await caseWorkflowRepository.transitionCase({
        caseId: normalizedCaseId,
        toState: policy.toState,
        expectedStateVersion: expectedVersion(payload?.expectedStateVersion),
        reasonCode: requiredString(payload?.reasonCode, "reasonCode", 128),
        reasonSummary: requiredString(payload?.reasonSummary, "reasonSummary", 1024),
        correlationId: normalizedCorrelationId,
        idempotencyKey: normalizedIdempotencyKey,
        actorId: actor.actorId,
        // Stored in the existing audit column; it now records the authoritative
        // permission used for this transition rather than a client-selected role.
        actorRole: actor.actorPermission,
        assignedInvestigatorId: payload?.assignedInvestigatorId,
        evidenceReferences: payload?.evidenceReferences,
        processCheckReferences: payload?.processCheckReferences,
        noEvidenceReason: payload?.noEvidenceReason,
        reportReference: payload?.reportReference,
        reportDigest: payload?.reportDigest,
        completionReason: payload?.completionReason,
        outcomeCode: payload?.outcomeCode,
        recordedReasons: payload?.recordedReasons,
        identityMatchReviewResult: payload?.identityMatchReviewResult,
        supportingReportReference: payload?.supportingReportReference,
        evidenceSetReference: payload?.evidenceSetReference,
        processCheckComplete: payload?.processCheckComplete,
      });

      return {
        ...result,
        operationId,
        correlationId: normalizedCorrelationId,
      };
    },
  };
}
