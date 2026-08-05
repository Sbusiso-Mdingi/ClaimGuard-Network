import assert from "node:assert/strict";
import test from "node:test";

import {
  CASE_ERROR_CODE,
  CASE_PERMISSION,
  CASE_STATE,
} from "@claimguard/database";
import {
  CASE_ACTION,
  createCaseWorkflowService,
  resolveCaseAction,
} from "../src/services/case-workflow-service.js";

function trustedContext(role, permissions, overrides = {}) {
  return {
    authContext: {
      is_authenticated: true,
      user_id: overrides.userId || "actor-1",
      tenant_id: overrides.authTenantId || "tenant-a",
      roles: overrides.roles || [role],
      permissions: new Set(overrides.permissions || permissions),
    },
    tenantContext: { tenant_id: overrides.routedTenantId || "tenant-a" },
  };
}

function configuredService() {
  const calls = [];
  const service = createCaseWorkflowService({
    caseWorkflowRepository: {
      async getCase(caseId) {
        return { caseId, tenantId: "tenant-a", stateVersion: 2 };
      },
      async performAction(input) {
        calls.push(input);
        return {
          case: {
            caseId: input.caseId,
            currentState: resolveCaseAction(input.action).toState,
            stateVersion: input.expectedStateVersion + 1,
          },
          replayed: false,
        };
      },
    },
  });
  return { service, calls };
}

function actionInput(role, permissions, action, payload = {}, overrides = {}) {
  return {
    caseId: "case-1",
    action,
    ...trustedContext(role, permissions, overrides),
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

test("fixed actions resolve to governed targets and permissions", () => {
  assert.deepEqual(resolveCaseAction(CASE_ACTION.BEGIN_TRIAGE), {
    toState: CASE_STATE.TRIAGE_PENDING,
    permission: CASE_PERMISSION.TRIAGE,
  });
  assert.equal(resolveCaseAction(CASE_ACTION.APPROVE_OUTCOME).permission, CASE_PERMISSION.APPROVE_OUTCOME);
  assert.equal(resolveCaseAction("NETWORK_NOTICE_ACTIVE"), null);
});

test("service forwards a frozen trusted actor context, never client authority", async () => {
  const { service, calls } = configuredService();
  await service.performAction(actionInput(
    "fraud_analyst",
    [CASE_PERMISSION.TRIAGE],
    CASE_ACTION.BEGIN_TRIAGE,
    { actorRole: "platform_administrator", tenantId: "tenant-b", toState: CASE_STATE.OUTCOME_APPROVED },
  ));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].action, CASE_ACTION.BEGIN_TRIAGE);
  assert.equal(calls[0].actorContext.actorId, "actor-1");
  assert.deepEqual(calls[0].actorContext.roles, ["fraud_analyst"]);
  assert.deepEqual(calls[0].actorContext.permissions, [CASE_PERMISSION.TRIAGE]);
  assert.equal(Object.isFrozen(calls[0].actorContext), true);
  assert.equal(Object.hasOwn(calls[0], "toState"), false);
  assert.equal(Object.hasOwn(calls[0], "actorRole"), false);
  assert.equal(Object.hasOwn(calls[0], "tenantId"), false);
});

test("investigator report completion forwards bounded process fields", async () => {
  const { service, calls } = configuredService();
  await service.performAction(actionInput(
    "investigator",
    [CASE_PERMISSION.COMPLETE_REPORT],
    CASE_ACTION.COMPLETE_INVESTIGATION_REPORT,
    {
      assignedInvestigatorId: "actor-1",
      evidenceReferences: ["evidence-1"],
      reportDigest: "sha256:abc",
      completionReason: "REPORT_COMPLETE",
    },
  ));
  assert.equal(calls[0].action, CASE_ACTION.COMPLETE_INVESTIGATION_REPORT);
  assert.deepEqual(calls[0].evidenceReferences, ["evidence-1"]);
  assert.equal(calls[0].reportDigest, "sha256:abc");
});

test("independent reviewer permission authorises approval", async () => {
  const { service, calls } = configuredService();
  await service.performAction(actionInput(
    "applications_committee_member",
    [CASE_PERMISSION.APPROVE_OUTCOME],
    CASE_ACTION.APPROVE_OUTCOME,
    {
      outcomeCode: "CONFIGURED_NEUTRAL_CODE",
      recordedReasons: ["Reviewed evidence and process checks."],
      identityMatchReviewResult: { reviewed: true },
      supportingReportReference: "report-1",
      evidenceSetReference: "evidence-set-1",
      processCheckComplete: true,
    },
  ));
  assert.equal(calls[0].actorContext.permissions.includes(CASE_PERMISSION.APPROVE_OUTCOME), true);
});

test("roles or payload permissions cannot substitute for missing trusted permission", async () => {
  const { service } = configuredService();
  await assert.rejects(
    service.performAction(actionInput(
      "investigator",
      [CASE_PERMISSION.COMPLETE_REPORT],
      CASE_ACTION.APPROVE_OUTCOME,
      { role: "applications_committee_member", permissions: [CASE_PERMISSION.APPROVE_OUTCOME] },
    )),
    (error) => error.code === CASE_ERROR_CODE.ROLE_NOT_AUTHORISED,
  );
});

test("platform administrator has no implicit outcome override", async () => {
  const { service } = configuredService();
  await assert.rejects(
    service.performAction(actionInput("platform_administrator", [], CASE_ACTION.APPROVE_OUTCOME)),
    (error) => error.code === CASE_ERROR_CODE.ROLE_NOT_AUTHORISED,
  );
});

test("cross-tenant trusted context fails closed", async () => {
  const { service } = configuredService();
  await assert.rejects(
    service.performAction(actionInput(
      "fraud_analyst",
      [CASE_PERMISSION.TRIAGE],
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
      "applications_committee_member",
      [CASE_PERMISSION.APPROVE_OUTCOME],
      "NETWORK_NOTICE_ACTIVE",
    )),
    (error) => error.code === CASE_ERROR_CODE.TRANSITION_NOT_PERMITTED,
  );
});

test("state version, correlation ID and idempotency key are mandatory", async () => {
  const { service } = configuredService();
  const input = actionInput("fraud_analyst", [CASE_PERMISSION.TRIAGE], CASE_ACTION.BEGIN_TRIAGE);
  input.payload.expectedStateVersion = null;
  await assert.rejects(
    service.performAction(input),
    (error) => error.code === CASE_ERROR_CODE.VALIDATION_FAILED,
  );
});
