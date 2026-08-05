import assert from "node:assert/strict";
import test from "node:test";

import {
  assertCaseProcessRequirements,
  assertCaseTransition,
  canTransitionCaseState,
  CASE_ERROR_CODE,
  CASE_ROLE,
  CASE_STATE,
  DEFERRED_CASE_STATE,
  listPermittedCaseTransitions,
} from "../src/case-transition-policy.js";

test("the documented transition matrix is central and complete", () => {
  const transitions = listPermittedCaseTransitions();
  assert.deepEqual(transitions[CASE_STATE.SIGNAL_GENERATED], [CASE_STATE.TRIAGE_PENDING]);
  assert.deepEqual(transitions[CASE_STATE.MONITORING], [CASE_STATE.TRIAGE_PENDING, CASE_STATE.INVESTIGATION_OPEN]);
  assert.deepEqual(transitions[CASE_STATE.OUTCOME_REVIEW_PENDING], [
    CASE_STATE.OUTCOME_APPROVED,
    CASE_STATE.EVIDENCE_REVIEW,
    CASE_STATE.CLOSED_UNSUBSTANTIATED,
  ]);
  assert.equal(canTransitionCaseState(CASE_STATE.SIGNAL_GENERATED, CASE_STATE.OUTCOME_APPROVED), false);
  assert.equal(canTransitionCaseState(CASE_STATE.INVESTIGATION_REPORT_COMPLETED, CASE_STATE.OUTCOME_APPROVED), false);
});

test("analyst may triage but cannot approve an outcome", () => {
  assert.equal(assertCaseTransition({
    fromState: CASE_STATE.SIGNAL_GENERATED,
    toState: CASE_STATE.TRIAGE_PENDING,
    actorRole: CASE_ROLE.SCHEME_ANALYST,
    actorId: "analyst-1",
  }), true);
  assert.throws(() => assertCaseTransition({
    fromState: CASE_STATE.OUTCOME_REVIEW_PENDING,
    toState: CASE_STATE.OUTCOME_APPROVED,
    actorRole: CASE_ROLE.SCHEME_ANALYST,
    actorId: "analyst-1",
  }), (error) => error.code === CASE_ERROR_CODE.ROLE_NOT_AUTHORISED);
});

test("investigator may complete and submit a report but cannot approve the outcome", () => {
  assert.equal(assertCaseTransition({
    fromState: CASE_STATE.EVIDENCE_REVIEW,
    toState: CASE_STATE.INVESTIGATION_REPORT_COMPLETED,
    actorRole: CASE_ROLE.INVESTIGATOR,
    actorId: "investigator-1",
  }), true);
  assert.equal(assertCaseTransition({
    fromState: CASE_STATE.INVESTIGATION_REPORT_COMPLETED,
    toState: CASE_STATE.OUTCOME_REVIEW_PENDING,
    actorRole: CASE_ROLE.INVESTIGATOR,
    actorId: "investigator-1",
  }), true);
  assert.throws(() => assertCaseTransition({
    fromState: CASE_STATE.OUTCOME_REVIEW_PENDING,
    toState: CASE_STATE.OUTCOME_APPROVED,
    actorRole: CASE_ROLE.INVESTIGATOR,
    actorId: "investigator-1",
  }), (error) => error.code === CASE_ERROR_CODE.ROLE_NOT_AUTHORISED);
});

test("independent reviewer cannot approve their own investigator report", () => {
  assert.throws(() => assertCaseTransition({
    fromState: CASE_STATE.OUTCOME_REVIEW_PENDING,
    toState: CASE_STATE.OUTCOME_APPROVED,
    actorRole: CASE_ROLE.INDEPENDENT_DECISION_MAKER,
    actorId: "actor-1",
    reportCompletingInvestigatorId: "actor-1",
  }), (error) => error.code === CASE_ERROR_CODE.REVIEWER_INDEPENDENCE_REQUIRED);
});

test("platform administrator, detection service and report producer cannot force human transitions", () => {
  for (const actorRole of [CASE_ROLE.PLATFORM_ADMINISTRATOR, CASE_ROLE.DETECTION_SERVICE, CASE_ROLE.REPORT_PRODUCER]) {
    assert.throws(() => assertCaseTransition({
      fromState: CASE_STATE.SIGNAL_GENERATED,
      toState: CASE_STATE.TRIAGE_PENDING,
      actorRole,
      actorId: "service-actor",
    }), (error) => error.code === CASE_ERROR_CODE.ROLE_NOT_AUTHORISED);
  }
});

test("deferred network-notice states fail with the stable governance error", () => {
  for (const toState of Object.values(DEFERRED_CASE_STATE)) {
    assert.throws(() => assertCaseTransition({
      fromState: CASE_STATE.OUTCOME_APPROVED,
      toState,
      actorRole: CASE_ROLE.INDEPENDENT_DECISION_MAKER,
      actorId: "reviewer-1",
    }), (error) => error.code === CASE_ERROR_CODE.NETWORK_NOTICE_GOVERNANCE_REQUIRED);
  }
});

test("report completion requires assignment, evidence or exception, report reference and reason", () => {
  assert.throws(() => assertCaseProcessRequirements({
    fromState: CASE_STATE.EVIDENCE_REVIEW,
    toState: CASE_STATE.INVESTIGATION_REPORT_COMPLETED,
    actorId: "investigator-1",
    assignedInvestigatorId: "investigator-1",
  }), (error) => error.code === CASE_ERROR_CODE.PROCESS_REQUIREMENTS_INCOMPLETE);

  assert.equal(assertCaseProcessRequirements({
    fromState: CASE_STATE.EVIDENCE_REVIEW,
    toState: CASE_STATE.INVESTIGATION_REPORT_COMPLETED,
    actorId: "investigator-1",
    assignedInvestigatorId: "investigator-1",
    evidenceReferences: ["evidence-1"],
    reportDigest: "a".repeat(64),
    completionReason: "INVESTIGATION_COMPLETE",
  }), true);
});

test("outcome approval requires a configured neutral code and complete review inputs", () => {
  assert.throws(() => assertCaseProcessRequirements({
    fromState: CASE_STATE.OUTCOME_REVIEW_PENDING,
    toState: CASE_STATE.OUTCOME_APPROVED,
    actorId: "reviewer-1",
    reportCompletingInvestigatorId: "investigator-1",
    outcomeCode: "CONFIRMED_FRAUD",
    allowedOutcomeCodes: ["SUPPORTED_CONCERN"],
    recordedReasons: ["reason"],
    identityMatchReviewResult: { reviewed: true },
    supportingReportReference: "report-1",
    processCheckComplete: true,
  }), (error) => error.code === CASE_ERROR_CODE.PROCESS_REQUIREMENTS_INCOMPLETE);

  assert.equal(assertCaseProcessRequirements({
    fromState: CASE_STATE.OUTCOME_REVIEW_PENDING,
    toState: CASE_STATE.OUTCOME_APPROVED,
    actorId: "reviewer-1",
    reportCompletingInvestigatorId: "investigator-1",
    outcomeCode: "SUPPORTED_CONCERN",
    allowedOutcomeCodes: ["SUPPORTED_CONCERN"],
    recordedReasons: ["reason"],
    identityMatchReviewResult: { reviewed: true },
    supportingReportReference: "report-1",
    processCheckComplete: true,
  }), true);
});

test("reopening monitoring requires an explicit reason", () => {
  assert.throws(() => assertCaseProcessRequirements({
    fromState: CASE_STATE.MONITORING,
    toState: CASE_STATE.INVESTIGATION_OPEN,
    actorId: "analyst-1",
  }), (error) => error.code === CASE_ERROR_CODE.PROCESS_REQUIREMENTS_INCOMPLETE);
});
