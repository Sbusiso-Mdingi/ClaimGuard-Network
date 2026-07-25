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

test("fraud analysts and investigators can read tenant claims", () => {
  for (const role of ["fraud_analyst", "investigator"]) {
    const context = headerContext(role);
    assert.equal(hasPermission(context, CLAIMGUARD_PERMISSIONS.CLAIMS_VIEW_OWN), true);
  }
});

test("scheme administrators receive read-only operational visibility", () => {
  const context = headerContext("scheme_administrator");

  assert.equal(hasPermission(context, CLAIMGUARD_PERMISSIONS.CLAIMS_VIEW_OWN), true);
  assert.equal(hasPermission(context, CLAIMGUARD_PERMISSIONS.REPORTS_VIEW_OWN), true);
  assert.equal(hasPermission(context, CLAIMGUARD_PERMISSIONS.INVESTIGATIONS_VIEW), true);
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
  ]));

  const context = createAuthenticatedAuthContext({
    userId: "scheme-admin-1",
    roles: ["scheme_administrator"],
    permissions: capabilities,
    tenantId: "tenant-alpha",
  });
  assert.equal(hasPermission(context, CLAIMGUARD_PERMISSIONS.CLAIMS_VIEW_OWN), true);
});
