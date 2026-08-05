import assert from "node:assert/strict";
import test from "node:test";

import {
  CASE_ERROR_CODE,
  CASE_ROLE,
  CASE_STATE,
} from "@claimguard/database";
import {
  CASE_ACTION,
  createCaseWorkflowService,
  resolveCaseAction,
} from "../src/services/case-workflow-service.js";

function trustedContext(role, overrides = {}) {
  return {
    authContext: {
      is_authenticated: true,
      user_id: overrides.userId || "actor-1",
      tenant_id: overrides.authTenantId || "tenant-a",
      roles: overrides.roles || [role],
    },
    tenantContext: {
      tenant_id: overrides.routedTenantId || "tenant-a",
    },
  };
}

function configuredService() {
  const calls = [];
  const service = createCaseWorkflowService({
    caseWorkflowRepository: {
      async getCase(caseId) {
        return { caseId, tenantId: "tenant-a", stateVersion: 2 };
      },
      async transitionCase(input) {
        calls.push(input);
        return {
          case: {
            caseId: input.caseId,
            currentState: input.toState,
            stateVersion: input.expectedStateVersion + 1,
          },
          replayed: false,
        };
      },
    },
  });
  return { service, calls };
}

function actionInput(role, action, payload = {}, overrides = {}) {
  return {
    caseId: "case-1",
    action,
    ...trustedContext(role, overrides),
    correlationId: "request-1",
    idempotencyKey: "idem-1",
    payload: {
      expectedStateVersion: 2,
      reasonCode: "REVIEWED",
      reasonSummary: "Required process step completed.",
      ...payload,
    },
  };
}

test("fixed action contracts resolve to governed target states", () => {
  assert.equal(resolveCaseAction(CASE_ACTION.BEGIN_TRIAGE).toState, CASE_STATE.TRIAGE_PENDING);
  assert.equal(resolveCaseAction(CASE_ACTION.COMPLETE_INVESTIGATION_REPORT).toState, CASE_STATE.INVESTIGATION_REPORT_COMPLETED);
  assert.equal(resolveCaseAction(CASE_ACTION.APPROVE_OUTCOME).toState, CASE_STATE.OUTCOME_APPROVED);
  assert.equal(resolveCaseAction("NETWORK_NOTICE_ACTIVE"), null);
});

test("analyst action derives tenant, actor and role from trusted context", async () => {
  const { service, calls } = configuredService();
  await service.performAction(actionInput(
    CASE_ROLE.SCHEME_ANALYST,
    CASE_ACTION.BEGIN_TRIAGE,
    {
      actorRole: CASE_ROLE.PLATFORM_ADMINISTRATOR,
      tenantId: "tenant-b",
      toState: CASE_STATE.OUTCOME_APPROVED,
    },
  ));

  assert.equal(calls.length, 1);
  assert.equal(calls[0].actorId, "actor-1");
  assert.equal(calls[0].actorRole, CASE_ROLE.SCHEME_ANALYST);
  assert.equal(calls[0].toState, CASE_STATE.TRIAGE_PENDING);
  assert.equal(Object.hasOwn(calls[0], "tenantId"), false);
});

test("investigator report completion forwards bounded process fields", async () => {
  const { service, calls } = configuredService();
  await service.performAction(actionInput(
    CASE_ROLE.INVESTIGATOR,
    CASE_ACTION.COMPLETE_INVESTIGATION_REPORT,
    {
      assignedInvestigatorId: "actor-1",
      evidenceReferences: ["evidence-1"],
      reportDigest: "sha256:abc",
      completionReason: "REPORT_COMPLETE",
    },
  ));

  assert.equal(calls[0].actorRole, CASE_ROLE.INVESTIGATOR);
  assert.equal(calls[0].toState, CASE_STATE.INVESTIGATION_REPORT_COMPLETED);
  assert.deepEqual(calls[0].evidenceReferences, ["evidence-1"]);
  assert.equal(calls[0].reportDigest, "sha256:abc");
});

test("independent decision-maker approval uses authoritative role", async () => {
  const { service, calls } = configuredService();
  await service.performAction(actionInput(
    CASE_ROLE.INDEPENDENT_DECISION_MAKER,
    CASE_ACTION.APPROVE_OUTCOME,
    {
      outcomeCode: "CONFIGURED_NEUTRAL_CODE",
      recordedReasons: ["Reviewed evidence and process checks."],
      identityMatchReviewResult: { reviewed: true },
      supportingReportReference: "report-1",
      processCheckComplete: true,
    },
  ));

  assert.equal(calls[0].actorRole, CASE_ROLE.INDEPENDENT_DECISION_MAKER);
  assert.equal(calls[0].toState, CASE_STATE.OUTCOME_APPROVED);
});

test("client-supplied role cannot elevate an investigator to decision-maker", async () => {
  const { service } = configuredService();
  await assert.rejects(
    service.performAction(actionInput(
      CASE_ROLE.INVESTIGATOR,
      CASE_ACTION.APPROVE_OUTCOME,
      { actorRole: CASE_ROLE.INDEPENDENT_DECISION_MAKER },
    )),
    (error) => error.code === CASE_ERROR_CODE.ROLE_NOT_AUTHORISED,
  );
});

test("platform administrator cannot force a case outcome", async () => {
  const { service } = configuredService();
  await assert.rejects(
    service.performAction(actionInput(
      CASE_ROLE.PLATFORM_ADMINISTRATOR,
      CASE_ACTION.APPROVE_OUTCOME,
    )),
    (error) => error.code === CASE_ERROR_CODE.ROLE_NOT_AUTHORISED,
  );
});

test("cross-tenant trusted context fails closed", async () => {
  const { service } = configuredService();
  await assert.rejects(
    service.performAction(actionInput(
      CASE_ROLE.SCHEME_ANALYST,
      CASE_ACTION.BEGIN_TRIAGE,
      {},
      { routedTenantId: "tenant-b" },
    )),
    (error) => error.code === CASE_ERROR_CODE.TENANT_MISMATCH,
  );
});

test("deferred or arbitrary state strings are not accepted as actions", async () => {
  const { service } = configuredService();
  await assert.rejects(
    service.performAction(actionInput(
      CASE_ROLE.INDEPENDENT_DECISION_MAKER,
      "NETWORK_NOTICE_ACTIVE",
    )),
    (error) => error.code === CASE_ERROR_CODE.TRANSITION_NOT_PERMITTED,
  );
});

test("state version, correlation ID and idempotency key are mandatory", async () => {
  const { service } = configuredService();
  const input = actionInput(CASE_ROLE.SCHEME_ANALYST, CASE_ACTION.BEGIN_TRIAGE);
  input.payload.expectedStateVersion = null;
  await assert.rejects(
    service.performAction(input),
    (error) => error.code === CASE_ERROR_CODE.VALIDATION_FAILED,
  );
});
