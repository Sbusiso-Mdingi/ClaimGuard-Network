import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { loadControlPlaneMigrations } from "../src/index.js";

test("control-plane schema contains required foundations and excludes operational domains", async () => {
  const migrations = await loadControlPlaneMigrations();
  const sql = migrations.map((migration) => migration.sql).join("\n").toLowerCase();
  const required = [
    "organisations", "organisation_slugs", "users", "credential_identities", "organisation_memberships",
    "roles", "permissions", "role_permissions", "membership_roles", "data_plane_routes", "legacy_tenant_mappings",
    "organisation_provisioning_operations", "provisioning_steps", "organisation_schema_status",
    "report_storage_partitions", "worker_routing_status", "login_sessions", "authentication_events",
    "platform_audit_events", "demo_account_catalogue", "organisation_feature_flags", "organisation_branding",
  ];
  for (const table of required) assert.match(sql, new RegExp(`create table if not exists ${table}\\b`));

  for (const table of ["claims", "members", "providers", "investigations", "investigation_notes", "investigation_evidence", "ledger_entries", "shared_fraud_registry_entries", "simulation_instances"]) {
    assert.doesNotMatch(sql, new RegExp(`create table if not exists ${table}\\b`));
  }
  assert.doesNotMatch(sql, /plaintext_password\s/);
  assert.doesNotMatch(sql, /raw_session_token\s/);
  assert.doesNotMatch(sql, /connection_string\s/);
});

test("operational migrations 0001-0007 do not contain control-plane tables", async () => {
  for (let number = 1; number <= 7; number += 1) {
    const padded = String(number).padStart(4, "0");
    const migration = (await import("node:fs/promises")).readdir;
    const files = await migration(new URL("../../database/migrations/", import.meta.url));
    const file = files.find((name) => name.startsWith(`${padded}_`));
    const sql = await readFile(new URL(`../../database/migrations/${file}`, import.meta.url), "utf8");
    assert.doesNotMatch(sql, /CREATE TABLE IF NOT EXISTS organisations\b/i);
    assert.doesNotMatch(sql, /control_plane_migration_history/i);
  }
});

test("canonical authorization seed is insert-only and grants platform admin no private claim access", async () => {
  const sql = await readFile(new URL("../migrations/0004_canonical_authorization_seed.sql", import.meta.url), "utf8");
  assert.match(sql, /scheme_user.*claims_analyst/s);
  assert.match(sql, /new_applications_officer.*applications_committee_member/s);
  const platformGrants = sql.match(/\('platform_administrator', '[^']+'\)/g) || [];
  assert.equal(platformGrants.some((grant) => /claims\.|investigations\./.test(grant)), false);
  assert.doesNotMatch(sql, /DELETE\s+FROM|UPDATE\s+role_permissions/i);
});

test("Phase 11B adds no login endpoint or active API control-plane dependency", async () => {
  const backend = await readFile(new URL("../../../apps/api/src/backend.js", import.meta.url), "utf8");
  const server = await readFile(new URL("../../../apps/api/src/backend-server.js", import.meta.url), "utf8");
  assert.doesNotMatch(`${backend}\n${server}`, /control-plane-database|CONTROL_PLANE_MYSQL_URL|\/auth\/login/);
});

test("schema constraints encode immutable IDs, scoped identities, aliases, and one active route", async () => {
  const migrations = await loadControlPlaneMigrations();
  const sql = migrations.map((migration) => migration.sql).join("\n");
  assert.match(sql, /organisation_id CHAR\(36\) PRIMARY KEY/);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS organisation_slugs[\s\S]*slug_type[\s\S]*redirect_to_slug/);
  assert.match(sql, /UNIQUE KEY uq_credentials_org_provider_username \(organisation_id, authentication_provider, normalized_username\)/);
  assert.match(sql, /UNIQUE KEY uq_memberships_user_organisation \(user_id, organisation_id\)/);
  assert.match(sql, /UNIQUE KEY uq_data_plane_active_slot \(active_route_slot\)/);
  assert.match(sql, /CONSTRAINT chk_data_plane_slot CHECK \(active_route_slot IS NULL OR active_route_slot = organisation_id\)/);
});

test("schema represents suspended organisations, disabled credentials, revocation, and compensation", async () => {
  const migrations = await loadControlPlaneMigrations();
  const sql = migrations.map((migration) => migration.sql).join("\n");
  assert.match(sql, /suspended_at TIMESTAMP\(3\) NULL/);
  assert.match(sql, /suspension_reason VARCHAR\(512\) NULL/);
  assert.match(sql, /chk_organisation_activation CHECK \(activation_state IN \('not_activated', 'activated', 'suspended', 'deactivated'\)\)/);
  assert.match(sql, /chk_credential_status CHECK \(status IN \('pending_activation', 'active', 'disabled', 'locked', 'archived'\)\)/);
  assert.match(sql, /revoked_at TIMESTAMP\(3\) NULL/);
  assert.match(sql, /compensation_status VARCHAR\(32\) NOT NULL DEFAULT 'not_required'/);
  assert.match(sql, /'pending', 'running', 'completed', 'failed', 'compensating', 'compensated', 'quarantined'/);
});
