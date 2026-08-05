import assert from "node:assert/strict";
import test from "node:test";

import {
  assertCaseTransition,
  canTransitionCaseState,
  CASE_ERROR_CODE,
  CASE_ROLE,
  CASE_STATE,
  DEFERRED_CASE_STATE,
  listPermittedCaseTransitions,
} from "../src/case-transition-policy.js";

test("documented transitions are represented centrally", () => {
  const transitions = listPermittedCaseTransitions();
  assert.deepEqual(transitions[CASE_STATE.SIGNAL_GENERATED], [CASE_STATE.TRIAGE_PENDING]);
  assert.equal(canTransitionCaseState(CASE_STATE.OUTCOME_REVIEW_PENDING, CASE_STATE.OUTCOME_APPROVED), true);
  assert.equal(canTransitionCaseState(CASE_STATE.SIGNAL_GENERATED, CASE_STATE.OUTCOME_APPROVED), false);
});

test("analyst may triage but may not approve an outcome", () => {
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

test("investigator cannot approve the final outcome", () => {
  assert.throws(() => assertCaseTransition({
    fromState: CASE_STATE.OUTCOME_REVIEW_PENDING,
    toState: CASE_STATE.OUTCOME_APPROVED,
    actorRole: CASE_ROLE.INVESTIGATOR,
    actorId: "investigator-1",
    reportCompletingInvestigatorId: "investigator-1",
  }), (error) => error.code === CASE_ERROR_CODE.ROLE_NOT_AUTHORISED);
});

test("independent decision-maker cannot review their own report", () => {
  assert.throws(() => assertCaseTransition({
    fromState: CASE_STATE.OUTCOME_REVIEW_PENDING,
    toState: CASE_STATE.OUTCOME_APPROVED,
    actorRole: CASE_ROLE.INDEPENDENT_DECISION_MAKER,
    actorId: "actor-1",
    reportCompletingInvestigatorId: "actor-1",
  }), (error) => error.code === CASE_ERROR_CODE.REVIEWER_INDEPENDENCE_REQUIRED);
});

test("platform administrator and service roles cannot force case transitions", () => {
  for (const actorRole of [
    CASE_ROLE.PLATFORM_ADMINISTRATOR,
    CASE_ROLE.DETECTION_SERVICE,
    CASE_ROLE.REPORT_PRODUCER,
  ]) {
    assert.throws(() => assertCaseTransition({
      fromState: CASE_STATE.SIGNAL_GENERATED,
      toState: CASE_STATE.TRIAGE_PENDING,
      actorRole,
      actorId: "service-actor",
    }), (error) => error.code === CASE_ERROR_CODE.ROLE_NOT_AUTHORISED);
  }
});

test("deferred network-notice states fail with a stable governance error", () => {
  for (const toState of Object.values(DEFERRED_CASE_STATE)) {
    assert.throws(() => assertCaseTransition({
      fromState: CASE_STATE.OUTCOME_APPROVED,
      toState,
      actorRole: CASE_ROLE.INDEPENDENT_DECISION_MAKER,
      actorId: "reviewer-1",
    }), (error) => error.code === CASE_ERROR_CODE.NETWORK_NOTICE_GOVERNANCE_REQUIRED);
  }
});

test("unrecognised authoritative roles fail closed", () => {
  assert.throws(() => assertCaseTransition({
    fromState: CASE_STATE.SIGNAL_GENERATED,
    toState: CASE_STATE.TRIAGE_PENDING,
    actorRole: "CLIENT_SUPPLIED_ADMIN",
    actorId: "actor-1",
  }), (error) => error.code === CASE_ERROR_CODE.ROLE_NOT_AUTHORISED);
});
