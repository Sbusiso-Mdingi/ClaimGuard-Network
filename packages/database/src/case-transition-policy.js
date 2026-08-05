export const CASE_WORKFLOW_VERSION = 1;
export const CASE_PERMISSION_POLICY_VERSION = 1;

export const CASE_STATE = Object.freeze({
  SIGNAL_GENERATED: "SIGNAL_GENERATED",
  TRIAGE_PENDING: "TRIAGE_PENDING",
  DISMISSED: "DISMISSED",
  MONITORING: "MONITORING",
  INVESTIGATION_OPEN: "INVESTIGATION_OPEN",
  NOTICE_RECORDED: "NOTICE_RECORDED",
  RESPONSE_PENDING: "RESPONSE_PENDING",
  EVIDENCE_REVIEW: "EVIDENCE_REVIEW",
  INVESTIGATION_REPORT_COMPLETED: "INVESTIGATION_REPORT_COMPLETED",
  OUTCOME_REVIEW_PENDING: "OUTCOME_REVIEW_PENDING",
  OUTCOME_APPROVED: "OUTCOME_APPROVED",
  CLOSED_UNSUBSTANTIATED: "CLOSED_UNSUBSTANTIATED",
  APPEAL_OR_REVIEW: "APPEAL_OR_REVIEW",
});

export const DEFERRED_CASE_STATE = Object.freeze({
  NETWORK_NOTICE_ACTIVE: "NETWORK_NOTICE_ACTIVE",
  CORRECTED_OR_WITHDRAWN: "CORRECTED_OR_WITHDRAWN",
  EXPIRED_OR_SUPERSEDED: "EXPIRED_OR_SUPERSEDED",
});

// Retained only for service identity and historical audit compatibility.
export const CASE_ROLE = Object.freeze({
  DETECTION_SERVICE: "detection_service",
  SCHEME_ANALYST: "fraud_analyst",
  INVESTIGATOR: "investigator",
  INDEPENDENT_DECISION_MAKER: "applications_committee_member",
  PLATFORM_ADMINISTRATOR: "platform_administrator",
  REPORT_PRODUCER: "report_producer",
});

export const CASE_PERMISSION = Object.freeze({
  TRIAGE: "case.triage",
  DISMISS: "case.dismiss",
  MONITOR: "case.monitor",
  OPEN_INVESTIGATION: "case.open_investigation",
  RECORD_NOTICE: "case.record_notice",
  RECORD_RESPONSE: "case.record_response",
  REVIEW_EVIDENCE: "case.review_evidence",
  COMPLETE_REPORT: "case.complete_report",
  SUBMIT_OUTCOME_REVIEW: "case.submit_outcome_review",
  REVIEW_OUTCOME: "case.review_outcome",
  APPROVE_OUTCOME: "case.approve_outcome",
  CLOSE_UNSUBSTANTIATED: "case.close_unsubstantiated",
  OPEN_APPEAL_OR_REVIEW: "case.open_appeal_or_review",
  RETURN_FOR_FURTHER_EVIDENCE: "case.return_for_further_evidence",
});

export const CASE_ACTION_POLICY = Object.freeze({
  "begin-triage": Object.freeze({ toState: CASE_STATE.TRIAGE_PENDING, permission: CASE_PERMISSION.TRIAGE }),
  dismiss: Object.freeze({ toState: CASE_STATE.DISMISSED, permission: CASE_PERMISSION.DISMISS }),
  "begin-monitoring": Object.freeze({ toState: CASE_STATE.MONITORING, permission: CASE_PERMISSION.MONITOR }),
  "open-investigation": Object.freeze({ toState: CASE_STATE.INVESTIGATION_OPEN, permission: CASE_PERMISSION.OPEN_INVESTIGATION }),
  "record-notice": Object.freeze({ toState: CASE_STATE.NOTICE_RECORDED, permission: CASE_PERMISSION.RECORD_NOTICE }),
  "record-response-pending": Object.freeze({ toState: CASE_STATE.RESPONSE_PENDING, permission: CASE_PERMISSION.RECORD_RESPONSE }),
  "begin-evidence-review": Object.freeze({ toState: CASE_STATE.EVIDENCE_REVIEW, permission: CASE_PERMISSION.REVIEW_EVIDENCE }),
  "complete-investigation-report": Object.freeze({ toState: CASE_STATE.INVESTIGATION_REPORT_COMPLETED, permission: CASE_PERMISSION.COMPLETE_REPORT }),
  "submit-outcome-review": Object.freeze({ toState: CASE_STATE.OUTCOME_REVIEW_PENDING, permission: CASE_PERMISSION.SUBMIT_OUTCOME_REVIEW }),
  "approve-outcome": Object.freeze({ toState: CASE_STATE.OUTCOME_APPROVED, permission: CASE_PERMISSION.APPROVE_OUTCOME }),
  "close-unsubstantiated": Object.freeze({ toState: CASE_STATE.CLOSED_UNSUBSTANTIATED, permission: CASE_PERMISSION.CLOSE_UNSUBSTANTIATED }),
  "open-appeal-or-review": Object.freeze({ toState: CASE_STATE.APPEAL_OR_REVIEW, permission: CASE_PERMISSION.OPEN_APPEAL_OR_REVIEW }),
  "return-for-further-evidence": Object.freeze({ toState: CASE_STATE.EVIDENCE_REVIEW, permission: CASE_PERMISSION.RETURN_FOR_FURTHER_EVIDENCE }),
});

export const CASE_ERROR_CODE = Object.freeze({
  TRANSITION_NOT_PERMITTED: "CASE_TRANSITION_NOT_PERMITTED",
  ROLE_NOT_AUTHORISED: "CASE_ROLE_NOT_AUTHORISED",
  STATE_VERSION_CONFLICT: "CASE_STATE_VERSION_CONFLICT",
  IDEMPOTENCY_MISMATCH: "CASE_IDEMPOTENCY_MISMATCH",
  PROCESS_REQUIREMENTS_INCOMPLETE: "CASE_PROCESS_REQUIREMENTS_INCOMPLETE",
  REVIEWER_INDEPENDENCE_REQUIRED: "CASE_REVIEWER_INDEPENDENCE_REQUIRED",
  TENANT_MISMATCH: "CASE_TENANT_MISMATCH",
  NOT_FOUND: "CASE_NOT_FOUND",
  VALIDATION_FAILED: "CASE_VALIDATION_FAILED",
  NETWORK_NOTICE_GOVERNANCE_REQUIRED: "NETWORK_NOTICE_GOVERNANCE_REQUIRED",
});

const allowedTargets = Object.freeze({
  [CASE_STATE.SIGNAL_GENERATED]: Object.freeze([CASE_STATE.TRIAGE_PENDING]),
  [CASE_STATE.TRIAGE_PENDING]: Object.freeze([CASE_STATE.DISMISSED, CASE_STATE.MONITORING, CASE_STATE.INVESTIGATION_OPEN]),
  [CASE_STATE.DISMISSED]: Object.freeze([]),
  [CASE_STATE.MONITORING]: Object.freeze([CASE_STATE.TRIAGE_PENDING, CASE_STATE.INVESTIGATION_OPEN]),
  [CASE_STATE.INVESTIGATION_OPEN]: Object.freeze([CASE_STATE.NOTICE_RECORDED]),
  [CASE_STATE.NOTICE_RECORDED]: Object.freeze([CASE_STATE.RESPONSE_PENDING, CASE_STATE.EVIDENCE_REVIEW]),
  [CASE_STATE.RESPONSE_PENDING]: Object.freeze([CASE_STATE.EVIDENCE_REVIEW]),
  [CASE_STATE.EVIDENCE_REVIEW]: Object.freeze([CASE_STATE.INVESTIGATION_REPORT_COMPLETED]),
  [CASE_STATE.INVESTIGATION_REPORT_COMPLETED]: Object.freeze([CASE_STATE.OUTCOME_REVIEW_PENDING]),
  [CASE_STATE.OUTCOME_REVIEW_PENDING]: Object.freeze([CASE_STATE.OUTCOME_APPROVED, CASE_STATE.EVIDENCE_REVIEW, CASE_STATE.CLOSED_UNSUBSTANTIATED]),
  [CASE_STATE.OUTCOME_APPROVED]: Object.freeze([CASE_STATE.APPEAL_OR_REVIEW]),
  [CASE_STATE.CLOSED_UNSUBSTANTIATED]: Object.freeze([CASE_STATE.APPEAL_OR_REVIEW]),
  [CASE_STATE.APPEAL_OR_REVIEW]: Object.freeze([CASE_STATE.EVIDENCE_REVIEW, CASE_STATE.OUTCOME_REVIEW_PENDING, CASE_STATE.CLOSED_UNSUBSTANTIATED, CASE_STATE.OUTCOME_APPROVED]),
});

const STATUS_BY_CODE = Object.freeze({
  [CASE_ERROR_CODE.VALIDATION_FAILED]: 400,
  [CASE_ERROR_CODE.PROCESS_REQUIREMENTS_INCOMPLETE]: 422,
  [CASE_ERROR_CODE.STATE_VERSION_CONFLICT]: 409,
  [CASE_ERROR_CODE.IDEMPOTENCY_MISMATCH]: 409,
  [CASE_ERROR_CODE.REVIEWER_INDEPENDENCE_REQUIRED]: 409,
  [CASE_ERROR_CODE.NETWORK_NOTICE_GOVERNANCE_REQUIRED]: 409,
  [CASE_ERROR_CODE.TENANT_MISMATCH]: 404,
  [CASE_ERROR_CODE.ROLE_NOT_AUTHORISED]: 403,
  [CASE_ERROR_CODE.TRANSITION_NOT_PERMITTED]: 409,
  [CASE_ERROR_CODE.NOT_FOUND]: 404,
});

export class CasePolicyError extends Error {
  constructor(message, code, status = STATUS_BY_CODE[code] || 400) {
    super(message);
    this.name = "CasePolicyError";
    this.code = code;
    this.status = status;
  }
}

export function canonicalCasePermissions(values) {
  return Object.freeze([...new Set(
    (values instanceof Set ? [...values] : Array.isArray(values) ? values : [])
      .filter((value) => typeof value === "string" && value.trim())
      .map((value) => value.trim()),
  )].sort());
}

export function resolveCaseActionPolicy(action) {
  return CASE_ACTION_POLICY[action] || null;
}

export function isDeferredCaseState(state) {
  return Object.values(DEFERRED_CASE_STATE).includes(state);
}

export function isCaseState(state) {
  return Object.values(CASE_STATE).includes(state);
}

export function canTransitionCaseState(fromState, toState) {
  return allowedTargets[fromState]?.includes(toState) ?? false;
}

export function assertCaseTransition({
  action,
  fromState,
  toState,
  actorContext,
  actorId = actorContext?.actorId,
  reportCompletingInvestigatorId = null,
}) {
  if (isDeferredCaseState(toState)) {
    throw new CasePolicyError(
      "Network-notice lifecycle states require separate sharing governance.",
      CASE_ERROR_CODE.NETWORK_NOTICE_GOVERNANCE_REQUIRED,
    );
  }
  const actionPolicy = resolveCaseActionPolicy(action);
  if (!actionPolicy || actionPolicy.toState !== toState) {
    throw new CasePolicyError("The requested case action is not permitted.", CASE_ERROR_CODE.TRANSITION_NOT_PERMITTED);
  }
  if (!isCaseState(fromState) || !isCaseState(toState) || !canTransitionCaseState(fromState, toState)) {
    throw new CasePolicyError("The requested case transition is not permitted.", CASE_ERROR_CODE.TRANSITION_NOT_PERMITTED);
  }
  const permissions = canonicalCasePermissions(actorContext?.permissions);
  if (!permissions.includes(actionPolicy.permission)) {
    throw new CasePolicyError(
      "The authenticated actor lacks the required case permission.",
      CASE_ERROR_CODE.ROLE_NOT_AUTHORISED,
    );
  }
  if (toState === CASE_STATE.OUTCOME_APPROVED
      && reportCompletingInvestigatorId
      && actorId === reportCompletingInvestigatorId) {
    throw new CasePolicyError(
      "The outcome reviewer must be independent from the report-completing investigator.",
      CASE_ERROR_CODE.REVIEWER_INDEPENDENCE_REQUIRED,
    );
  }
  return actionPolicy;
}

function hasText(value) {
  return typeof value === "string" && Boolean(value.trim());
}

function hasArrayValues(value) {
  return Array.isArray(value) && value.length > 0;
}

export function assertCaseProcessRequirements({
  fromState,
  toState,
  actorId,
  assignedInvestigatorId = null,
  reportCompletingInvestigatorId = null,
  reportCompletionEventId = null,
  evidenceReferences = [],
  processCheckReferences = [],
  noEvidenceReason = null,
  reportReference = null,
  reportDigest = null,
  completionReason = null,
  outcomeCode = null,
  allowedOutcomeCodes = [],
  recordedReasons = null,
  identityMatchReviewResult = null,
  supportingReportReference = null,
  evidenceSetReference = null,
  processCheckComplete = false,
}) {
  if (toState === CASE_STATE.INVESTIGATION_REPORT_COMPLETED) {
    if (!hasText(assignedInvestigatorId) || actorId !== assignedInvestigatorId) {
      throw new CasePolicyError("The assigned investigator must complete the investigation report.", CASE_ERROR_CODE.PROCESS_REQUIREMENTS_INCOMPLETE);
    }
    if (!hasArrayValues(evidenceReferences) && !hasText(noEvidenceReason)) {
      throw new CasePolicyError("Persisted evidence or an explicit no-evidence reason is required before report completion.", CASE_ERROR_CODE.PROCESS_REQUIREMENTS_INCOMPLETE);
    }
    if (!hasText(reportReference) && !hasText(reportDigest)) {
      throw new CasePolicyError("A report reference or immutable report digest is required before report completion.", CASE_ERROR_CODE.PROCESS_REQUIREMENTS_INCOMPLETE);
    }
    if (!hasText(completionReason)) {
      throw new CasePolicyError("A report-completion reason is required.", CASE_ERROR_CODE.PROCESS_REQUIREMENTS_INCOMPLETE);
    }
  }
  if (toState === CASE_STATE.OUTCOME_REVIEW_PENDING
      && (!hasText(reportCompletingInvestigatorId)
        || !hasText(reportCompletionEventId)
        || !hasArrayValues(processCheckReferences))) {
    throw new CasePolicyError("A completed investigator report and recorded process checks are required before outcome review.", CASE_ERROR_CODE.PROCESS_REQUIREMENTS_INCOMPLETE);
  }
  if (toState === CASE_STATE.OUTCOME_APPROVED) {
    if (!hasText(reportCompletingInvestigatorId)) {
      throw new CasePolicyError("The report-completing investigator must be known before approval.", CASE_ERROR_CODE.PROCESS_REQUIREMENTS_INCOMPLETE);
    }
    if (actorId === reportCompletingInvestigatorId) {
      throw new CasePolicyError("The outcome reviewer must be independent from the report-completing investigator.", CASE_ERROR_CODE.REVIEWER_INDEPENDENCE_REQUIRED);
    }
    const configuredCodes = new Set((allowedOutcomeCodes || []).filter(hasText).map((code) => code.trim()));
    if (!hasText(outcomeCode) || !configuredCodes.has(outcomeCode.trim())) {
      throw new CasePolicyError("The outcome code is not in the configured bounded outcome catalogue.", CASE_ERROR_CODE.PROCESS_REQUIREMENTS_INCOMPLETE);
    }
    if (!(hasText(recordedReasons) || hasArrayValues(recordedReasons))) {
      throw new CasePolicyError("Recorded outcome reasons are required.", CASE_ERROR_CODE.PROCESS_REQUIREMENTS_INCOMPLETE);
    }
    if (!identityMatchReviewResult || typeof identityMatchReviewResult !== "object") {
      throw new CasePolicyError("An identity-match review result is required.", CASE_ERROR_CODE.PROCESS_REQUIREMENTS_INCOMPLETE);
    }
    if (!hasText(supportingReportReference) && !hasText(evidenceSetReference)) {
      throw new CasePolicyError("A supporting report or evidence-set reference is required.", CASE_ERROR_CODE.PROCESS_REQUIREMENTS_INCOMPLETE);
    }
    if (!processCheckComplete) {
      throw new CasePolicyError("Required process checks must be complete before approval.", CASE_ERROR_CODE.PROCESS_REQUIREMENTS_INCOMPLETE);
    }
  }
  if (fromState === CASE_STATE.MONITORING
      && [CASE_STATE.TRIAGE_PENDING, CASE_STATE.INVESTIGATION_OPEN].includes(toState)
      && !hasText(completionReason)) {
    throw new CasePolicyError("Reopening a monitored case requires an explicit reason.", CASE_ERROR_CODE.PROCESS_REQUIREMENTS_INCOMPLETE);
  }
  return true;
}

export function listPermittedCaseTransitions() {
  return Object.fromEntries(Object.entries(allowedTargets).map(([state, targets]) => [state, [...targets]]));
}
