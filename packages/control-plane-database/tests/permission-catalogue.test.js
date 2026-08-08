import assert from "node:assert/strict";
import test from "node:test";

import {
  PERMISSION_CATALOGUE,
  PERMISSION_KEYS,
  getPermissionMetadata,
  isKnownPermission,
  isTenantAssignable,
  isElevatedPermission,
  isDelegablePermission,
  isSystemOnlyPermission,
  validatePermissionKeys,
  filterTenantAssignable,
  partitionElevated,
  getPermissionsByCategory,
  getCategories,
  GOVERNANCE_PROTECTED_PERMISSIONS,
  MAX_DELEGATION_HOURS,
} from "../src/permission-catalogue.js";

test("catalogue contains all expected permission keys", () => {
  assert.ok(PERMISSION_KEYS.length >= 29, `Expected at least 29 permissions, got ${PERMISSION_KEYS.length}`);
  // Verify specific keys exist
  const expected = [
    "claims.view_own", "claims.ingest_own", "claims.view_flagged",
    "reports.view_own",
    "investigations.create", "investigations.manage", "investigations.confirm", "investigations.reverse",
    "registry.search", "registry.review_history",
    "scheme_users.manage", "scheme_roles.assign", "scheme_health.view",
    "organisation.manage", "platform_health.view", "provisioning.manage",
    "platform_releases.view", "platform_releases.request", "platform_releases.approve",
    "platform_administrators.manage", "desktop_devices.manage", "desktop_fleet_policy.manage",
    "access.roles.read", "access.roles.manage",
    "access.assignments.read", "access.assignments.manage",
    "access.delegations.read", "access.delegations.grant", "access.delegations.revoke",
    "access.elevated_permissions.review", "access.audit.read",
  ];
  for (const key of expected) {
    assert.ok(isKnownPermission(key), `Missing expected permission: ${key}`);
  }
});

test("unknown permission returns null metadata", () => {
  assert.equal(getPermissionMetadata("nonexistent.permission"), null);
  assert.equal(isKnownPermission("nonexistent.permission"), false);
});

test("tenant-assignable permissions are correctly classified", () => {
  assert.equal(isTenantAssignable("claims.view_own"), true);
  assert.equal(isTenantAssignable("access.roles.read"), true);
  // Platform permissions are NOT tenant-assignable
  assert.equal(isTenantAssignable("organisation.manage"), false);
  assert.equal(isTenantAssignable("platform_health.view"), false);
  assert.equal(isTenantAssignable("provisioning.manage"), false);
  // Unknown key fails closed
  assert.equal(isTenantAssignable("nonexistent.permission"), false);
});

test("elevated permissions are correctly classified", () => {
  assert.equal(isElevatedPermission("investigations.confirm"), true);
  assert.equal(isElevatedPermission("investigations.reverse"), true);
  assert.equal(isElevatedPermission("access.assignments.manage"), true);
  assert.equal(isElevatedPermission("access.elevated_permissions.review"), true);
  // Standard permissions are not elevated
  assert.equal(isElevatedPermission("claims.view_own"), false);
  assert.equal(isElevatedPermission("access.roles.read"), false);
  // Unknown key fails closed
  assert.equal(isElevatedPermission("nonexistent.permission"), false);
});

test("delegable permissions are correctly classified", () => {
  assert.equal(isDelegablePermission("claims.view_own"), true);
  assert.equal(isDelegablePermission("reports.view_own"), true);
  assert.equal(isDelegablePermission("access.roles.read"), true);
  // Elevated and administration permissions are NOT delegable
  assert.equal(isDelegablePermission("investigations.confirm"), false);
  assert.equal(isDelegablePermission("investigations.reverse"), false);
  assert.equal(isDelegablePermission("access.roles.manage"), false);
  assert.equal(isDelegablePermission("scheme_users.manage"), false);
  // Unknown key fails closed
  assert.equal(isDelegablePermission("nonexistent.permission"), false);
});

test("system-only permissions are correctly classified", () => {
  assert.equal(isSystemOnlyPermission("organisation.manage"), true);
  assert.equal(isSystemOnlyPermission("platform_health.view"), true);
  assert.equal(isSystemOnlyPermission("provisioning.manage"), true);
  assert.equal(isSystemOnlyPermission("platform_releases.view"), true);
  assert.equal(isSystemOnlyPermission("platform_releases.request"), true);
  assert.equal(isSystemOnlyPermission("platform_releases.approve"), true);
  assert.equal(isSystemOnlyPermission("platform_administrators.manage"), true);
  assert.equal(isSystemOnlyPermission("desktop_devices.manage"), true);
  assert.equal(isSystemOnlyPermission("desktop_fleet_policy.manage"), true);
  assert.equal(isSystemOnlyPermission("simulator.control_platform"), true);
  // Non-system permissions
  assert.equal(isSystemOnlyPermission("claims.view_own"), false);
  assert.equal(isSystemOnlyPermission("access.roles.read"), false);
  // Unknown key fails closed
  assert.equal(isSystemOnlyPermission("nonexistent.permission"), false);
});

test("governance and desktop management permissions cannot be tenant-assigned or delegated", () => {
  for (const key of [
    "platform_releases.view",
    "platform_releases.request",
    "platform_releases.approve",
    "platform_administrators.manage",
    "desktop_devices.manage",
    "desktop_fleet_policy.manage",
  ]) {
    assert.equal(isTenantAssignable(key), false, `${key} must not be tenant-assignable`);
    assert.equal(isDelegablePermission(key), false, `${key} must not be delegable`);
  }
});

test("validatePermissionKeys separates valid and unknown", () => {
  const result = validatePermissionKeys([
    "claims.view_own",
    "nonexistent.one",
    "access.roles.read",
    "nonexistent.two",
  ]);
  assert.deepEqual(result.valid, ["claims.view_own", "access.roles.read"]);
  assert.deepEqual(result.unknown, ["nonexistent.one", "nonexistent.two"]);
});

test("filterTenantAssignable excludes non-assignable keys", () => {
  const result = filterTenantAssignable([
    "claims.view_own",
    "organisation.manage",
    "access.roles.read",
    "platform_health.view",
  ]);
  assert.deepEqual(result, ["claims.view_own", "access.roles.read"]);
});

test("partitionElevated separates elevated from standard", () => {
  const result = partitionElevated([
    "claims.view_own",
    "investigations.confirm",
    "access.roles.read",
    "investigations.reverse",
  ]);
  assert.deepEqual(result.elevated, ["investigations.confirm", "investigations.reverse"]);
  assert.deepEqual(result.standard, ["claims.view_own", "access.roles.read"]);
});

test("getPermissionsByCategory returns correct entries", () => {
  const accessManagement = getPermissionsByCategory("access_management");
  assert.ok(accessManagement.length >= 9);
  assert.ok(accessManagement.every((entry) => entry.category === "access_management"));
});

test("getCategories returns distinct categories", () => {
  const categories = getCategories();
  assert.ok(categories.length >= 7);
  assert.ok(categories.includes("claims"));
  assert.ok(categories.includes("investigations"));
  assert.ok(categories.includes("access_management"));
  assert.ok(categories.includes("platform"));
});

test("governance-protected permissions cannot be delegated", () => {
  for (const key of GOVERNANCE_PROTECTED_PERMISSIONS) {
    assert.equal(isDelegablePermission(key), false, `${key} should not be delegable`);
    assert.equal(isElevatedPermission(key), true, `${key} should be elevated`);
  }
});

test("MAX_DELEGATION_HOURS is bounded", () => {
  assert.equal(MAX_DELEGATION_HOURS, 720);
});

test("every catalogue entry has required fields", () => {
  for (const entry of PERMISSION_CATALOGUE) {
    assert.ok(typeof entry.key === "string" && entry.key.length > 0, `key required: ${JSON.stringify(entry)}`);
    assert.ok(typeof entry.description === "string" && entry.description.length > 0, `description required for ${entry.key}`);
    assert.ok(typeof entry.category === "string" && entry.category.length > 0, `category required for ${entry.key}`);
    assert.equal(typeof entry.tenantAssignable, "boolean", `tenantAssignable must be boolean for ${entry.key}`);
    assert.equal(typeof entry.elevated, "boolean", `elevated must be boolean for ${entry.key}`);
    assert.equal(typeof entry.delegable, "boolean", `delegable must be boolean for ${entry.key}`);
    assert.equal(typeof entry.systemOnly, "boolean", `systemOnly must be boolean for ${entry.key}`);
    assert.ok(Number.isInteger(entry.definitionVersion) && entry.definitionVersion >= 1, `definitionVersion required for ${entry.key}`);
  }
});

test("no permission is both system-only and tenant-assignable", () => {
  for (const entry of PERMISSION_CATALOGUE) {
    if (entry.systemOnly) {
      assert.equal(entry.tenantAssignable, false, `${entry.key} is system-only but tenant-assignable`);
    }
  }
});

test("no permission is both elevated and delegable", () => {
  for (const entry of PERMISSION_CATALOGUE) {
    if (entry.elevated) {
      assert.equal(entry.delegable, false, `${entry.key} is elevated but delegable`);
    }
  }
});
