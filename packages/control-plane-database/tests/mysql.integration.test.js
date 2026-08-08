import assert from "node:assert/strict";
import test from "node:test";

import {
  applyControlPlaneMigrations,
  createControlPlanePool,
  createControlPlaneRepositories,
  getControlPlaneMigrationStatus,
  loadControlPlaneMigrations,
} from "../src/index.js";

const databaseUrl = process.env.CONTROL_PLANE_TEST_MYSQL_URL || "";

const ids = Object.freeze({
  organisation: "00000000-0000-4000-8000-000000000101",
  platformOrganisation: "00000000-0000-4000-8000-000000000102",
  user: "00000000-0000-4000-8000-000000000201",
  grantor: "00000000-0000-4000-8000-000000000202",
  grantee: "00000000-0000-4000-8000-000000000203",
  thirdUser: "00000000-0000-4000-8000-000000000204",
  unrelatedUser: "00000000-0000-4000-8000-000000000205",
  platformUser: "00000000-0000-4000-8000-000000000206",
  membership: "00000000-0000-4000-8000-000000000301",
  grantorMembership: "00000000-0000-4000-8000-000000000302",
  granteeMembership: "00000000-0000-4000-8000-000000000303",
  thirdMembership: "00000000-0000-4000-8000-000000000304",
  unrelatedMembership: "00000000-0000-4000-8000-000000000305",
  platformMembership: "00000000-0000-4000-8000-000000000306",
  session: "00000000-0000-4000-8000-000000000401",
});

async function seedIdentity(pool) {
  await pool.execute(
    `INSERT INTO organisations
      (organisation_id, display_name, canonical_slug, organisation_type,
       deployment_class, status, activation_state)
     VALUES
      (?, 'Runtime Test Scheme', 'runtime-test-scheme', 'medical_scheme', 'demo', 'active', 'activated'),
      (?, 'Runtime Test Platform', 'runtime-test-platform', 'platform', 'demo', 'active', 'activated')
     ON DUPLICATE KEY UPDATE status = VALUES(status), activation_state = VALUES(activation_state)`,
    [ids.organisation, ids.platformOrganisation],
  );

  const users = [
    [ids.user, "Runtime User", 3],
    [ids.grantor, "Runtime Grantor", 1],
    [ids.grantee, "Runtime Grantee", 1],
    [ids.thirdUser, "Runtime Third User", 1],
    [ids.unrelatedUser, "Runtime Unrelated User", 1],
    [ids.platformUser, "Runtime Platform User", 1],
  ];
  for (const [userId, displayName, authenticationVersion] of users) {
    await pool.execute(
      `INSERT INTO users (user_id, display_name, status, authentication_version)
       VALUES (?, ?, 'active', ?)
       ON DUPLICATE KEY UPDATE status = 'active', authentication_version = VALUES(authentication_version)`,
      [userId, displayName, authenticationVersion],
    );
  }

  const memberships = [
    [ids.membership, ids.user, ids.organisation, 7],
    [ids.grantorMembership, ids.grantor, ids.organisation, 1],
    [ids.granteeMembership, ids.grantee, ids.organisation, 1],
    [ids.thirdMembership, ids.thirdUser, ids.organisation, 1],
    [ids.unrelatedMembership, ids.unrelatedUser, ids.organisation, 1],
    [ids.platformMembership, ids.platformUser, ids.platformOrganisation, 1],
  ];
  for (const [membershipId, userId, organisationId, authorizationVersion] of memberships) {
    await pool.execute(
      `INSERT INTO organisation_memberships
        (membership_id, user_id, organisation_id, status, valid_from, authorization_version)
       VALUES (?, ?, ?, 'active', UTC_TIMESTAMP(3), ?)
       ON DUPLICATE KEY UPDATE status = 'active', authorization_version = VALUES(authorization_version)`,
      [membershipId, userId, organisationId, authorizationVersion],
    );
  }
}

test(
  "real MySQL clean/repeated migration and constraints",
  { skip: !databaseUrl },
  async () => {
    const pool = createControlPlanePool(databaseUrl);
    try {
      const migrations = await loadControlPlaneMigrations();
      assert.ok(migrations.length > 0, "The control-plane migration inventory must not be empty.");
      const expectedMigrationCount = migrations.length;

      const first = await applyControlPlaneMigrations(pool, { applicationVersion: "integration-test" });
      const second = await applyControlPlaneMigrations(pool, { applicationVersion: "integration-test" });
      const status = await getControlPlaneMigrationStatus(pool);

      assert.equal(first.applied.length + first.skipped.length, expectedMigrationCount);
      assert.equal(second.applied.length, 0);
      assert.equal(second.skipped.length, expectedMigrationCount);
      assert.equal(status.applied.length, expectedMigrationCount);
      assert.equal(status.pending.length, 0);
      assert.deepEqual(status.applied.map(({ id }) => id), migrations.map(({ id }) => id));
      assert.equal(status.applied.some(({ id }) => id === "0101_trusted_authorization_runtime"), true);

      const [columns] = await pool.execute(
        `SELECT table_name AS tableName, column_name AS columnName
         FROM information_schema.columns
         WHERE table_schema = DATABASE()
           AND (table_name, column_name) IN (
             ('login_sessions', 'authentication_version'),
             ('login_sessions', 'authorization_version'),
             ('organisation_memberships', 'authorization_version')
           )
         ORDER BY table_name, column_name`,
      );
      assert.deepEqual(
        columns.map((row) => [row.tableName, row.columnName]),
        [
          ["login_sessions", "authentication_version"],
          ["login_sessions", "authorization_version"],
          ["organisation_memberships", "authorization_version"],
        ],
      );

      const [forbidden] = await pool.execute(
        `SELECT table_name FROM information_schema.tables
         WHERE table_schema = DATABASE()
           AND table_name IN (
             'claims', 'members', 'providers', 'investigations', 'ledger_entries',
             'shared_fraud_registry_entries', 'simulation_instances', 'claim_versions',
             'claim_processing_outbox', 'claim_detection_results', 'detection_strategies'
           )
         ORDER BY table_name`,
      );
      assert.deepEqual(forbidden, []);
    } finally {
      await pool.end();
    }
  },
);

test(
  "real MySQL persists distinct session authority versions and canonical role mappings",
  { skip: !databaseUrl },
  async () => {
    const pool = createControlPlanePool(databaseUrl);
    try {
      await applyControlPlaneMigrations(pool, { applicationVersion: "runtime-version-test" });
      await seedIdentity(pool);
      const repositories = createControlPlaneRepositories(pool);

      await pool.execute(
        `INSERT INTO membership_roles (membership_id, role_id)
         VALUES (?, 'investigator'), (?, 'platform_administrator')
         ON DUPLICATE KEY UPDATE revoked_at = NULL`,
        [ids.grantorMembership, ids.platformMembership],
      );

      await repositories.authentication.createSession({
        sessionId: ids.session,
        hashedBearerSecret: "a".repeat(64),
        csrfTokenHash: "b".repeat(64),
        signingKeyId: "runtime-test-key",
        userId: ids.user,
        organisationId: ids.organisation,
        membershipId: ids.membership,
        issuedAt: new Date("2026-08-06T08:00:00Z"),
        lastActivityAt: new Date("2026-08-06T08:00:00Z"),
        idleExpiresAt: new Date("2026-08-06T09:00:00Z"),
        absoluteExpiresAt: new Date("2026-08-06T16:00:00Z"),
        authenticationVersion: 3,
        authorizationVersion: 7,
      });

      const session = await repositories.authentication.getSessionByBearerHash("a".repeat(64));
      assert.equal(session.authenticationVersion, 3);
      assert.equal(session.authorizationVersion, 7);
      assert.equal(session.hashedBearerSecret, "a".repeat(64));
      assert.equal(session.csrfTokenHash, "b".repeat(64));
      assert.notEqual(session.authenticationVersion, session.authorizationVersion);

      await assert.rejects(
        () => repositories.authentication.createSession({
          hashedBearerSecret: "c".repeat(64), csrfTokenHash: "d".repeat(64), signingKeyId: "key",
          userId: ids.user, organisationId: ids.organisation, membershipId: ids.membership,
          issuedAt: new Date(), lastActivityAt: new Date(), idleExpiresAt: new Date(Date.now() + 1000),
          absoluteExpiresAt: new Date(Date.now() + 2000), authorizationVersion: 7,
        }),
        /authenticationVersion must be a positive integer/,
      );
      await assert.rejects(
        () => repositories.authentication.createSession({
          hashedBearerSecret: "e".repeat(64), csrfTokenHash: "f".repeat(64), signingKeyId: "key",
          userId: ids.user, organisationId: ids.organisation, membershipId: ids.membership,
          issuedAt: new Date(), lastActivityAt: new Date(), idleExpiresAt: new Date(Date.now() + 1000),
          absoluteExpiresAt: new Date(Date.now() + 2000), authenticationVersion: 3,
        }),
        /authorizationVersion must be a positive integer/,
      );

      const grantorAuthority = await repositories.access.resolveEffectivePermissions({
        organisationId: ids.organisation,
        userId: ids.grantor,
        membershipId: ids.grantorMembership,
        asOf: new Date(),
      });
      assert.equal(grantorAuthority.permissionKeys.includes("case.review_evidence"), true);
      assert.equal(grantorAuthority.permissionKeys.includes("case.complete_report"), true);

      const roleOnlyAuthority = await repositories.access.resolveEffectivePermissions({
        organisationId: ids.organisation,
        userId: ids.grantee,
        membershipId: ids.granteeMembership,
        asOf: new Date(),
      });
      assert.deepEqual(roleOnlyAuthority.permissionKeys, []);

      const platformAuthority = await repositories.access.resolveEffectivePermissions({
        organisationId: ids.platformOrganisation,
        userId: ids.platformUser,
        membershipId: ids.platformMembership,
        asOf: new Date(),
      });
      assert.equal(platformAuthority.permissionKeys.some((key) => key.startsWith("case.")), false);
      assert.equal(platformAuthority.permissionKeys.some((key) => key.startsWith("access.")), false);
      for (const permission of [
        "platform_releases.view",
        "platform_releases.request",
        "platform_releases.approve",
        "platform_administrators.manage",
        "desktop_devices.manage",
        "desktop_fleet_policy.manage",
      ]) {
        assert.equal(
          platformAuthority.permissionKeys.includes(permission),
          true,
          `platform administrator authority must include ${permission}`,
        );
      }

      const [systemManagedPermissions] = await pool.execute(
        `SELECT permission_key, tenant_assignable, delegable, system_only
         FROM permissions
         WHERE permission_key IN (
           'platform_releases.view', 'platform_releases.request', 'platform_releases.approve',
           'platform_administrators.manage', 'desktop_devices.manage', 'desktop_fleet_policy.manage'
         )
         ORDER BY permission_key`,
      );
      assert.equal(systemManagedPermissions.length, 6);
      assert.ok(systemManagedPermissions.every((row) => (
        Number(row.tenant_assignable) === 0
        && Number(row.delegable) === 0
        && Number(row.system_only) === 1
      )));

      const [legacyPermissions] = await pool.execute(
        `SELECT permission_key, tenant_assignable, delegable
         FROM permissions
         WHERE permission_key IN ('investigations.confirm', 'investigations.reverse')
         ORDER BY permission_key`,
      );
      assert.deepEqual(
        legacyPermissions.map((row) => [row.permission_key, Number(row.tenant_assignable), Number(row.delegable)]),
        [
          ["investigations.confirm", 0, 0],
          ["investigations.reverse", 0, 0],
        ],
      );

      const [platformMappings] = await pool.execute(
        `SELECT p.permission_key
         FROM role_permissions rp
         JOIN permissions p ON p.permission_id = rp.permission_id
         WHERE rp.role_id = 'platform_administrator'
           AND (p.permission_key LIKE 'case.%' OR p.permission_key LIKE 'access.%')`,
      );
      assert.deepEqual(platformMappings, []);
    } finally {
      await pool.end();
    }
  },
);

test(
  "real MySQL access mutation invalidates only the affected membership and rolls back atomically",
  { skip: !databaseUrl },
  async () => {
    const pool = createControlPlanePool(databaseUrl);
    try {
      await applyControlPlaneMigrations(pool, { applicationVersion: "membership-invalidation-test" });
      await seedIdentity(pool);
      const repositories = createControlPlaneRepositories(pool);

      const role = await repositories.runInTransaction((tx) => tx.access.createCustomRole({
        organisationId: ids.organisation,
        roleKey: "runtime_evidence_reviewer",
        displayName: "Runtime Evidence Reviewer",
        actorId: ids.grantor,
        correlationId: "runtime-role-create",
        idempotencyKey: "runtime-role-create",
      }));
      await repositories.runInTransaction((tx) => tx.access.replaceCustomRolePermissions({
        organisationId: ids.organisation,
        roleId: role.roleId,
        permissionKeys: ["case.review_evidence"],
        expectedVersion: 1,
        actorId: ids.grantor,
        correlationId: "runtime-role-permissions",
        idempotencyKey: "test-role-permissions-replace-001",
      }));

      const [beforeRows] = await pool.execute(
        `SELECT membership_id, authorization_version
         FROM organisation_memberships
         WHERE membership_id IN (?, ?)
         ORDER BY membership_id`,
        [ids.granteeMembership, ids.unrelatedMembership],
      );
      const before = new Map(beforeRows.map((row) => [row.membership_id, Number(row.authorization_version)]));

      await assert.rejects(
        () => repositories.runInTransaction(async (tx) => {
          await tx.access.createRoleAssignment({
            organisationId: ids.organisation,
            membershipId: ids.granteeMembership,
            subjectUserId: ids.grantee,
            roleId: role.roleId,
            actorId: ids.grantor,
            correlationId: "runtime-assignment-rollback",
            idempotencyKey: "runtime-assignment-rollback",
          });
          throw new Error("injected transaction failure");
        }),
        /injected transaction failure/,
      );

      const [rolledBackAssignments] = await pool.execute(
        "SELECT assignment_id FROM access_role_assignments WHERE idempotency_key = ?",
        ["runtime-assignment-rollback"],
      );
      const [rolledBackOperations] = await pool.execute(
        "SELECT operation_id FROM access_authorization_operations WHERE idempotency_key = ?",
        ["runtime-assignment-rollback"],
      );
      const [rolledBackAudits] = await pool.execute(
        "SELECT audit_event_id FROM access_audit_events WHERE correlation_id = ?",
        ["runtime-assignment-rollback"],
      );
      assert.deepEqual(rolledBackAssignments, []);
      assert.deepEqual(rolledBackOperations, []);
      assert.deepEqual(rolledBackAudits, []);
      assert.equal(await repositories.access.getAuthorizationVersion(ids.granteeMembership), before.get(ids.granteeMembership));

      const assignmentEffectiveFrom = new Date("2026-01-01T00:00:00.000Z");
      const assignment = await repositories.runInTransaction((tx) => tx.access.createRoleAssignment({
        organisationId: ids.organisation,
        membershipId: ids.granteeMembership,
        subjectUserId: ids.grantee,
        roleId: role.roleId,
        effectiveFrom: assignmentEffectiveFrom,
        actorId: ids.grantor,
        correlationId: "runtime-assignment-create",
        idempotencyKey: "runtime-assignment-create",
      }));
      const afterCreate = await repositories.access.getAuthorizationVersion(ids.granteeMembership);
      assert.equal(afterCreate, before.get(ids.granteeMembership) + 1);
      assert.equal(await repositories.access.getAuthorizationVersion(ids.unrelatedMembership), before.get(ids.unrelatedMembership));

      const freshness = await repositories.access.checkAuthorizationVersionFresh({
        membershipId: ids.granteeMembership,
        sessionVersion: before.get(ids.granteeMembership),
      });
      assert.deepEqual(freshness, {
        fresh: false,
        reason: "version_mismatch",
        currentVersion: afterCreate,
        sessionVersion: before.get(ids.granteeMembership),
      });

      const authority = await repositories.access.resolveEffectivePermissions({
        organisationId: ids.organisation,
        userId: ids.grantee,
        membershipId: ids.granteeMembership,
        asOf: new Date(),
      });
      assert.equal(authority.permissionKeys.includes("case.review_evidence"), true);

      const replay = await repositories.runInTransaction((tx) => tx.access.createRoleAssignment({
        organisationId: ids.organisation,
        membershipId: ids.granteeMembership,
        subjectUserId: ids.grantee,
        roleId: role.roleId,
        effectiveFrom: assignmentEffectiveFrom,
        actorId: ids.grantor,
        correlationId: "runtime-assignment-replay",
        idempotencyKey: "runtime-assignment-create",
      }));
      assert.equal(replay.replayed, true);
      assert.equal(await repositories.access.getAuthorizationVersion(ids.granteeMembership), afterCreate);

      await repositories.runInTransaction((tx) => tx.access.revokeRoleAssignment({
        organisationId: ids.organisation,
        assignmentId: assignment.assignmentId,
        expectedVersion: 1,
        actorId: ids.grantor,
        reason: "runtime revocation",
        correlationId: "runtime-assignment-revoke",
        idempotencyKey: "test-role-assignment-revoke-001",
      }));
      const revokedAuthority = await repositories.access.resolveEffectivePermissions({
        organisationId: ids.organisation,
        userId: ids.grantee,
        membershipId: ids.granteeMembership,
        asOf: new Date(),
      });
      assert.equal(revokedAuthority.permissionKeys.includes("case.review_evidence"), false);
    } finally {
      await pool.end();
    }
  },
);

test(
  "real MySQL delegation mutation invalidates only the grantee and rolls back atomically",
  { skip: !databaseUrl },
  async () => {
    const pool = createControlPlanePool(databaseUrl);
    try {
      await applyControlPlaneMigrations(pool, { applicationVersion: "delegation-rollback-test" });
      await seedIdentity(pool);
      const repositories = createControlPlaneRepositories(pool);

      const [beforeRows] = await pool.execute(
        `SELECT membership_id, authorization_version
         FROM organisation_memberships
         WHERE membership_id IN (?, ?)
         ORDER BY membership_id`,
        [ids.granteeMembership, ids.unrelatedMembership],
      );
      const before = new Map(beforeRows.map((row) => [row.membership_id, Number(row.authorization_version)]));

      const effectiveFrom = new Date("2026-08-07T11:00:00.000Z");
      const asOf = new Date("2026-08-07T12:00:00.000Z");
      const expiresAt = new Date("2026-08-08T12:00:00.000Z");
      assert.equal(effectiveFrom < asOf, true);
      assert.equal(asOf < expiresAt, true);

      await assert.rejects(
        () => repositories.runInTransaction(async (tx) => {
          await tx.access.createDelegation({
            organisationId: ids.organisation,
            grantorUserId: ids.grantor,
            granteeUserId: ids.grantee,
            permissionKeys: ["case.review_evidence"],
            effectiveFrom,
            expiresAt,
            reason: "Runtime rollback coverage",
            actorId: ids.grantor,
            correlationId: "runtime-delegation-rollback",
            idempotencyKey: "runtime-delegation-rollback",
            grantorEffectivePermissions: new Set(["case.review_evidence"]),
          });
          throw new Error("injected delegation transaction failure");
        }),
        /injected delegation transaction failure/,
      );

      const [rolledBackDelegations] = await pool.execute(
        "SELECT delegation_id FROM access_delegations WHERE idempotency_key = ?",
        ["runtime-delegation-rollback"],
      );
      const [rolledBackPermissions] = await pool.execute(
        `SELECT dp.delegation_id
           FROM access_delegation_permissions dp
           JOIN access_delegations d ON d.delegation_id = dp.delegation_id
          WHERE d.idempotency_key = ?`,
        ["runtime-delegation-rollback"],
      );
      const [rolledBackOperations] = await pool.execute(
        "SELECT operation_id FROM access_authorization_operations WHERE idempotency_key = ?",
        ["runtime-delegation-rollback"],
      );
      const [rolledBackAudits] = await pool.execute(
        "SELECT audit_event_id FROM access_audit_events WHERE correlation_id = ?",
        ["runtime-delegation-rollback"],
      );
      assert.deepEqual(rolledBackDelegations, []);
      assert.deepEqual(rolledBackPermissions, []);
      assert.deepEqual(rolledBackOperations, []);
      assert.deepEqual(rolledBackAudits, []);
      assert.equal(await repositories.access.getAuthorizationVersion(ids.granteeMembership), before.get(ids.granteeMembership));
      assert.equal(await repositories.access.getAuthorizationVersion(ids.unrelatedMembership), before.get(ids.unrelatedMembership));

      const delegation = await repositories.runInTransaction((tx) => tx.access.createDelegation({
        organisationId: ids.organisation,
        grantorUserId: ids.grantor,
        granteeUserId: ids.grantee,
        permissionKeys: ["case.review_evidence"],
        effectiveFrom,
        expiresAt,
        reason: "Runtime delegation create",
        actorId: ids.grantor,
        correlationId: "runtime-delegation-create",
        idempotencyKey: "runtime-delegation-create",
        grantorEffectivePermissions: new Set(["case.review_evidence"]),
      }));
      const afterCreate = await repositories.access.getAuthorizationVersion(ids.granteeMembership);
      assert.equal(afterCreate, before.get(ids.granteeMembership) + 1);
      assert.equal(await repositories.access.getAuthorizationVersion(ids.unrelatedMembership), before.get(ids.unrelatedMembership));

      const authority = await repositories.access.resolveEffectivePermissions({
        organisationId: ids.organisation,
        userId: ids.grantee,
        membershipId: ids.granteeMembership,
        asOf,
      });
      assert.equal(authority.permissionKeys.includes("case.review_evidence"), true);

      await repositories.runInTransaction((tx) => tx.access.revokeDelegation({
        organisationId: ids.organisation,
        delegationId: delegation.delegationId,
        expectedVersion: delegation.version,
        reason: "runtime delegation revoke",
        actorId: ids.grantor,
        correlationId: "runtime-delegation-revoke",
        idempotencyKey: "runtime-delegation-revoke",
      }));
      const revokedAuthority = await repositories.access.resolveEffectivePermissions({
        organisationId: ids.organisation,
        userId: ids.grantee,
        membershipId: ids.granteeMembership,
        asOf,
      });
      assert.equal(revokedAuthority.permissionKeys.includes("case.review_evidence"), false);
    } finally {
      await pool.end();
    }
  },
);
