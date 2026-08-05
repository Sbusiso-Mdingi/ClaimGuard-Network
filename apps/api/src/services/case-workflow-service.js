import crypto from "node:crypto";

import {
  CASE_ERROR_CODE,
  CASE_PERMISSION_POLICY_VERSION,
  CasePolicyError,
  canonicalCasePermissions,
  resolveCaseActionPolicy,
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

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function requiredString(value, fieldName, maxLength = 255) {
  if (typeof value !== "string" || !value.trim()) {
    throw new CasePolicyError(`${fieldName} is required.`, CASE_ERROR_CODE.VALIDATION_FAILED);
  }
  const normalized = value.trim();
  if (normalized.length > maxLength) {
    throw new CasePolicyError(`${fieldName} is too long.`, CASE_ERROR_CODE.VALIDATION_FAILED);
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

function boundedRoles(values) {
  return Object.freeze([...new Set(
    (Array.isArray(values) ? values : [])
      .filter((value) => typeof value === "string" && value.trim())
      .map((value) => value.trim())
      .filter((value) => value.length <= 64),
  )].sort());
}

function trustedActor({ authContext, tenantContext, requiredPermission = null }) {
  const actorId = requiredString(authContext?.user_id, "authenticated actor ID");
  const authTenantId = requiredString(authContext?.tenant_id, "authenticated tenant ID", 64);
  const routedTenantId = requiredString(tenantContext?.tenant_id, "routed tenant ID", 64);
  if (authTenantId !== routedTenantId) {
    throw new CasePolicyError(
      "Authenticated and routed tenant context do not match.",
      CASE_ERROR_CODE.TENANT_MISMATCH,
    );
  }
  const permissions = canonicalCasePermissions(authContext?.permissions);
  if (requiredPermission && !permissions.includes(requiredPermission)) {
    throw new CasePolicyError(
      "The authenticated actor lacks the required case permission.",
      CASE_ERROR_CODE.ROLE_NOT_AUTHORISED,
    );
  }
  return Object.freeze({
    actorId,
    tenantId: routedTenantId,
    roles: boundedRoles(authContext?.roles),
    permissions,
    permissionPolicyVersion: CASE_PERMISSION_POLICY_VERSION,
  });
}

export function resolveCaseAction(action) {
  return resolveCaseActionPolicy(action);
}

export function createCaseWorkflowService({ caseWorkflowRepository = null } = {}) {
  return {
    isConfigured() {
      return Boolean(
        caseWorkflowRepository
        && typeof caseWorkflowRepository.getCase === "function"
        && typeof caseWorkflowRepository.performAction === "function"
      );
    },

    async getCase({ caseId, authContext, tenantContext }) {
      if (!this.isConfigured()) throw new Error("Case workflow repository is not configured.");
      trustedActor({ authContext, tenantContext });
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
      if (!this.isConfigured()) throw new Error("Case workflow repository is not configured.");
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
      const actorContext = trustedActor({
        authContext,
        tenantContext,
        requiredPermission: policy.permission,
      });
      const operationId = sha256(stableStringify({
        tenantId: actorContext.tenantId,
        caseId: normalizedCaseId,
        idempotencyKey: normalizedIdempotencyKey,
      }));
      const result = await caseWorkflowRepository.performAction({
        caseId: normalizedCaseId,
        action,
        actorContext,
        expectedStateVersion: expectedVersion(payload?.expectedStateVersion),
        reasonCode: requiredString(payload?.reasonCode, "reasonCode", 128),
        reasonSummary: requiredString(payload?.reasonSummary, "reasonSummary", 1024),
        correlationId: normalizedCorrelationId,
        idempotencyKey: normalizedIdempotencyKey,
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
      return { ...result, operationId, correlationId: normalizedCorrelationId };
    },
  };
}
