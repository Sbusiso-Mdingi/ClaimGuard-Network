import assert from "node:assert/strict";
import test from "node:test";

import {
  CLAIMGUARD_PERMISSIONS,
  CLAIMGUARD_ROLES,
  OPERATIONAL_ROUTE_IDS,
  getOperationalRoutePolicyById,
} from "../src/authorization-policy.js";
import {
  createAuthenticatedAuthContext,
  operationalPermissions,
} from "../src/middleware/auth-context.js";

test("control-plane confirmation and reversal authorities remain non-operational compatibility keys", () => {
  const confirmation = new Set(operationalPermissions(["investigations.confirm"]));
  const reversal = new Set(operationalPermissions(["investigations.reverse"]));

  assert.equal(confirmation.has(CLAIMGUARD_PERMISSIONS.INVESTIGATIONS_CONFIRM_FRAUD), false);
  assert.equal(confirmation.has("investigations.confirm"), true);
  assert.equal(reversal.has(CLAIMGUARD_PERMISSIONS.INVESTIGATIONS_REVERSE_FRAUD), false);
  assert.equal(reversal.has("investigations.reverse"), true);
});

test("investigator role metadata grants no confirmation or reversal authority", () => {
  const context = createAuthenticatedAuthContext({
    userId: "investigator-user",
    roles: [CLAIMGUARD_ROLES.INVESTIGATOR],
    permissions: [],
    tenantId: "tenant-alpha",
  });

  assert.deepEqual(context.roles, [CLAIMGUARD_ROLES.INVESTIGATOR]);
  assert.equal(
    context.permissions.has(CLAIMGUARD_PERMISSIONS.INVESTIGATIONS_CONFIRM_FRAUD),
    false,
  );
  assert.equal(
    context.permissions.has(CLAIMGUARD_PERMISSIONS.INVESTIGATIONS_REVERSE_FRAUD),
    false,
  );
});

test("fraud confirmation and reversal routes retain separate disabled capability boundaries", () => {
  const confirmation = getOperationalRoutePolicyById(OPERATIONAL_ROUTE_IDS.INVESTIGATIONS_CONFIRM_FRAUD);
  const reversal = getOperationalRoutePolicyById(OPERATIONAL_ROUTE_IDS.INVESTIGATIONS_REVERSE_FRAUD);

  assert.deepEqual(confirmation.permissions, [CLAIMGUARD_PERMISSIONS.INVESTIGATIONS_CONFIRM_FRAUD]);
  assert.deepEqual(reversal.permissions, [CLAIMGUARD_PERMISSIONS.INVESTIGATIONS_REVERSE_FRAUD]);
});
