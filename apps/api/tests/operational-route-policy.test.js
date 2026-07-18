import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createBackendApp } from "../src/backend.js";
import {
  OPERATIONAL_ROUTE_IDS,
  OPERATIONAL_ROUTE_POLICIES,
  isOperationalRoutePath,
  resolveOperationalRoutePolicy,
} from "../src/authorization-policy.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function patternMatchesPath(pathPattern, requestPath) {
  const patternSegments = String(pathPattern || "").split("/").filter(Boolean);
  const pathSegments = String(requestPath || "").split("/").filter(Boolean);
  if (patternSegments.length !== pathSegments.length) return false;

  for (let index = 0; index < patternSegments.length; index += 1) {
    const patternSegment = patternSegments[index];
    const pathSegment = pathSegments[index];
    if (patternSegment.startsWith(":")) {
      if (!pathSegment) return false;
      continue;
    }
    if (patternSegment !== pathSegment) return false;
  }

  return true;
}

function listRegisteredOperationalRoutes() {
  const app = createBackendApp();
  const seen = new Set();
  const routes = [];
  for (const route of app.routes || []) {
    const method = String(route.method || "").toUpperCase();
    const path = String(route.path || "");
    if (!method || method === "ALL") continue;
    if (!isOperationalRoutePath(path)) continue;
    const key = `${method} ${path}`;
    if (seen.has(key)) continue;
    seen.add(key);
    routes.push({ method, path });
  }
  return routes;
}

test("route matcher resolves canonical policy for specific vs broad parameterized paths", () => {
  const search = resolveOperationalRoutePolicy({ method: "GET", path: "/registry/search" });
  const history = resolveOperationalRoutePolicy({ method: "GET", path: "/registry/history/SUBJECT" });
  const detail = resolveOperationalRoutePolicy({ method: "GET", path: "/registry/entry-1" });

  assert.equal(search?.id, OPERATIONAL_ROUTE_IDS.REGISTRY_SEARCH);
  assert.equal(history?.id, OPERATIONAL_ROUTE_IDS.REGISTRY_HISTORY);
  assert.equal(detail?.id, OPERATIONAL_ROUTE_IDS.REGISTRY_DETAIL);
});

test("policy matcher defines explicit HEAD and OPTIONS behavior and fails closed for unsupported methods", () => {
  const headPolicy = resolveOperationalRoutePolicy({ method: "HEAD", path: "/claims" });
  const optionsPolicy = resolveOperationalRoutePolicy({ method: "OPTIONS", path: "/claims" });
  const unsupported = resolveOperationalRoutePolicy({ method: "PUT", path: "/claims" });

  assert.equal(headPolicy?.id, OPERATIONAL_ROUTE_IDS.CLAIMS_LIST);
  assert.equal(optionsPolicy?.bypassAuthorization, true);
  assert.equal(optionsPolicy?.requiresOperationalDataPlane, false);
  assert.equal(unsupported, undefined);
});

test("every registered operational route has a canonical policy entry", () => {
  const routes = listRegisteredOperationalRoutes();
  for (const route of routes) {
    const policy = resolveOperationalRoutePolicy(route);
    assert.ok(policy, `Missing policy mapping for ${route.method} ${route.path}`);
    assert.notEqual(policy, undefined, `Unmapped policy for ${route.method} ${route.path}`);

    const matchingPolicies = OPERATIONAL_ROUTE_POLICIES
      .filter((entry) => entry.method === route.method && patternMatchesPath(entry.pathPattern, route.path));
    assert.ok(matchingPolicies.length >= 1, `Expected at least one canonical match for ${route.method} ${route.path}`);
    assert.equal(
      matchingPolicies[0].id,
      policy.id,
      `Canonical resolver must select the first matching policy for ${route.method} ${route.path}`,
    );
  }
});

test("every canonical policy entry is still registered in backend routes", () => {
  const registered = new Set(listRegisteredOperationalRoutes().map((route) => `${route.method} ${route.path}`));
  for (const policy of OPERATIONAL_ROUTE_POLICIES) {
    const key = `${policy.method} ${policy.pathPattern}`;
    assert.ok(registered.has(key), `Policy ${policy.id} references unregistered route ${key}`);
    assert.ok(
      Array.isArray(policy.permissions) || typeof policy.resolvePermissionRequirement === "function",
      `Policy ${policy.id} must define permissions or a dynamic requirement resolver`,
    );
    assert.ok(["all", "any"].includes(policy.permissionMode), `Policy ${policy.id} has invalid permission mode`);
    assert.equal(typeof policy.requiresOperationalDataPlane, "boolean", `Policy ${policy.id} must set requiresOperationalDataPlane`);
  }
});

test("matcher handles specific-vs-parameterized edge cases for claims and investigations", () => {
  const claimsIngestPost = resolveOperationalRoutePolicy({ method: "POST", path: "/claims/ingest" });
  const claimsIngestPut = resolveOperationalRoutePolicy({ method: "PUT", path: "/claims/ingest" });
  const investigationsConfirmPost = resolveOperationalRoutePolicy({ method: "POST", path: "/investigations/confirm-fraud" });
  const investigationsConfirmGet = resolveOperationalRoutePolicy({ method: "GET", path: "/investigations/confirm-fraud" });
  const noteRoute = resolveOperationalRoutePolicy({ method: "POST", path: "/investigations/INV-1/notes" });
  const evidenceRoute = resolveOperationalRoutePolicy({ method: "POST", path: "/investigations/INV-1/evidence" });

  assert.equal(claimsIngestPost?.id, OPERATIONAL_ROUTE_IDS.CLAIMS_INGEST);
  assert.equal(claimsIngestPut, undefined);
  assert.equal(investigationsConfirmPost?.id, OPERATIONAL_ROUTE_IDS.INVESTIGATIONS_CONFIRM_FRAUD);
  assert.equal(investigationsConfirmGet?.id, OPERATIONAL_ROUTE_IDS.INVESTIGATIONS_VIEW);
  assert.equal(noteRoute?.id, OPERATIONAL_ROUTE_IDS.INVESTIGATIONS_ADD_NOTE);
  assert.equal(evidenceRoute?.id, OPERATIONAL_ROUTE_IDS.INVESTIGATIONS_UPLOAD_EVIDENCE);
});

test("operational routes rely on canonical route ids rather than local permission arrays", () => {
  const routeFiles = [
    "../src/routes/claims-routes.js",
    "../src/routes/investigations-routes.js",
    "../src/routes/detection-routes.js",
    "../src/routes/ledger-routes.js",
    "../src/routes/registry-routes.js",
    "../src/routes/simulation-routes.js",
    "../src/routes/admin-routes.js",
  ];

  for (const relativePath of routeFiles) {
    const absolutePath = path.resolve(__dirname, relativePath);
    const source = readFileSync(absolutePath, "utf8");
    assert.ok(
      source.includes("createRequireOperationalRouteAuthorizationMiddleware"),
      `${relativePath} must use canonical operational route authorization middleware`,
    );
    assert.equal(
      source.includes("createRequirePermissionMiddleware"),
      false,
      `${relativePath} should not use direct permission middleware for operational routes`,
    );
    assert.equal(
      source.includes("createRequireAnyPermissionMiddleware"),
      false,
      `${relativePath} should not use direct any-permission middleware for operational routes`,
    );
  }
});

test("legacy duplicated middleware permission-map patterns are absent", () => {
  const middlewareSource = readFileSync(path.resolve(__dirname, "../src/middleware/data-plane-middleware.js"), "utf8");
  assert.equal(middlewareSource.includes("resolveOperationalPermissionRequirement"), false);
  assert.equal(middlewareSource.includes("isPermittedForOperationalPath"), false);
  assert.equal(middlewareSource.includes("operationalRoutePermissions"), false);
  assert.ok(middlewareSource.includes("resolveOperationalRoutePolicy"));
});
