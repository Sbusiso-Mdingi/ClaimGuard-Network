import {
  CASE_ERROR_CODE,
  CASE_ROLE,
  CASE_STATE,
  CasePolicyError,
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
    role: CASE_ROLE.SCHEME_ANALYST,
  }),
  [CASE_ACTION.DISMISS]: Object.freeze({
    toState: CASE_STATE.DISMISSED,
    role: CASE_ROLE.SCHEME_ANALYST,
  }),
  [CASE_ACTION.BEGIN_MONITORING]: Object.freeze({
    toState: CASE_STATE.MONITORING,
    role: CASE_ROLE.SCHEME_ANALYST,
  }),
  [CASE_ACTION.OPEN_INVESTIGATION]: Object.freeze({
    toState: CASE_STATE.INVESTIGATION_OPEN,
    role: CASE_ROLE.SCHEME_ANALYST,
  }),
  [CASE_ACTION.RECORD_NOTICE]: Object.freeze({
    toState: CASE_STATE.NOTICE_RECORDED,
    role: CASE_ROLE.INVESTIGATOR,
  }),
  [CASE_ACTION.RECORD_RESPONSE_PENDING]: Object.freeze({
    toState: CASE_STATE.RESPONSE_PENDING,
    role: CASE_ROLE.INVESTIGATOR,
  }),
  [CASE_ACTION.BEGIN_EVIDENCE_REVIEW]: Object.freeze({
    toState: CASE_STATE.EVIDENCE_REVIEW,
    role: CASE_ROLE.INVESTIGATOR,
  }),
  [CASE_ACTION.COMPLETE_INVESTIGATION_REPORT]: Object.freeze({
    toState: CASE_STATE.INVESTIGATION_REPORT_COMPLETED,
    role: CASE_ROLE.INVESTIGATOR,
  }),
  [CASE_ACTION.SUBMIT_OUTCOME_REVIEW]: Object.freeze({
    toState: CASE_STATE.OUTCOME_REVIEW_PENDING,
    role: CASE_ROLE.INVESTIGATOR,
  }),
  [CASE_ACTION.APPROVE_OUTCOME]: Object.freeze({
    toState: CASE_STATE.OUTCOME_APPROVED,
    role: CASE_ROLE.INDEPENDENT_DECISION_MAKER,
  }),
  [CASE_ACTION.CLOSE_UNSUBSTANTIATED]: Object.freeze({
    toState: CASE_STATE.CLOSED_UNSUBSTANTIATED,
    role: CASE_ROLE.INDEPENDENT_DECISION_MAKER,
  }),
  [CASE_ACTION.OPEN_APPEAL_OR_REVIEW]: Object.freeze({
    toState: CASE_STATE.APPEAL_OR_REVIEW,
    role: CASE_ROLE.INDEPENDENT_DECISION_MAKER,
  }),
  [CASE_ACTION.RETURN_FOR_FURTHER_EVIDENCE]: Object.freeze({
    toState: CASE_STATE.EVIDENCE_REVIEW,
    role: CASE_ROLE.INDEPENDENT_DECISION_MAKER,
  }),
});

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
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new CasePolicyError(
      "A current case state version is required.",
      CASE_ERROR_CODE.VALIDATION_FAILED,
    );
  }
  return parsed;
}

function trustedActor({ authContext, tenantContext, requiredRole }) {
  const actorId = requiredString(authContext?.user_id, "authenticated actor ID");
  const authTenantId = requiredString(authContext?.tenant_id, "authenticated tenant ID", 64);
  const routedTenantId = requiredString(tenantContext?.tenant_id, "routed tenant ID", 64);

  if (authTenantId !== routedTenantId) {
    throw new CasePolicyError(
      "Authenticated and routed tenant context do not match.",
      CASE_ERROR_CODE.TENANT_MISMATCH,
    );
  }

  const authoritativeRoles = Array.isArray(authContext?.roles) ? authContext.roles : [];
  if (!authoritativeRoles.includes(requiredRole)) {
    throw new CasePolicyError(
      "The authenticated actor role cannot perform this case action.",
      CASE_ERROR_CODE.ROLE_NOT_AUTHORISED,
    );
  }

  return {
    actorId,
    actorRole: requiredRole,
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
      trustedActor({
        authContext,
        tenantContext,
        requiredRole: (authContext?.roles || []).find((role) => Object.values(CASE_ROLE).includes(role)),
      });
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

      const actor = trustedActor({
        authContext,
        tenantContext,
        requiredRole: policy.role,
      });

      return caseWorkflowRepository.transitionCase({
        caseId: requiredString(caseId, "caseId", 64),
        toState: policy.toState,
        expectedStateVersion: expectedVersion(payload?.expectedStateVersion),
        reasonCode: requiredString(payload?.reasonCode, "reasonCode", 128),
        reasonSummary: requiredString(payload?.reasonSummary, "reasonSummary", 1024),
        correlationId: requiredString(correlationId, "correlationId", 128),
        idempotencyKey: requiredString(idempotencyKey, "idempotencyKey", 128),
        actorId: actor.actorId,
        actorRole: actor.actorRole,
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
    },
  };
}
