import assert from "node:assert/strict";
import test from "node:test";
import { Hono } from "hono";

import { CASE_ROLE, CASE_STATE, CasePolicyError } from "@claimguard/database";
import { CLAIMGUARD_PERMISSIONS } from "../src/authorization-policy.js";
import { registerCaseRoutes } from "../src/routes/case-routes.js";

function createApp({ role = CASE_ROLE.SCHEME_ANALYST, transition = null } = {}) {
  const calls = [];
  const logs = [];
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.set("requestId", "request-1");
    c.set("authContext", {
      is_authenticated: true,
      user_id: "actor-1",
      tenant_id: "tenant-a",
      organisation_id: "organisation-a",
      roles: [role],
      permissions: new Set([CLAIMGUARD_PERMISSIONS.FRAUD_REGISTRY_REVIEW_HISTORY]),
    });
    c.set("tenantContext", { tenant_id: "tenant-a", scheme_id: "scheme-a" });
    await next();
  });
  registerCaseRoutes(app, {
    caseWorkflowService: {
      isConfigured() { return true; },
      async performAction(input) {
        calls.push(input);
        if (transition) return transition(input);
        return {
          case: {
            caseId: input.caseId,
            currentState: CASE_STATE.TRIAGE_PENDING,
            stateVersion: 2,
          },
          transitionEventId: "event-1",
          operationId: "a".repeat(64),
          correlationId: input.correlationId,
          replayed: false,
        };
      },
    },
    logger(level, event, details) {
      logs.push({ level, event, details });
    },
  });
  return { app, calls, logs };
}

function request(app, action = "begin-triage", payload = {}, headers = {}) {
  return app.request(`/api/v1/cases/case-1/actions/${action}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "idempotency-key": "idem-1",
      ...headers,
    },
    body: JSON.stringify({
      expectedStateVersion: 1,
      reasonCode: "TRIAGE_STARTED",
      reasonSummary: "Triage started by an authorised analyst.",
      ...payload,
    }),
  });
}

test("routed action derives actor tenant role and correlation from trusted context", async () => {
  const { app, calls } = createApp();
  const response = await request(app);
  assert.equal(response.status, 201);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].authContext.user_id, "actor-1");
  assert.equal(calls[0].authContext.tenant_id, "tenant-a");
  assert.deepEqual(calls[0].authContext.roles, [CASE_ROLE.SCHEME_ANALYST]);
  assert.equal(calls[0].tenantContext.tenant_id, "tenant-a");
  assert.equal(calls[0].correlationId, "request-1");
  assert.equal(calls[0].idempotencyKey, "idem-1");
  assert.equal(calls[0].action, "begin-triage");
});

test("client-supplied trusted context and target state are rejected", async () => {
  for (const payload of [
    { tenantId: "tenant-b" },
    { actorId: "reviewer-2" },
    { role: CASE_ROLE.INDEPENDENT_DECISION_MAKER },
    { roles: [CASE_ROLE.INDEPENDENT_DECISION_MAKER] },
    { toState: CASE_STATE.OUTCOME_APPROVED },
    { status: "CONFIRMED_FRAUD" },
    { registryPublicationRequired: true },
    { paymentAction: "WITHHOLD" },
  ]) {
    const { app, calls } = createApp();
    const response = await request(app, "begin-triage", payload);
    const body = await response.json();
    assert.equal(response.status, 400);
    assert.equal(body.code, "PROHIBITED_CASE_CONTEXT_FIELD");
    assert.equal(calls.length, 0);
    assert.equal(JSON.stringify(body).includes("patient"), false);
  }
});

test("idempotency header is mandatory and body idempotency is rejected", async () => {
  const missing = createApp();
  const missingResponse = await request(missing.app, "begin-triage", {}, { "idempotency-key": "" });
  assert.equal(missingResponse.status, 400);
  assert.equal((await missingResponse.json()).code, "MISSING_IDEMPOTENCY_KEY");

  const bodyKey = createApp();
  const bodyResponse = await request(bodyKey.app, "begin-triage", { idempotencyKey: "body-key" });
  assert.equal(bodyResponse.status, 400);
  assert.equal((await bodyResponse.json()).code, "PROHIBITED_CASE_CONTEXT_FIELD");
});

test("invalid versions and unsupported actions fail with stable safe responses", async () => {
  const invalid = createApp();
  const invalidResponse = await request(invalid.app, "begin-triage", { expectedStateVersion: 0 });
  assert.equal(invalidResponse.status, 400);
  assert.equal((await invalidResponse.json()).code, "INVALID_EXPECTED_STATE_VERSION");

  const unknown = createApp();
  const unknownResponse = await request(unknown.app, "force-approved");
  assert.equal(unknownResponse.status, 404);
  assert.equal((await unknownResponse.json()).code, "INVALID_CASE_ACTION");

  const notice = createApp();
  const noticeResponse = await request(notice.app, "activate-network-notice");
  assert.equal(noticeResponse.status, 409);
  assert.equal((await noticeResponse.json()).code, "NETWORK_NOTICE_GOVERNANCE_REQUIRED");
});

test("domain conflicts are normalised without claim or database details", async () => {
  const { app } = createApp({
    transition() {
      throw new CasePolicyError(
        "The case changed after it was loaded.",
        "CASE_STATE_VERSION_CONFLICT",
      );
    },
  });
  const response = await request(app);
  const body = await response.json();
  assert.equal(response.status, 409);
  assert.equal(body.code, "CASE_STATE_VERSION_CONFLICT");
  assert.equal(body.correlationId, "request-1");
  for (const prohibited of ["patient", "identity_number", "membership", "mysql://", "claim_payload"]) {
    assert.equal(JSON.stringify(body).toLowerCase().includes(prohibited), false);
  }
});

test("exact replay preserves the original workflow result", async () => {
  const { app } = createApp({
    transition(input) {
      return {
        case: {
          caseId: input.caseId,
          currentState: CASE_STATE.TRIAGE_PENDING,
          stateVersion: 2,
        },
        transitionEventId: "event-original",
        operationId: "b".repeat(64),
        correlationId: input.correlationId,
        replayed: true,
      };
    },
  });
  const response = await request(app);
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.replayed, true);
  assert.equal(body.stateVersion, 2);
  assert.equal(body.transitionEventId, "event-original");
});
