import assert from "node:assert/strict";
import test from "node:test";

import {
  assertDistinctDatabaseUrls,
  assertNoPlaintextPassword,
  assertSafeControlPlaneSummary,
  canonicalRoleKey,
  isControlPlaneShadowEnabled,
  normalizeOrganisationSlug,
  projectSafeCredential,
  projectSafeDemoCatalogueEntry,
  projectSafeRoute,
  projectSafeSession,
  requireControlPlaneDatabaseUrl,
  validateSecretReference,
} from "../src/index.js";

test("shadow gate is disabled by default and control URL never falls back", () => {
  assert.equal(isControlPlaneShadowEnabled({}), false);
  assert.equal(isControlPlaneShadowEnabled({ CONTROL_PLANE_SHADOW_ENABLED: "true" }), true);
  assert.throws(() => requireControlPlaneDatabaseUrl({ MYSQL_URL: "mysql://user:pass@localhost/operational" }), /CONTROL_PLANE_MYSQL_URL/);
  assert.throws(
    () => assertDistinctDatabaseUrls("mysql://cp:secret@localhost/shared", "mysql://ops:other@localhost/shared"),
    /distinct/,
  );
});

test("canonical slugs normalize only trim and case and reject unsafe forms", () => {
  assert.equal(normalizeOrganisationSlug("  Discovery-Health "), "discovery-health");
  for (const invalid of ["discovery health", "-discovery", "discovery-", "d", "díscovery", "discovery_health"]) {
    assert.throws(() => normalizeOrganisationSlug(invalid), /slug/i);
  }
});

test("role aliases resolve to one canonical role", () => {
  assert.equal(canonicalRoleKey("scheme_user"), "claims_analyst");
  assert.equal(canonicalRoleKey("new-applications-officer"), "applications_committee_member");
  assert.equal(canonicalRoleKey("Investigator"), "investigator");
});

test("plaintext passwords, raw connection strings, and private audit data are rejected", () => {
  assert.throws(() => assertNoPlaintextPassword({ password: "not-allowed" }), /Plaintext/);
  assert.throws(() => validateSecretReference("mysql://user:password@host/database"), /secret value|connection string/);
  assert.equal(validateSecretReference("https://vault.example/secrets/tenant-alpha-db"), "https://vault.example/secrets/tenant-alpha-db");
  assert.throws(() => validateSecretReference("hunter2"), /reference/i);
  assert.throws(() => validateSecretReference("https://vault.example/secrets/item?token=raw"), /reference/i);
  assert.throws(() => assertSafeControlPlaneSummary({ investigation_notes: ["private"] }), /not permitted/);
  assert.throws(() => assertSafeControlPlaneSummary({ nested: { diagnosis: "private" } }), /not permitted/);
});

test("session projection represents revoked and expired foundations without exposing its hash", () => {
  const absoluteExpiry = new Date("2025-01-01T00:00:00Z");
  const revokedAt = new Date("2024-12-31T00:00:00Z");
  const session = projectSafeSession({
    session_id: "s", user_id: "u", organisation_id: "o", membership_id: "m",
    absolute_expires_at: absoluteExpiry, revoked_at: revokedAt, revocation_reason: "administrative",
    authorization_version: 2, hashed_bearer_secret: "a".repeat(64),
  });
  assert.equal(session.absoluteExpiresAt, absoluteExpiry);
  assert.equal(session.revokedAt, revokedAt);
  assert.equal(session.revocationReason, "administrative");
  assert.equal(Object.hasOwn(session, "hashedBearerSecret"), false);
});

test("disabled demo entries are omitted from safe projections", () => {
  assert.equal(projectSafeDemoCatalogueEntry({ enabled: 0, secret_reference: "kv://demo" }), null);
});

test("safe projections exclude password hashes, route secret references, session hashes, and demo secrets", () => {
  const credential = projectSafeCredential({
    credential_id: "c", user_id: "u", organisation_id: "o", authentication_provider: "local_password",
    normalized_username: "user", status: "disabled", failed_attempt_count: 2, password_hash: "hash",
  });
  assert.equal(credential.passwordConfigured, true);
  assert.equal(Object.hasOwn(credential, "passwordHash"), false);

  const route = projectSafeRoute({
    route_id: "r", organisation_id: "o", route_type: "legacy_shared", logical_database_identifier: "legacy",
    route_generation: 1, provisioning_status: "pending", health_status: "unknown", secret_reference: "kv://secret",
  });
  assert.equal(Object.hasOwn(route, "secretReference"), false);

  const session = projectSafeSession({
    session_id: "s", user_id: "u", organisation_id: "o", membership_id: "m", authorization_version: 1,
    hashed_bearer_secret: "a".repeat(64),
  });
  assert.equal(Object.hasOwn(session, "hashedBearerSecret"), false);

  const demo = projectSafeDemoCatalogueEntry({
    catalogue_entry_id: "d", organisation_id: "o", membership_id: "m", display_label: "Demo",
    role_label: "Investigator", username_display_value: "demo", display_order: 1, enabled: 1,
    secret_reference: "kv://demo-secret",
  });
  assert.equal(Object.hasOwn(demo, "secretReference"), false);
});
