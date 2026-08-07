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
