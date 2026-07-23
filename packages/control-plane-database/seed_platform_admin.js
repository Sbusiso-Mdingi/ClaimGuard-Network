#!/usr/bin/env node
/**
 * ClaimGuard Platform Reset & Admin Seed
 * ========================================
 * This script:
 *   1. Wipes ALL data from the control-plane database (users, orgs, sessions, etc.)
 *   2. Wipes ALL data from the data-plane database (claims, investigations, etc.)
 *   3. Re-seeds the canonical roles and permissions (from migration 0004)
 *   4. Creates the platform-operations organisation + sysadmin account
 *
 * IMPORTANT: This file is LOCAL-ONLY and must NEVER be committed to source control.
 *
 * Usage:
 *   CONTROL_PLANE_MYSQL_URL="mysql://..." MYSQL_URL="mysql://..." node seed_platform_admin.js
 */

import crypto from "node:crypto";
import mysql from "mysql2/promise";
import { hashPassword, passwordParametersRecord, ARGON2ID_VERSION } from "./src/index.js";

// ─── Configuration (NEVER COMMIT THESE) ─────────────────────────────
const PLATFORM_ORG_SLUG = "platform-operations";
const ADMIN_USERNAME = "sysadmin";
const ADMIN_PASSWORD = "GeMqL8pl5FIfcLe1";
const ADMIN_DISPLAY_NAME = "System Administrator";

// ─── Control-plane tables (in FK-safe deletion order) ────────────────
const CONTROL_PLANE_TABLES = [
  "login_throttle_buckets",
  "login_sessions",
  "authentication_events",
  "platform_audit_events",
  "membership_roles",
  "organisation_memberships",
  "credential_identities",
  "users",
  "organisation_integration_credentials",
  "worker_routing_status",
  "report_storage_partitions",
  "organisation_schema_status",
  "provisioning_steps",
  "organisation_provisioning_operations",
  "legacy_tenant_mappings",
  "data_plane_routes",
  "organisation_slugs",
  "organisations",
];

// ─── Data-plane tables (in FK-safe deletion order) ───────────────────
const DATA_PLANE_TABLES = [
  "detection_strategies",
  "simulation_instances",
  "claim_processing_outbox",
  "shared_fraud_registry_entries",
  "investigation_notes",
  "investigation_attachments",
  "investigations",
  "ledger_entries",
  "ledger_sequence_allocator",
  "claims",
  "providers",
  "members",
  "medical_schemes",
  "schemes",
  "tenants",
];

async function wipeDatabase(pool, tables, label) {
  const connection = await pool.getConnection();
  try {
    await connection.execute("SET FOREIGN_KEY_CHECKS = 0");
    for (const table of tables) {
      try {
        await connection.execute(`DELETE FROM \`${table}\``);
        console.log(`  ✓ ${label}.${table} — cleared`);
      } catch (err) {
        if (err.code === "ER_NO_SUCH_TABLE" || err.errno === 1146) {
          console.log(`  - ${label}.${table} — does not exist (skipped)`);
        } else {
          console.error(`  ✗ ${label}.${table} — ERROR: ${err.message}`);
        }
      }
    }
    await connection.execute("SET FOREIGN_KEY_CHECKS = 1");
  } finally {
    connection.release();
  }
}

async function reseedRolesAndPermissions(pool) {
  console.log("\n🔑 Re-seeding canonical roles and permissions...");

  // Roles
  await pool.execute(`
    INSERT INTO roles (role_id, role_key, display_name, organisation_scope, definition_version) VALUES
      ('claims_analyst', 'claims_analyst', 'Claims Analyst', 'medical_scheme', 1),
      ('fraud_analyst', 'fraud_analyst', 'Fraud Analyst', 'medical_scheme', 1),
      ('investigator', 'investigator', 'Investigator', 'medical_scheme', 1),
      ('applications_committee_member', 'applications_committee_member', 'Applications Committee Member', 'medical_scheme', 1),
      ('scheme_administrator', 'scheme_administrator', 'Scheme Administrator', 'medical_scheme', 1),
      ('platform_administrator', 'platform_administrator', 'ClaimGuard Platform Administrator', 'platform', 1)
    ON DUPLICATE KEY UPDATE role_id = VALUES(role_id)
  `);

  // Role aliases
  await pool.execute(`
    INSERT INTO role_aliases (alias_key, role_id) VALUES
      ('scheme_user', 'claims_analyst'),
      ('new_applications_officer', 'applications_committee_member')
    ON DUPLICATE KEY UPDATE role_id = VALUES(role_id)
  `);

  // Reserved slugs
  await pool.execute(`
    INSERT INTO organisation_slugs (slug, organisation_id, slug_type, status) VALUES
      ('admin', NULL, 'reserved', 'reserved'),
      ('api', NULL, 'reserved', 'reserved'),
      ('auth', NULL, 'reserved', 'reserved'),
      ('login', NULL, 'reserved', 'reserved'),
      ('status', NULL, 'reserved', 'reserved'),
      ('support', NULL, 'reserved', 'reserved'),
      ('www', NULL, 'reserved', 'reserved')
    ON DUPLICATE KEY UPDATE slug = VALUES(slug)
  `);

  // Permissions
  await pool.execute(`
    INSERT INTO permissions (permission_id, permission_key, description, definition_version) VALUES
      ('claims.view_own', 'claims.view_own', 'View claims in the member organisation.', 1),
      ('claims.ingest_own', 'claims.ingest_own', 'Ingest claims for the member organisation.', 1),
      ('claims.view_flagged', 'claims.view_flagged', 'View flagged claims in the member organisation.', 1),
      ('reports.view_own', 'reports.view_own', 'View private reports for the member organisation.', 1),
      ('investigations.create', 'investigations.create', 'Create a private investigation.', 1),
      ('investigations.manage', 'investigations.manage', 'Manage private investigations.', 1),
      ('investigations.confirm', 'investigations.confirm', 'Confirm an approved private fraud finding.', 1),
      ('investigations.reverse', 'investigations.reverse', 'Reverse an approved private fraud finding.', 1),
      ('registry.search', 'registry.search', 'Search the minimal shared registry.', 1),
      ('registry.review_history', 'registry.review_history', 'Review permitted shared registry history.', 1),
      ('scheme_users.manage', 'scheme_users.manage', 'Manage users in the member organisation.', 1),
      ('scheme_roles.assign', 'scheme_roles.assign', 'Assign approved scheme roles.', 1),
      ('scheme_health.view', 'scheme_health.view', 'View member organisation health.', 1),
      ('organisation.manage', 'organisation.manage', 'Manage control-plane organisations.', 1),
      ('platform_health.view', 'platform_health.view', 'View non-sensitive platform health.', 1),
      ('provisioning.manage', 'provisioning.manage', 'Manage organisation provisioning state.', 1),
      ('simulator.status', 'simulator.status', 'View simulator status.', 1),
      ('simulator.control_own', 'simulator.control_own', 'Control an explicitly enabled organisation simulator.', 1),
      ('simulator.control_platform', 'simulator.control_platform', 'Control explicitly enabled platform demo simulation.', 1)
    ON DUPLICATE KEY UPDATE permission_id = VALUES(permission_id)
  `);

  // Role-permission mappings
  await pool.execute(`
    INSERT INTO role_permissions (role_id, permission_id) VALUES
      ('claims_analyst', 'claims.view_own'), ('claims_analyst', 'claims.ingest_own'), ('claims_analyst', 'reports.view_own'), ('claims_analyst', 'registry.search'), ('claims_analyst', 'simulator.status'),
      ('fraud_analyst', 'claims.view_flagged'), ('fraud_analyst', 'reports.view_own'), ('fraud_analyst', 'investigations.create'), ('fraud_analyst', 'investigations.manage'), ('fraud_analyst', 'registry.search'), ('fraud_analyst', 'registry.review_history'), ('fraud_analyst', 'simulator.status'),
      ('investigator', 'reports.view_own'), ('investigator', 'investigations.create'), ('investigator', 'investigations.manage'), ('investigator', 'investigations.confirm'), ('investigator', 'investigations.reverse'), ('investigator', 'registry.search'), ('investigator', 'registry.review_history'), ('investigator', 'simulator.status'),
      ('applications_committee_member', 'registry.search'), ('applications_committee_member', 'registry.review_history'), ('applications_committee_member', 'simulator.status'),
      ('scheme_administrator', 'scheme_users.manage'), ('scheme_administrator', 'scheme_roles.assign'), ('scheme_administrator', 'scheme_health.view'), ('scheme_administrator', 'simulator.status'), ('scheme_administrator', 'simulator.control_own'),
      ('platform_administrator', 'organisation.manage'), ('platform_administrator', 'platform_health.view'), ('platform_administrator', 'provisioning.manage'), ('platform_administrator', 'simulator.status'), ('platform_administrator', 'simulator.control_platform')
    ON DUPLICATE KEY UPDATE granted_at = granted_at
  `);

  console.log("  ✓ Roles, permissions, aliases, and reserved slugs seeded");
}

async function createPlatformAdmin(pool) {
  console.log("\n👤 Creating platform administrator...");

  const organisationId = crypto.randomUUID();
  const userId = crypto.randomUUID();
  const credentialId = crypto.randomUUID();
  const membershipId = crypto.randomUUID();

  // 1. Create the platform-operations organisation (active)
  await pool.execute(
    `INSERT INTO organisations (organisation_id, display_name, canonical_slug, organisation_type, deployment_class, status, activation_state)
     VALUES (?, 'ClaimGuard Platform Operations', ?, 'platform', 'production', 'active', 'activated')`,
    [organisationId, PLATFORM_ORG_SLUG],
  );
  await pool.execute(
    `INSERT INTO organisation_slugs (slug, organisation_id, slug_type, status)
     VALUES (?, ?, 'canonical', 'active')`,
    [PLATFORM_ORG_SLUG, organisationId],
  );
  console.log(`  ✓ Organisation: ${PLATFORM_ORG_SLUG} (${organisationId})`);

  // 2. Create the sysadmin user
  const passwordHash = await hashPassword(ADMIN_PASSWORD);
  await pool.execute(
    `INSERT INTO users (user_id, display_name, canonical_contact, status)
     VALUES (?, ?, ?, 'active')`,
    [userId, ADMIN_DISPLAY_NAME, `${ADMIN_USERNAME}@${PLATFORM_ORG_SLUG}.internal`],
  );
  console.log(`  ✓ User: ${ADMIN_USERNAME} (${userId})`);

  // 3. Create credential
  await pool.execute(
    `INSERT INTO credential_identities
       (credential_id, user_id, organisation_id, authentication_provider, normalized_username,
        password_hash, password_algorithm, password_parameters, password_version, status)
     VALUES (?, ?, ?, 'local_password', ?, ?, 'argon2id', ?, ?, 'active')`,
    [
      credentialId, userId, organisationId,
      ADMIN_USERNAME.toLowerCase(),
      passwordHash, JSON.stringify(passwordParametersRecord()), ARGON2ID_VERSION,
    ],
  );
  console.log(`  ✓ Credential: local_password (${credentialId})`);

  // 4. Create membership
  await pool.execute(
    `INSERT INTO organisation_memberships
       (membership_id, user_id, organisation_id, status, valid_from)
     VALUES (?, ?, ?, 'active', UTC_TIMESTAMP(3))`,
    [membershipId, userId, organisationId],
  );
  console.log(`  ✓ Membership: ${membershipId}`);

  // 5. Assign platform_administrator role
  await pool.execute(
    `INSERT INTO membership_roles (membership_id, role_id, assigned_by)
     VALUES (?, 'platform_administrator', NULL)`,
    [membershipId],
  );
  console.log(`  ✓ Role: platform_administrator assigned`);

  return { organisationId, userId };
}

async function run() {
  const controlUrl = process.env.CONTROL_PLANE_MYSQL_URL;
  const dataUrl = process.env.MYSQL_URL;

  if (!controlUrl) {
    console.error("❌ CONTROL_PLANE_MYSQL_URL is required.");
    process.exit(1);
  }

  console.log("╔═══════════════════════════════════════════════════╗");
  console.log("║  ClaimGuard Platform Reset & Admin Seed           ║");
  console.log("╚═══════════════════════════════════════════════════╝\n");

  const sslConfig = { rejectUnauthorized: false };
  const controlPool = mysql.createPool({ uri: controlUrl, ssl: sslConfig });

  // 1. Wipe control-plane
  console.log("🗑️  Wiping control-plane database...");
  await wipeDatabase(controlPool, CONTROL_PLANE_TABLES, "control");

  // 2. Wipe data-plane (if configured)
  if (dataUrl) {
    const dataPool = mysql.createPool({ uri: dataUrl, ssl: sslConfig });
    console.log("\n🗑️  Wiping data-plane database...");
    await wipeDatabase(dataPool, DATA_PLANE_TABLES, "data");
    await dataPool.end();
  } else {
    console.log("\n⚠️  MYSQL_URL not set — skipping data-plane wipe.");
  }

  // 3. Re-seed roles/permissions/reserved slugs
  await reseedRolesAndPermissions(controlPool);

  // 4. Create platform admin
  const admin = await createPlatformAdmin(controlPool);

  console.log("\n╔═══════════════════════════════════════════════════╗");
  console.log("║  ✅  PLATFORM READY                               ║");
  console.log("╠═══════════════════════════════════════════════════╣");
  console.log(`║  Organisation: ${PLATFORM_ORG_SLUG.padEnd(35)}║`);
  console.log(`║  Username:     ${ADMIN_USERNAME.padEnd(35)}║`);
  console.log(`║  Password:     ${"********".padEnd(35)}║`);
  console.log("╚═══════════════════════════════════════════════════╝");

  await controlPool.end();
}

run().catch((err) => {
  console.error("❌ FATAL:", err);
  process.exit(1);
});
