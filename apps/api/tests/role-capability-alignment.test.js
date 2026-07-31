import assert from "node:assert/strict";
import test from "node:test";

import {
  createAuthenticatedAuthContext,
  operationalPermissions,
} from "../src/middleware/auth-context.js";
import { CLAIMGUARD_PERMISSIONS, hasPermission } from "../src/authorization-policy.js";

function sessionContext(role, controlPermissions = []) {
  return createAuthenticatedAuthContext({
    userId: `${role}-user`,
    roles: [role],
    permissions: operationalPermissions(controlPermissions, [role]),
    tenantId: "tenant-alpha",
    source: "session",
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

test("platform administrator sessions retain administrator-management authority", () => {
  const context = sessionContext("platform_administrator", [
    "platform_releases.view",
    "platform_releases.request",
    "platform_releases.approve",
    "platform_administrators.manage",
  ]);

  assert.equal(
    hasPermission(
      context,
      CLAIMGUARD_PERMISSIONS.PLATFORM_ADMINISTRATORS_MANAGE,
    ),
    true,
  );
});

test("explicit authenticated contexts preserve effective role visibility", () => {
  const investigator = sessionContext("investigator");
  const schemeAdministrator = sessionContext("scheme_administrator");
  const committeeMember = sessionContext("applications_committee_member");

  assert.equal(hasPermission(investigator, CLAIMGUARD_PERMISSIONS.CLAIMS_VIEW_OWN), true);
  assert.equal(hasPermission(schemeAdministrator, CLAIMGUARD_PERMISSIONS.REPORTS_VIEW_OWN), true);
  assert.equal(hasPermission(committeeMember, CLAIMGUARD_PERMISSIONS.FRAUD_REGISTRY_SEARCH), true);
  assert.equal(hasPermission(committeeMember, CLAIMGUARD_PERMISSIONS.FRAUD_REGISTRY_VIEW), true);
  assert.equal(hasPermission(committeeMember, CLAIMGUARD_PERMISSIONS.FRAUD_REGISTRY_REVIEW_HISTORY), true);
});
