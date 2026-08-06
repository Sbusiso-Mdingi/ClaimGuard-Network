import assert from "node:assert/strict";
import test from "node:test";
import { Hono } from "hono";

import {
  CASE_PERMISSION,
  CASE_ROLE,
  CASE_STATE,
  CasePolicyError,
} from "@claimguard/database";
import { CLAIMGUARD_PERMISSIONS } from "../src/authorization-policy.js";
import { registerCaseRoutes } from "../src/routes/case-routes.js";
import { createCaseWorkflowService } from "../src/services/case-workflow-service.js";

const REVIEW_PERMISSION = CLAIMGUARD_PERMISSIONS.FRAUD_REGISTRY_REVIEW_HISTORY;

function caseRecord(overrides = {}) {
  return {
    caseId: "case-1",
    tenantId: "tenant-a",
    signalId: "signal-1",
    claimId: "claim-1",
    claimVersion: 1,
    currentState: CASE_STATE.TRIAGE_PENDING,
    stateVersion: 2,
    assignedInvestigatorId: null,
    triageOwnerId: "actor-1",
    originatingReason: "LEGACY_FIRST_ACCESS",
    correlationId: "request-created",
    lastTransitionEventId: "event-1",
    reportCompletingInvestigatorId: null,
    reportReference: null,
    reportDigest: null,
    reportCompletionEventId: null,
    legacyInvestigationId: "investigation-1",
    legacyStatus: "CONFIRMED_FRAUD",
    migrationReviewStatus: "REVIEW_REQUIRED",
    createdAt: "2026-08-05T10:00:00.000Z",
    updatedAt: "2026-08-05T10:00:00.000Z",
    ...overrides,
  };
}

function createRepository(overrides = {}) {
  const calls = [];
  const cases = new Map([["case-1", caseRecord()]]);
  const legacyCases = new Map([["investigation-1", cases.get("case-1")]]);
  const repository = {
    async getCase(caseId) {
      calls.push({ method: "getCase", caseId });
      return cases.get(caseId) || null;
    },
    async getCaseByLegacyInvestigationId(legacyInvestigationId) {
      calls.push({ method: "getCaseByLegacyInvestigationId", legacyInvestigationId });
      return legacyCases.get(legacyInvestigationId) || null;
    },
    async resolveLegacyInvestigationCase(input) {
      calls.push({ method: "resolveLegacyInvestigationCase", input });
      const created = caseRecord({
        caseId: "case-created",
        legacyInvestigationId: input.legacyInvestigationId,
        correlationId: input.correlationId,
      });
      cases.set(created.caseId, created);
      legacyCases.set(input.legacyInvestigationId, created);
      return {
        case: created,
        transitionEventId: "event-created",
        operationId: "operation-created",
        replayed: false,
      };
    },
    async performAction(input) {
      calls.push({ method: "performAction", input });
      const existing = cases.get(input.caseId) || caseRecord({ caseId: input.caseId });
      const next = {
        ...existing,
        currentState: CASE_STATE.MONITORING,
        stateVersion: input.expectedStateVersion + 1,
      };
      cases.set(input.caseId, next);
      return {
        case: next,
        transitionEventId: "event-action",
        replayed: false,
      };
    },
    ...overrides,
  };
  return { repository, calls, cases, legacyCases };
}

function createApp({
  role = CASE_ROLE.SCHEME_ANALYST,
  effectivePermissions = [REVIEW_PERMISSION, CASE_PERMISSION.TRIAGE, CASE_PERMISSION.MONITOR],
  authTenantId = "tenant-a",
  routedTenantId = "tenant-a",
  requestId = "request-1",
  repository = null,
  service = null,
} = {}) {
  const logs = [];
  const resolvedRepository = repository || createRepository().repository;
  const caseWorkflowService = service || createCaseWorkflowService({
    caseWorkflowRepository: resolvedRepository,
  });
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.set("requestId", requestId);
    c.set("authContext", {
      is_authenticated: true,
      user_id: "actor-1",
      tenant_id: authTenantId,
      organisation_id: "organisation-a",
      roles: [role],
      permissions: new Set(effectivePermissions),
    });
    c.set("tenantContext", { tenant_id: routedTenantId, scheme_id: "scheme-a" });
    await next();
  });
  registerCaseRoutes(app, {
    caseWorkflowService,
    logger(level, event, details) {
      logs.push({ level, event, details });
    },
  });
  return { app, logs, service: caseWorkflowService, repository: resolvedRepository };
}

function actionRequest(app, action = "begin-monitoring", payload = {}, headers = {}) {
  return app.request(`/api/v1/cases/case-1/actions/${action}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "idempotency-key": "idem-1",
      ...headers,
    },
    body: JSON.stringify({
      expectedStateVersion: 2,
      reasonCode: "REVIEWED",
      reasonSummary: "The governed action was reviewed.",
      ...payload,
    }),
  });
}

test("direct case detail returns authoritative case, server actions, and trusted correlation", async () => {
  const fixture = createRepository();
  const { app } = createApp({ repository: fixture.repository });
  const response = await app.request("/api/v1/cases/case-1?allowedActions=approve-outcome&tenantId=tenant-b");
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.available, true);
  assert.equal(body.case.caseId, "case-1");
  assert.equal(body.case.currentState, CASE_STATE.TRIAGE_PENDING);
  assert.deepEqual(body.allowedActions, ["begin-monitoring"]);
  assert.equal(body.correlationId, "request-1");
  assert.equal(fixture.calls[0].method, "getCase");
});

test("direct case detail normalises tenant mismatch and missing case to CASE_NOT_FOUND", async () => {
  const mismatchService = {
    canReadDirectCase() { return true; },
    async getCase() {
      throw new CasePolicyError("foreign tenant", "CASE_TENANT_MISMATCH");
    },
  };
  const mismatch = createApp({ service: mismatchService });
  const mismatchResponse = await mismatch.app.request("/api/v1/cases/case-foreign");
  const mismatchBody = await mismatchResponse.json();
  assert.equal(mismatchResponse.status, 404);
  assert.equal(mismatchBody.code, "CASE_NOT_FOUND");
  assert.equal(JSON.stringify(mismatchBody).includes("foreign tenant"), false);

  const missing = createApp({ repository: createRepository({ async getCase() { return null; } }).repository });
  const missingResponse = await missing.app.request("/api/v1/cases/missing");
  assert.equal(missingResponse.status, 404);
  assert.equal((await missingResponse.json()).code, "CASE_NOT_FOUND");
});

test("direct case detail returns unavailable when direct read capability is absent", async () => {
  const { app } = createApp({
    service: {
      canReadDirectCase() { return false; },
    },
  });
  const response = await app.request("/api/v1/cases/case-1");
  assert.equal(response.status, 503);
  assert.equal((await response.json()).code, "CASE_WORKFLOW_UNAVAILABLE");
});

test("legacy case detail returns an existing governed case without migration", async () => {
  const fixture = createRepository();
  const { app } = createApp({ repository: fixture.repository });
  const first = await app.request("/api/v1/cases/by-legacy-investigation/investigation-1");
  const second = await app.request("/api/v1/cases/by-legacy-investigation/investigation-1");
  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  assert.equal((await first.json()).case.caseId, "case-1");
  assert.equal((await second.json()).case.caseId, "case-1");
  assert.equal(fixture.calls.filter((call) => call.method === "resolveLegacyInvestigationCase").length, 0);
});

test("triage actor triggers neutral legacy first access with trusted correlation", async () => {
  const fixture = createRepository();
  const { app } = createApp({ repository: fixture.repository, requestId: "trusted-request-77" });
  const response = await app.request(
    "/api/v1/cases/by-legacy-investigation/investigation-new?correlationId=client-value&allowedActions=approve-outcome",
    { headers: { "x-client-correlation": "untrusted" } },
  );
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.case.currentState, CASE_STATE.TRIAGE_PENDING);
  assert.equal(body.case.stateVersion, 2);
  assert.equal(body.case.migrationReviewStatus, "REVIEW_REQUIRED");
  assert.equal(body.case.legacyInvestigationId, "investigation-new");
  assert.equal(body.correlationId, "trusted-request-77");
  assert.deepEqual(body.allowedActions, ["begin-monitoring"]);
  const migrationCall = fixture.calls.find((call) => call.method === "resolveLegacyInvestigationCase");
  assert.equal(migrationCall.input.correlationId, "trusted-request-77");
  assert.equal(migrationCall.input.actorContext.tenantId, "tenant-a");
  assert.equal(migrationCall.input.actorContext.permissions.includes(CASE_PERMISSION.TRIAGE), true);
  assert.equal(Object.hasOwn(migrationCall.input, "allowedActions"), false);
  assert.equal(Object.hasOwn(migrationCall.input, "targetState"), false);
});

test("actor without triage can read existing legacy case but cannot create one", async () => {
  const fixture = createRepository();
  const { app } = createApp({
    repository: fixture.repository,
    effectivePermissions: [REVIEW_PERMISSION, CASE_PERMISSION.MONITOR],
  });
  const existing = await app.request("/api/v1/cases/by-legacy-investigation/investigation-1");
  assert.equal(existing.status, 200);
  assert.equal((await existing.json()).case.caseId, "case-1");

  const missing = await app.request("/api/v1/cases/by-legacy-investigation/investigation-new");
  assert.equal(missing.status, 404);
  assert.equal((await missing.json()).code, "CASE_NOT_FOUND");
  assert.equal(fixture.calls.filter((call) => call.method === "resolveLegacyInvestigationCase").length, 0);
});

test("legacy lookup fails closed for tenant mismatch, missing, malformed and overlength IDs", async () => {
  const mismatch = createApp({ authTenantId: "tenant-a", routedTenantId: "tenant-b" });
  const mismatchResponse = await mismatch.app.request("/api/v1/cases/by-legacy-investigation/investigation-1");
  assert.equal(mismatchResponse.status, 404);
  assert.equal((await mismatchResponse.json()).code, "CASE_NOT_FOUND");

  const fixture = createRepository();
  const missing = createApp({
    repository: fixture.repository,
    effectivePermissions: [REVIEW_PERMISSION],
  });
  const missingResponse = await missing.app.request("/api/v1/cases/by-legacy-investigation/not-found");
  assert.equal(missingResponse.status, 404);
  assert.equal((await missingResponse.json()).code, "CASE_NOT_FOUND");

  for (const id of ["%20", "x".repeat(65)]) {
    const malformedResponse = await missing.app.request(`/api/v1/cases/by-legacy-investigation/${id}`);
    assert.equal(malformedResponse.status, 400);
    assert.equal((await malformedResponse.json()).code, "CASE_VALIDATION_FAILED");
  }
});

test("server-derived actions exclude deferred actions and self-approval", async () => {
  const fixture = createRepository({
    async getCase() {
      return caseRecord({
        currentState: CASE_STATE.OUTCOME_REVIEW_PENDING,
        stateVersion: 9,
        reportCompletingInvestigatorId: "actor-1",
      });
    },
  });
  const { app } = createApp({
    repository: fixture.repository,
    role: CASE_ROLE.INDEPENDENT_DECISION_MAKER,
    effectivePermissions: [
      REVIEW_PERMISSION,
      CASE_PERMISSION.APPROVE_OUTCOME,
      CASE_PERMISSION.RETURN_FOR_FURTHER_EVIDENCE,
      CASE_PERMISSION.CLOSE_UNSUBSTANTIATED,
    ],
  });
  const response = await app.request("/api/v1/cases/case-1");
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.deepEqual(body.allowedActions.sort(), ["close-unsubstantiated", "return-for-further-evidence"]);
  for (const forbidden of ["approve-outcome", "publish-registry", "activate-network-notice"]) {
    assert.equal(body.allowedActions.includes(forbidden), false);
  }
});

test("displayed-action tampering cannot authorise a forbidden transition", async () => {
  const fixture = createRepository();
  const { app } = createApp({
    repository: fixture.repository,
    effectivePermissions: [REVIEW_PERMISSION, CASE_PERMISSION.MONITOR],
  });
  const response = await actionRequest(app, "approve-outcome", {
    allowedActions: ["approve-outcome"],
    permissions: [CASE_PERMISSION.APPROVE_OUTCOME],
    targetState: CASE_STATE.OUTCOME_APPROVED,
  });
  const body = await response.json();
  assert.equal(response.status, 400);
  assert.equal(body.code, "PROHIBITED_CASE_CONTEXT_FIELD");
  assert.equal(fixture.calls.filter((call) => call.method === "performAction").length, 0);
});

test("routed action derives actor tenant role and correlation from trusted context", async () => {
  const fixture = createRepository();
  const { app } = createApp({ repository: fixture.repository });
  const response = await actionRequest(app);
  assert.equal(response.status, 201);
  const call = fixture.calls.find((item) => item.method === "performAction").input;
  assert.equal(call.actorContext.actorId, "actor-1");
  assert.equal(call.actorContext.tenantId, "tenant-a");
  assert.deepEqual(call.actorContext.roles, [CASE_ROLE.SCHEME_ANALYST]);
  assert.equal(call.correlationId, "request-1");
  assert.equal(call.idempotencyKey, "idem-1");
  assert.equal(Object.hasOwn(call, "targetState"), false);
});

test("client-supplied trusted context and target state are rejected", async () => {
  for (const payload of [
    { tenantId: "tenant-b" },
    { actorId: "reviewer-2" },
    { role: CASE_ROLE.INDEPENDENT_DECISION_MAKER },
    { roles: [CASE_ROLE.INDEPENDENT_DECISION_MAKER] },
    { permissions: [CASE_PERMISSION.APPROVE_OUTCOME] },
    { toState: CASE_STATE.OUTCOME_APPROVED },
    { status: "CONFIRMED_FRAUD" },
    { registryPublicationRequired: true },
    { paymentAction: "WITHHOLD" },
  ]) {
    const fixture = createRepository();
    const { app } = createApp({ repository: fixture.repository });
    const response = await actionRequest(app, "begin-monitoring", payload);
    const body = await response.json();
    assert.equal(response.status, 400);
    assert.equal(body.code, "PROHIBITED_CASE_CONTEXT_FIELD");
    assert.equal(fixture.calls.filter((call) => call.method === "performAction").length, 0);
  }
});

test("idempotency header, valid version, and configured action capability are required", async () => {
  const fixture = createRepository();
  const missingKey = createApp({ repository: fixture.repository });
  const missingResponse = await actionRequest(missingKey.app, "begin-monitoring", {}, { "idempotency-key": "" });
  assert.equal(missingResponse.status, 400);
  assert.equal((await missingResponse.json()).code, "MISSING_IDEMPOTENCY_KEY");

  const invalidVersion = createApp({ repository: createRepository().repository });
  const invalidResponse = await actionRequest(invalidVersion.app, "begin-monitoring", { expectedStateVersion: 0 });
  assert.equal(invalidResponse.status, 400);
  assert.equal((await invalidResponse.json()).code, "INVALID_EXPECTED_STATE_VERSION");

  const unavailable = createApp({
    service: {
      canPerformAction() { return false; },
    },
  });
  const unavailableResponse = await actionRequest(unavailable.app);
  assert.equal(unavailableResponse.status, 503);
  assert.equal((await unavailableResponse.json()).code, "CASE_WORKFLOW_UNAVAILABLE");
});

test("deferred actions and state conflicts return stable safe responses", async () => {
  const notice = createApp({ repository: createRepository().repository });
  const noticeResponse = await actionRequest(notice.app, "activate-network-notice");
  assert.equal(noticeResponse.status, 409);
  assert.equal((await noticeResponse.json()).code, "NETWORK_NOTICE_GOVERNANCE_REQUIRED");

  const conflict = createApp({
    service: {
      canPerformAction() { return true; },
      async performAction() {
        throw new CasePolicyError("The case changed after it was loaded.", "CASE_STATE_VERSION_CONFLICT");
      },
    },
  });
  const conflictResponse = await actionRequest(conflict.app);
  const conflictBody = await conflictResponse.json();
  assert.equal(conflictResponse.status, 409);
  assert.equal(conflictBody.code, "CASE_STATE_VERSION_CONFLICT");
  assert.equal(conflictBody.correlationId, "request-1");
});
