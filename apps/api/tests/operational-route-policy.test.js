import assert from "node:assert/strict";
import test from "node:test";

import { createBackendApp } from "../src/backend.js";
import {
  OPERATIONAL_ROUTE_IDS,
  OPERATIONAL_ROUTE_POLICIES,
  isOperationalRoutePath,
  resolveOperationalRoutePolicy,
} from "../src/authorization-policy.js";

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
  }
});

test("every canonical policy entry is still registered in backend routes", () => {
  const registered = new Set(listRegisteredOperationalRoutes().map((route) => `${route.method} ${route.path}`));
  for (const policy of OPERATIONAL_ROUTE_POLICIES) {
    const key = `${policy.method} ${policy.pathPattern}`;
    assert.ok(registered.has(key), `Policy ${policy.id} references unregistered route ${key}`);
  }
});
