import assert from "node:assert/strict";
import test from "node:test";

import {
  createAuthenticatedAuthContext,
  operationalPermissions,
  resolveAuthContextFromHeaders,
} from "../src/middleware/auth-context.js";
import { CLAIMGUARD_PERMISSIONS, hasPermission } from "../src/authorization-policy.js";

function headerContext(role) {
  return resolveAuthContextFromHeaders({
    request: new Request("http://localhost/claims", {
      headers: {
        "x-claimguard-user": `${role}-user`,
        "x-claimguard-role": role,
        "x-claimguard-user-tenant": "tenant-alpha",
      },
    }),
  });
}

function sessionContext(role, controlPermissions = []) {
  return createAuthenticatedAuthContext({
    userId: `${role}-user`,
    roles: [role],
    permissions: operationalPermissions(controlPermissions, [role]),
    tenantId: "tenant-alpha",
  });
}

test("session fraud analysts and investigators can read tenant claims", () => {
  for (const role of ["fraud_analyst", "investigator"]) {
    const context = sessionContext(role);
    assert.equal(hasPermission(context, CLAIMGUARD_PERMISSIONS.CLAIMS_VIEW_OWN), true);
  }
});

test("scheme administrator sessions receive read-only operational visibility", () => {
  const context = sessionContext("scheme_administrator", [
    "scheme_users.manage",
    "scheme_health.view",
  ]);

  assert.equal(hasPermission(context, CLAIMGUARD_PERMISSIONS.CLAIMS_VIEW_OWN), true);
  assert.equal(hasPermission(context, CLAIMGUARD_PERMISSIONS.REPORTS_VIEW_OWN), true);
  assert.equal(hasPermission(context, CLAIMGUARD_PERMISSIONS.INVESTIGATIONS_VIEW), true);
  assert.equal(hasPermission(context, CLAIMGUARD_PERMISSIONS.FRAUD_REGISTRY_REVIEW_HISTORY), true);
  assert.equal(hasPermission(context, CLAIMGUARD_PERMISSIONS.CLAIMS_INGEST), false);
  assert.equal(hasPermission(context, CLAIMGUARD_PERMISSIONS.INVESTIGATIONS_CREATE), false);
  assert.equal(hasPermission(context, CLAIMGUARD_PERMISSIONS.INVESTIGATIONS_UPDATE_STATUS), false);
  assert.equal(hasPermission(context, CLAIMGUARD_PERMISSIONS.INVESTIGATIONS_CONFIRM_FRAUD), false);
});

test("session capability translation applies role overlays during migration rollout", () => {
  const capabilities = operationalPermissions(
    ["scheme_users.manage", "scheme_health.view"],
    ["scheme_administrator"],
  );

  assert.deepEqual(new Set(capabilities), new Set([
    "users.manage_tenant",
    "tenant_status.view",
    "claims.view_own",
    "reports.view_own",
    "investigations.view",
    "fraud_registry.review_history",
  ]));
});

test("demo-header rollback authority remains governed by the legacy role map", () => {
  const investigator = headerContext("investigator");
  const schemeAdministrator = headerContext("scheme_administrator");

  assert.equal(hasPermission(investigator, CLAIMGUARD_PERMISSIONS.CLAIMS_VIEW_OWN), false);
  assert.equal(hasPermission(schemeAdministrator, CLAIMGUARD_PERMISSIONS.REPORTS_VIEW_OWN), false);
});
