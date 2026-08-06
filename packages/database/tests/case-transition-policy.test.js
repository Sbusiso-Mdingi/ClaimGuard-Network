import assert from "node:assert/strict";
import test from "node:test";

import {
  assertCaseProcessRequirements,
  assertCaseTransition,
  canTransitionCaseState,
  CASE_ERROR_CODE,
  CASE_PERMISSION,
  CASE_PERMISSION_POLICY_VERSION,
  CASE_STATE,
  DEFERRED_CASE_STATE,
  listPermittedCaseTransitions,
} from "../src/case-transition-policy.js";

function actor(actorId, permissions, roles = []) {
  return Object.freeze({
    actorId,
    tenantId: "tenant-a",
    permissions: Object.freeze([...permissions]),
    roles: Object.freeze([...roles]),
    permissionPolicyVersion: CASE_PERMISSION_POLICY_VERSION,
  });
}

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

test("triage permission authorises triage but not outcome approval", () => {
  assert.equal(assertCaseTransition({
    action: "begin-triage",
    fromState: CASE_STATE.SIGNAL_GENERATED,
    toState: CASE_STATE.TRIAGE_PENDING,
    actorContext: actor("analyst-1", [CASE_PERMISSION.TRIAGE], ["fraud_analyst"]),
  }).permission, CASE_PERMISSION.TRIAGE);
  assert.throws(() => assertCaseTransition({
    action: "approve-outcome",
    fromState: CASE_STATE.OUTCOME_REVIEW_PENDING,
    toState: CASE_STATE.OUTCOME_APPROVED,
    actorContext: actor("analyst-1", [CASE_PERMISSION.TRIAGE], ["fraud_analyst"]),
  }), (error) => error.code === CASE_ERROR_CODE.ROLE_NOT_AUTHORISED);
});

test("report permissions do not authorise outcome approval", () => {
  assert.equal(assertCaseTransition({
    action: "complete-investigation-report",
    fromState: CASE_STATE.EVIDENCE_REVIEW,
    toState: CASE_STATE.INVESTIGATION_REPORT_COMPLETED,
    actorContext: actor("investigator-1", [CASE_PERMISSION.COMPLETE_REPORT]),
  }).permission, CASE_PERMISSION.COMPLETE_REPORT);
  assert.throws(() => assertCaseTransition({
    action: "approve-outcome",
    fromState: CASE_STATE.OUTCOME_REVIEW_PENDING,
    toState: CASE_STATE.OUTCOME_APPROVED,
    actorContext: actor("investigator-1", [CASE_PERMISSION.COMPLETE_REPORT]),
  }), (error) => error.code === CASE_ERROR_CODE.ROLE_NOT_AUTHORISED);
});

test("approval permission cannot override reviewer independence", () => {
  assert.throws(() => assertCaseTransition({
    action: "approve-outcome",
    fromState: CASE_STATE.OUTCOME_REVIEW_PENDING,
    toState: CASE_STATE.OUTCOME_APPROVED,
    actorContext: actor("actor-1", [CASE_PERMISSION.APPROVE_OUTCOME]),
    reportCompletingInvestigatorId: "actor-1",
  }), (error) => error.code === CASE_ERROR_CODE.REVIEWER_INDEPENDENCE_REQUIRED);
});

test("platform administration and service identities receive no implicit override", () => {
  for (const role of ["platform_administrator", "detection_service", "report_producer"]) {
    assert.throws(() => assertCaseTransition({
      action: "begin-triage",
      fromState: CASE_STATE.SIGNAL_GENERATED,
      toState: CASE_STATE.TRIAGE_PENDING,
      actorContext: actor("service-actor", [], [role]),
    }), (error) => error.code === CASE_ERROR_CODE.ROLE_NOT_AUTHORISED);
  }
});

test("action cannot be used to select a different target state", () => {
  assert.throws(() => assertCaseTransition({
    action: "begin-triage",
    fromState: CASE_STATE.SIGNAL_GENERATED,
    toState: CASE_STATE.OUTCOME_APPROVED,
    actorContext: actor("analyst-1", [CASE_PERMISSION.TRIAGE]),
  }), (error) => error.code === CASE_ERROR_CODE.TRANSITION_NOT_PERMITTED);
});

test("deferred network-notice states fail with the stable governance error", () => {
  for (const toState of Object.values(DEFERRED_CASE_STATE)) {
    assert.throws(() => assertCaseTransition({
      action: "approve-outcome",
      fromState: CASE_STATE.OUTCOME_APPROVED,
      toState,
      actorContext: actor("reviewer-1", [CASE_PERMISSION.APPROVE_OUTCOME]),
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
