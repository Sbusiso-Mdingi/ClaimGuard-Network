import assert from "node:assert/strict";
import test from "node:test";

import {
  createAuthenticatedAuthContext,
  operationalPermissions,
} from "../src/middleware/auth-context.js";
import { CLAIMGUARD_PERMISSIONS, hasPermission } from "../src/authorization-policy.js";

function sessionContext({ role, permissions = [] }) {
  return createAuthenticatedAuthContext({
    userId: `${role}-user`,
    roles: [role],
    permissions: operationalPermissions(permissions),
    tenantId: "tenant-alpha",
    source: "session",
  });
}

test("explicit claim-read permissions authorize fraud analysts and investigators", () => {
  for (const role of ["fraud_analyst", "investigator"]) {
    const context = sessionContext({ role, permissions: ["claims.view_own"] });
    const roleOnlyContext = sessionContext({ role });

    assert.deepEqual(context.roles, [role]);
    assert.equal(hasPermission(context, CLAIMGUARD_PERMISSIONS.CLAIMS_VIEW_OWN), true);
    assert.equal(hasPermission(roleOnlyContext, CLAIMGUARD_PERMISSIONS.CLAIMS_VIEW_OWN), false);
  }
});

test("scheme administrator sessions receive only explicitly resolved visibility", () => {
  const context = sessionContext({
    role: "scheme_administrator",
    permissions: [
      "claims.view_own",
      "reports.view_own",
      "investigations.view_own",
      "registry.review_history",
      "scheme_users.manage",
      "scheme_health.view",
    ],
  });

  assert.equal(hasPermission(context, CLAIMGUARD_PERMISSIONS.CLAIMS_VIEW_OWN), true);
  assert.equal(hasPermission(context, CLAIMGUARD_PERMISSIONS.REPORTS_VIEW_OWN), true);
  assert.equal(hasPermission(context, CLAIMGUARD_PERMISSIONS.INVESTIGATIONS_VIEW), true);
  assert.equal(hasPermission(context, CLAIMGUARD_PERMISSIONS.FRAUD_REGISTRY_REVIEW_HISTORY), true);
  assert.equal(hasPermission(context, CLAIMGUARD_PERMISSIONS.USERS_MANAGE_TENANT), true);
  assert.equal(hasPermission(context, CLAIMGUARD_PERMISSIONS.TENANT_STATUS_VIEW), true);
  assert.equal(hasPermission(context, CLAIMGUARD_PERMISSIONS.CLAIMS_INGEST), false);
  assert.equal(hasPermission(context, CLAIMGUARD_PERMISSIONS.INVESTIGATIONS_CREATE), false);
  assert.equal(hasPermission(context, CLAIMGUARD_PERMISSIONS.INVESTIGATIONS_UPDATE_STATUS), false);
  assert.equal(hasPermission(context, CLAIMGUARD_PERMISSIONS.INVESTIGATIONS_CONFIRM_FRAUD), false);
});

test("session capability translation uses explicit permissions and ignores role metadata", () => {
  const capabilities = operationalPermissions([
    "scheme_users.manage",
    "scheme_health.view",
  ]);

  assert.deepEqual(new Set(capabilities), new Set([
    "users.manage_tenant",
    "tenant_status.view",
  ]));
  assert.equal(capabilities.includes("claims.view_own"), false);
  assert.equal(capabilities.includes("reports.view_own"), false);
  assert.equal(capabilities.includes("investigations.view"), false);
  assert.equal(capabilities.includes("fraud_registry.review_history"), false);
});

test("platform administrator sessions retain administrator-management authority", () => {
  const context = sessionContext({
    role: "platform_administrator",
    permissions: [
      "platform_releases.view",
      "platform_releases.request",
      "platform_releases.approve",
      "platform_administrators.manage",
      "desktop_fleet_policy.manage",
    ],
  });

  assert.equal(
    hasPermission(
      context,
      CLAIMGUARD_PERMISSIONS.PLATFORM_ADMINISTRATORS_MANAGE,
    ),
    true,
  );
  assert.equal(
    hasPermission(context, CLAIMGUARD_PERMISSIONS.DESKTOP_FLEET_POLICY_MANAGE),
    true,
  );
});

test("authenticated contexts preserve visible roles without deriving authority from them", () => {
  const investigator = sessionContext({
    role: "investigator",
    permissions: ["claims.view_own"],
  });
  const schemeAdministrator = sessionContext({
    role: "scheme_administrator",
    permissions: ["reports.view_own"],
  });
  const committeeMember = sessionContext({
    role: "applications_committee_member",
    permissions: ["registry.search", "registry.review_history"],
  });
  const roleOnlyInvestigator = sessionContext({ role: "investigator" });

  assert.deepEqual(investigator.roles, ["investigator"]);
  assert.equal(hasPermission(investigator, CLAIMGUARD_PERMISSIONS.CLAIMS_VIEW_OWN), true);
  assert.equal(hasPermission(schemeAdministrator, CLAIMGUARD_PERMISSIONS.REPORTS_VIEW_OWN), true);
  assert.equal(hasPermission(committeeMember, CLAIMGUARD_PERMISSIONS.FRAUD_REGISTRY_SEARCH), true);
  assert.equal(hasPermission(committeeMember, CLAIMGUARD_PERMISSIONS.FRAUD_REGISTRY_VIEW), true);
  assert.equal(hasPermission(committeeMember, CLAIMGUARD_PERMISSIONS.FRAUD_REGISTRY_REVIEW_HISTORY), true);
  assert.equal(
    hasPermission(roleOnlyInvestigator, CLAIMGUARD_PERMISSIONS.CLAIMS_VIEW_OWN),
    false,
  );
});
