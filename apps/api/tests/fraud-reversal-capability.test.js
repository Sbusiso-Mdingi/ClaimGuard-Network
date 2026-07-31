import assert from "node:assert/strict";
import test from "node:test";

import {
  CLAIMGUARD_PERMISSIONS,
  CLAIMGUARD_ROLES,
  OPERATIONAL_ROUTE_IDS,
  getOperationalRoutePolicyById,
  getPermissionsForRoles,
} from "../src/authorization-policy.js";
import { operationalPermissions } from "../src/middleware/auth-context.js";

test("control-plane confirmation and reversal authorities translate independently", () => {
  const confirmation = new Set(operationalPermissions(["investigations.confirm"]));
  const reversal = new Set(operationalPermissions(["investigations.reverse"]));

  assert.equal(confirmation.has(CLAIMGUARD_PERMISSIONS.INVESTIGATIONS_CONFIRM_FRAUD), true);
  assert.equal(confirmation.has(CLAIMGUARD_PERMISSIONS.INVESTIGATIONS_REVERSE_FRAUD), false);
  assert.equal(reversal.has(CLAIMGUARD_PERMISSIONS.INVESTIGATIONS_REVERSE_FRAUD), true);
  assert.equal(reversal.has(CLAIMGUARD_PERMISSIONS.INVESTIGATIONS_CONFIRM_FRAUD), false);
});

test("investigator role receives separate confirm and reverse assignments", () => {
  const permissions = getPermissionsForRoles([CLAIMGUARD_ROLES.INVESTIGATOR]);

  assert.equal(permissions.has(CLAIMGUARD_PERMISSIONS.INVESTIGATIONS_CONFIRM_FRAUD), true);
  assert.equal(permissions.has(CLAIMGUARD_PERMISSIONS.INVESTIGATIONS_REVERSE_FRAUD), true);
});

test("fraud confirmation and reversal routes require their own capabilities", () => {
  const confirmation = getOperationalRoutePolicyById(OPERATIONAL_ROUTE_IDS.INVESTIGATIONS_CONFIRM_FRAUD);
  const reversal = getOperationalRoutePolicyById(OPERATIONAL_ROUTE_IDS.INVESTIGATIONS_REVERSE_FRAUD);

  assert.deepEqual(confirmation.permissions, [CLAIMGUARD_PERMISSIONS.INVESTIGATIONS_CONFIRM_FRAUD]);
  assert.deepEqual(reversal.permissions, [CLAIMGUARD_PERMISSIONS.INVESTIGATIONS_REVERSE_FRAUD]);
});
