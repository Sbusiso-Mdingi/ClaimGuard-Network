import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { Hono } from "hono";

import {
  CLAIMGUARD_PERMISSIONS,
  OPERATIONAL_ROUTE_IDS,
  resolveOperationalRoutePolicy,
} from "../src/authorization-policy.js";
import { runWithOperationalServices } from "../src/operational-service-context.js";
import { registerAssessmentRoutes } from "../src/routes/assessment-routes.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TENANT_CONTEXT = Object.freeze({
  tenant_id: "tenant-alpha",
  tenant_slug: "alpha",
  scheme_id: "ALPHA01",
});

function authContext(permissions = []) {
  return Object.freeze({
    is_authenticated: true,
    user_id: "assessment-user-1",
    tenant_id: TENANT_CONTEXT.tenant_id,
    roles: Object.freeze(["investigator"]),
    permissions: new Set(permissions),
  });
}

function appFor(auth) {
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.set("authContext", auth);
    c.set("tenantContext", TENANT_CONTEXT);
    c.set("requestId", "request-reassessment-test");
    await next();
  });
  registerAssessmentRoutes(app);
  return app;
}

function extractContextHelper(source, helperName) {
  const start = source.indexOf(`function ${helperName}(c) {`);
  assert.ok(start >= 0, `Expected ${helperName}(c) helper to be declared.`);
  const nextFunction = source.indexOf("\nfunction ", start + 1);
  const end = nextFunction >= 0 ? nextFunction : source.length;
  return source.slice(start, end);
}

test("reassessment route is bound to the canonical fixed permission policy", async () => {
  const policy = resolveOperationalRoutePolicy({
    method: "POST",
    path: "/assessment/versions/assessment-1/reassess",
  });
  assert.equal(policy?.id, OPERATIONAL_ROUTE_IDS.ASSESSMENT_REQUEST_REASSESSMENT);
  assert.deepEqual(policy?.permissions, [CLAIMGUARD_PERMISSIONS.ASSESSMENT_REQUEST_REASSESSMENT]);
  assert.equal(policy?.permissionMode, "all");
  assert.equal(policy?.requiresOperationalDataPlane, true);

  const app = appFor(authContext());
  const response = await app.request("/assessment/versions/assessment-1/reassess", {
    method: "POST",
    headers: { "idempotency-key": "fixed-policy-test" },
  });
  assert.equal(response.status, 403);
});

test("reassessment route requires a trimmed bounded Idempotency-Key before data-plane work", async () => {
  const app = appFor(authContext([CLAIMGUARD_PERMISSIONS.ASSESSMENT_REQUEST_REASSESSMENT]));

  const missing = await app.request("/assessment/versions/assessment-1/reassess", { method: "POST" });
  assert.equal(missing.status, 400);
  assert.equal((await missing.json()).code, "MISSING_IDEMPOTENCY_KEY");

  const empty = await app.request("/assessment/versions/assessment-1/reassess", {
    method: "POST",
    headers: { "idempotency-key": "   " },
  });
  assert.equal(empty.status, 400);
  assert.equal((await empty.json()).code, "MISSING_IDEMPOTENCY_KEY");

  const tooLong = await app.request("/assessment/versions/assessment-1/reassess", {
    method: "POST",
    headers: { "idempotency-key": "x".repeat(129) },
  });
  assert.equal(tooLong.status, 400);
  assert.equal((await tooLong.json()).code, "INVALID_IDEMPOTENCY_KEY");

  const valid = await app.request("/assessment/versions/assessment-1/reassess", {
    method: "POST",
    headers: { "idempotency-key": "  accepted-key  " },
  });
  assert.equal(valid.status, 503);
  assert.equal((await valid.json()).code, "DATA_PLANE_UNAVAILABLE");
});

test("reassessment handler consumes only server-trusted assessment context", () => {
  const source = readFileSync(
    path.resolve(__dirname, "../src/routes/assessment-routes.js"),
    "utf8",
  );
  const routeStart = source.indexOf("// POST /assessment/versions/:assessmentId/reassess");
  const routeEnd = source.indexOf("// GET /assessment/versions/:assessmentId", routeStart);
  assert.ok(routeStart >= 0);
  assert.ok(routeEnd > routeStart);
  const routeSource = source.slice(routeStart, routeEnd);

  const actorHelperSource = extractContextHelper(source, "correctionActor");
  const reassessmentSourceHelperSource = extractContextHelper(source, "reassessmentSource");
  const correlationHelperSource = extractContextHelper(source, "correctionCorrelationId");

  assert.ok(routeSource.includes("requireReassessment"));
  assert.ok(routeSource.includes("requireTenantAccess"));
  assert.ok(routeSource.includes("requestAssessmentReassessment"));
  assert.ok(routeSource.includes('c.get("tenantContext")'));
  assert.ok(routeSource.includes('const sourceAssessmentId = c.req.param("assessmentId");'));
  assert.ok(routeSource.includes("const actorId = correctionActor(c);"));
  assert.ok(routeSource.includes("const source = reassessmentSource(c);"));
  assert.ok(routeSource.includes("const correlationId = correctionCorrelationId(c);"));
  assert.ok(actorHelperSource.includes('c.get("authContext")'));
  assert.ok(reassessmentSourceHelperSource.includes('c.get("authContext")'));
  assert.ok(correlationHelperSource.includes('c.get("requestId")'));
  assert.ok(routeSource.includes('c.req.header("idempotency-key")') || source.includes('c.req.header("idempotency-key")'));

  const reassessmentCallStart = routeSource.indexOf(
    "const result = await requestAssessmentReassessment(connection, {",
  );
  const reassessmentCallEnd = routeSource.indexOf("});", reassessmentCallStart);
  assert.ok(reassessmentCallStart >= 0);
  assert.ok(reassessmentCallEnd > reassessmentCallStart);
  const reassessmentCallSource = routeSource.slice(reassessmentCallStart, reassessmentCallEnd);
  assert.ok(reassessmentCallSource.includes("tenantId,"));
  assert.ok(reassessmentCallSource.includes("sourceAssessmentId,"));
  assert.ok(reassessmentCallSource.includes("idempotencyKey: idempotency.key,"));
  assert.ok(reassessmentCallSource.includes("createdBy: actorId,"));
  assert.ok(reassessmentCallSource.includes("source,"));
  assert.ok(reassessmentCallSource.includes("correlationId,"));

  assert.equal(routeSource.includes("c.req.json"), false);
  assert.equal(routeSource.includes("createRequirePermissionMiddleware"), false);
  assert.equal(routeSource.includes("createRequireAnyPermissionMiddleware"), false);

  for (const clientAuthorityField of [
    "tenant_id", "tenantId", "actor_id", "actorId", "roles", "permissions",
    "member_version", "memberVersion", "provider_version", "providerVersion",
    "claim_version", "claimVersion", "detection_strategy_id", "detectionStrategyId",
    "strategy_type", "strategyType", "model_deployment_id", "modelDeploymentId",
    "supersedes_assessment_id", "supersedesAssessmentId", "provenance_status",
  ]) {
    assert.equal(
      routeSource.includes(`body?.${clientAuthorityField}`)
        || routeSource.includes(`body.${clientAuthorityField}`),
      false,
      `Reassessment route must not consume client authority field ${clientAuthorityField}.`,
    );
  }
});

test("member and provider immutable history routes use their canonical read permissions", async () => {
  const memberPolicy = resolveOperationalRoutePolicy({
    method: "GET",
    path: "/assessment/members/member-1/versions",
  });
  assert.equal(memberPolicy?.id, OPERATIONAL_ROUTE_IDS.MEMBER_VERSION_HISTORY);
  assert.deepEqual(memberPolicy?.permissions, [CLAIMGUARD_PERMISSIONS.MEMBER_READ]);

  const providerPolicy = resolveOperationalRoutePolicy({
    method: "GET",
    path: "/assessment/providers/provider-1/versions",
  });
  assert.equal(providerPolicy?.id, OPERATIONAL_ROUTE_IDS.PROVIDER_VERSION_HISTORY);
  assert.deepEqual(providerPolicy?.permissions, [CLAIMGUARD_PERMISSIONS.PROVIDER_READ]);

  const denied = appFor(authContext());
  assert.equal((await denied.request("/assessment/members/member-1/versions")).status, 403);
  assert.equal((await denied.request("/assessment/providers/provider-1/versions")).status, 403);

  const permitted = appFor(authContext([
    CLAIMGUARD_PERMISSIONS.MEMBER_READ,
    CLAIMGUARD_PERMISSIONS.PROVIDER_READ,
  ]));
  assert.equal((await permitted.request("/assessment/members/member-1/versions")).status, 503);
  assert.equal((await permitted.request("/assessment/providers/provider-1/versions")).status, 503);
});

test("immutable history routes return tenant-scoped versions without banking data", async () => {
  const calls = [];
  const pool = {
    async execute(sql, params) {
      calls.push({ sql, params });
      assert.equal(params[0], TENANT_CONTEXT.tenant_id);
      if (sql.includes("FROM member_versions mv")) {
        return [[{
          member_id: "member-1",
          member_version: 2,
          current_member_version: 2,
          scheme_id: "scheme-1",
          first_name: "René",
          last_name: "Member",
          date_of_birth: "1990-01-01",
          gender: "X",
          identity_number: "identity-token",
          home_region: "Gauteng",
          home_lat: -26.2,
          home_lon: 28.0,
          join_date: "2020-01-01",
          effective_from: "2026-08-01T00:00:00.000Z",
          effective_to: null,
          version_reason: "IDENTITY_CORRECTION",
          source_reference: "evidence-1",
          created_by: "user:submitter",
          created_at: "2026-08-01T00:00:00.000Z",
          payload_hash: "a".repeat(64),
          banking_detail: "must-not-leak",
        }], []];
      }
      if (sql.includes("FROM provider_versions pv")) {
        return [[{
          provider_id: "provider-1",
          provider_version: 3,
          current_provider_version: 3,
          scheme_id: "scheme-1",
          practice_number: "practice-1",
          specialty: "General",
          practice_name: "Practice One",
          practice_region: "Gauteng",
          practice_lat: -26.2,
          practice_lon: 28.0,
          provider_kind: "PRACTICE",
          provider_category: "GENERAL",
          effective_from: "2026-08-01T00:00:00.000Z",
          effective_to: null,
          version_reason: "PROVIDER_CORRECTION",
          source_reference: null,
          created_by: "user:submitter",
          created_at: "2026-08-01T00:00:00.000Z",
          payload_hash: "b".repeat(64),
          banking_detail: "must-not-leak",
        }], []];
      }
      throw new Error(`Unexpected SQL: ${sql}`);
    },
  };
  const app = appFor(authContext([
    CLAIMGUARD_PERMISSIONS.MEMBER_READ,
    CLAIMGUARD_PERMISSIONS.PROVIDER_READ,
  ]));

  const member = await runWithOperationalServices(
    { pool },
    () => app.request("/assessment/members/member-1/versions"),
  );
  const provider = await runWithOperationalServices(
    { pool },
    () => app.request("/assessment/providers/provider-1/versions"),
  );

  assert.equal(member.status, 200);
  assert.equal(provider.status, 200);
  const memberBody = await member.json();
  const providerBody = await provider.json();
  assert.equal(memberBody.versions[0].firstName, "René");
  assert.equal(providerBody.versions[0].version, 3);
  assert.doesNotMatch(JSON.stringify({ memberBody, providerBody }), /bank|must-not-leak/i);
  assert.equal(calls.length, 2);
});

test("correction commands require external idempotency and an expected version", async () => {
  const app = appFor(authContext([
    CLAIMGUARD_PERMISSIONS.MEMBER_CORRECT,
    CLAIMGUARD_PERMISSIONS.PROVIDER_CORRECT,
  ]));

  const memberMissingKey = await app.request("/assessment/members/member-1/correction", {
    method: "POST",
  });
  assert.equal(memberMissingKey.status, 400);
  assert.equal((await memberMissingKey.json()).code, "MISSING_IDEMPOTENCY_KEY");

  const memberMissingVersion = await app.request("/assessment/members/member-1/correction", {
    method: "POST",
    headers: { "content-type": "application/json", "idempotency-key": "member-correction-1" },
    body: JSON.stringify({ member: { member_id: "member-1" } }),
  });
  assert.equal(memberMissingVersion.status, 422);
  assert.equal((await memberMissingVersion.json()).code, "EXPECTED_VERSION_INVALID");

  const providerMissingKey = await app.request("/assessment/providers/provider-1/correction", {
    method: "POST",
  });
  assert.equal(providerMissingKey.status, 400);
  assert.equal((await providerMissingKey.json()).code, "MISSING_IDEMPOTENCY_KEY");

  const providerMissingVersion = await app.request("/assessment/providers/provider-1/correction", {
    method: "POST",
    headers: { "content-type": "application/json", "idempotency-key": "provider-correction-1" },
    body: JSON.stringify({ provider: { provider_id: "provider-1" } }),
  });
  assert.equal(providerMissingVersion.status, 422);
  assert.equal((await providerMissingVersion.json()).code, "EXPECTED_VERSION_INVALID");
});

test("correction impact review routes are fixed-policy and state-version guarded", async () => {
  const routeCases = [
    ["GET", "/assessment/correction-impact-reviews", OPERATIONAL_ROUTE_IDS.CORRECTION_IMPACT_REVIEWS_LIST],
    ["GET", "/assessment/correction-impact-reviews/review-1", OPERATIONAL_ROUTE_IDS.CORRECTION_IMPACT_REVIEW_READ],
    ["POST", "/assessment/correction-impact-reviews/review-1/claim", OPERATIONAL_ROUTE_IDS.CORRECTION_IMPACT_REVIEW_CLAIM],
    ["POST", "/assessment/correction-impact-reviews/review-1/complete", OPERATIONAL_ROUTE_IDS.CORRECTION_IMPACT_REVIEW_COMPLETE],
  ];
  for (const [method, pathName, routeId] of routeCases) {
    const policy = resolveOperationalRoutePolicy({ method, path: pathName });
    assert.equal(policy?.id, routeId);
    assert.deepEqual(policy?.permissions, [CLAIMGUARD_PERMISSIONS.CORRECTION_REVIEW_IMPACT]);
  }

  const denied = appFor(authContext());
  assert.equal((await denied.request("/assessment/correction-impact-reviews")).status, 403);

  const permitted = appFor(authContext([CLAIMGUARD_PERMISSIONS.CORRECTION_REVIEW_IMPACT]));
  const claim = await permitted.request("/assessment/correction-impact-reviews/review-1/claim", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({}),
  });
  assert.equal(claim.status, 422);
  assert.equal((await claim.json()).code, "EXPECTED_STATE_VERSION_INVALID");

  const complete = await permitted.request("/assessment/correction-impact-reviews/review-1/complete", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({}),
  });
  assert.equal(complete.status, 422);
  assert.equal((await complete.json()).code, "EXPECTED_STATE_VERSION_INVALID");
});

test("assessment provenance response selects non-sensitive fingerprints and excludes the snapshot", () => {
  const source = readFileSync(
    path.resolve(__dirname, "../src/routes/assessment-routes.js"),
    "utf8",
  );
  const routeStart = source.indexOf("// GET /assessment/versions/:assessmentId");
  assert.ok(routeStart >= 0);
  const routeSource = source.slice(routeStart);
  for (const field of [
    "model_or_rule_version",
    "feature_schema_version",
    "reference_data_version",
    "input_hash",
    "assessment_reason",
    "created_by",
  ]) {
    assert.ok(routeSource.includes(field), `Expected provenance field ${field}.`);
  }
  assert.equal(routeSource.includes("input_snapshot"), false);
});

test("assessment provenance route returns fingerprints and excludes sensitive snapshot fields", async () => {
  const calls = [];
  const pool = {
    async execute(sql, params) {
      calls.push({ sql, params });
      assert.equal(params[0], TENANT_CONTEXT.tenant_id);
      if (sql.includes("FROM assessment_versions")) {
        return [[{
          assessment_id: "assessment-1",
          tenant_id: TENANT_CONTEXT.tenant_id,
          claim_id: "claim-1",
          claim_version: 4,
          member_id: "member-1",
          member_version: 2,
          provider_id: "provider-1",
          provider_version: 3,
          detection_strategy_id: 17,
          strategy_type: "deterministic_rules",
          model_deployment_id: null,
          model_or_rule_version: "claimguard.deterministic-request.v1",
          feature_schema_version: `sha256:${"a".repeat(64)}`,
          reference_data_version: `sha256:${"b".repeat(64)}`,
          input_hash: "c".repeat(64),
          input_snapshot: { banking_detail: "must-not-leak" },
          assessment_reason: "REFERENCE_CORRECTION_REPLACEMENT",
          provenance_status: "COMPLETE",
          source_correction_event_id: "correction-1",
          supersedes_assessment_id: "assessment-0",
          created_by: "user:submitter",
          created_at: new Date("2026-08-01T00:00:00.000Z"),
        }], []];
      }
      if (sql.includes("FROM detection_signal_supersessions")) {
        return [[{
          supersession_id: "supersession-1",
          superseded_signal_id: "signal-0",
          replacement_signal_id: "signal-1",
          replacement_assessment_id: "assessment-1",
          correction_event_id: "correction-1",
          reason_code: "IDENTITY_CORRECTION",
          reason_summary: "Corrected immutable identity context.",
          correlation_id: "request-1",
          created_by: "user:submitter",
          created_at: new Date("2026-08-01T00:01:00.000Z"),
        }], []];
      }
      throw new Error(`Unexpected SQL: ${sql}`);
    },
  };
  const app = appFor(authContext([CLAIMGUARD_PERMISSIONS.ASSESSMENT_READ]));

  const response = await runWithOperationalServices(
    { pool },
    () => app.request("/assessment/versions/assessment-1"),
  );

  assert.equal(response.status, 200);
  const body = await response.json();
  assert.deepEqual({
    assessmentId: body.assessmentId,
    claimVersion: body.claimVersion,
    memberVersion: body.memberVersion,
    providerVersion: body.providerVersion,
    inputHash: body.inputHash,
    provenanceStatus: body.provenanceStatus,
  }, {
    assessmentId: "assessment-1",
    claimVersion: 4,
    memberVersion: 2,
    providerVersion: 3,
    inputHash: "c".repeat(64),
    provenanceStatus: "COMPLETE",
  });
  assert.equal(body.signalSupersessions[0].replacementSignalId, "signal-1");
  assert.doesNotMatch(JSON.stringify(body), /input_snapshot|banking_detail|must-not-leak/i);
  assert.equal(calls.length, 2);
});
