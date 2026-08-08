import assert from "node:assert/strict";
import test from "node:test";

import { createAccessRepository } from "../src/access-repository.js";
import {
  ACCESS_ERROR_CODE,
} from "../src/access-errors.js";

// --- Fake executor ---

function createFakeExecutor({ failAfter = null, failOnPattern = null } = {}) {
  const tables = {
    access_role_definitions: [],
    access_role_permissions: [],
    access_role_assignments: [],
    access_delegations: [],
    access_delegation_permissions: [],
    access_elevated_requests: [],
    access_authorization_operations: [],
    access_audit_events: [],
    organisation_memberships: [],
    membership_roles: [],
    roles: [],
    role_permissions: [],
    permissions: [],
  };
  let queryCount = 0;

  const executor = {
    tables,
    queries: [],
    async execute(sql, params = []) {
      queryCount += 1;
      const normalized = String(sql).replace(/\s+/g, " ").trim();
      executor.queries.push({ sql: normalized, params: [...params] });

      if (failOnPattern && normalized.includes(failOnPattern)) {
        const error = new Error(`Injected failure after ${failOnPattern}`);
        error.code = "ER_INJECTED";
        throw error;
      }

      if (failAfter && queryCount > failAfter) {
        const error = new Error("Injected failure after N queries");
        error.code = "ER_INJECTED";
        throw error;
      }

      // Route INSERT
      if (normalized.startsWith("INSERT INTO access_role_definitions")) {
        // Check for duplicate org+key
        const [, orgId, roleKey] = normalized.match(/VALUES/) ? [null, params[1], params[2]] : [];
        const dup = tables.access_role_definitions.find(
          (r) => r.organisation_id === orgId && r.role_key === roleKey,
        );
        if (dup) {
          const error = new Error("Duplicate entry");
          error.code = "ER_DUP_ENTRY";
          error.errno = 1062;
          throw error;
        }
        tables.access_role_definitions.push({
          role_id: params[0], organisation_id: params[1], role_key: params[2],
          display_name: params[3], description: params[4], role_class: "custom",
          status: "active", version: 1, created_by: params[5], last_changed_by: params[6],
        });
        return [{ affectedRows: 1 }, []];
      }
      if (normalized.startsWith("INSERT INTO access_authorization_operations")) {
        const dupOp = tables.access_authorization_operations.find(
          (op) => op.organisation_id === params[1] && op.operation_type === params[2] && op.idempotency_key === params[3],
        );
        if (dupOp) {
          const error = new Error("Duplicate entry");
          error.code = "ER_DUP_ENTRY";
          error.errno = 1062;
          throw error;
        }
        tables.access_authorization_operations.push({
          operation_id: params[0], organisation_id: params[1], operation_type: params[2],
          idempotency_key: params[3], intent_hash: params[4], result_json: params[5],
        });
        return [{ affectedRows: 1 }, []];
      }
      if (normalized.startsWith("INSERT INTO access_audit_events")) {
        tables.access_audit_events.push({
          audit_event_id: params[0], organisation_id: params[1], actor_type: params[2],
          actor_id: params[3], action: params[5], target_type: params[6], target_id: params[7],
          outcome: params[13],
        });
        return [{ affectedRows: 1 }, []];
      }
      if (normalized.startsWith("INSERT INTO access_role_permissions")) {
        tables.access_role_permissions.push({
          role_id: params[0], permission_key: params[1], granted_by: params[2],
        });
        return [{ affectedRows: 1 }, []];
      }
      if (normalized.startsWith("INSERT INTO access_role_assignments")) {
        tables.access_role_assignments.push({
          assignment_id: params[0], organisation_id: params[1], membership_id: params[2],
          subject_user_id: params[3], role_id: params[4], effective_from: params[5],
          expires_at: params[6], status: "active", version: 1, created_by: params[7],
          idempotency_key: params[8], intent_hash: params[9],
        });
        return [{ affectedRows: 1 }, []];
      }
      if (normalized.startsWith("INSERT INTO access_delegations")) {
        tables.access_delegations.push({
          delegation_id: params[0], organisation_id: params[1], grantor_user_id: params[2],
          grantee_user_id: params[3], permissions_json: params[4], effective_from: params[5],
          expires_at: params[6], reason: params[7], status: "active", version: 1,
          created_by: params[8], idempotency_key: params[9], intent_hash: params[10],
        });
        return [{ affectedRows: 1 }, []];
      }
      if (normalized.startsWith("INSERT INTO access_delegation_permissions")) {
        tables.access_delegation_permissions.push({
          delegation_id: params[0], permission_key: params[1],
        });
        return [{ affectedRows: 1 }, []];
      }
      if (normalized.startsWith("INSERT INTO access_elevated_requests")) {
        const dupReq = tables.access_elevated_requests.find(
          (r) => r.organisation_id === params[1] && r.target_type === params[2]
                 && r.target_id === params[3] && r.intent_hash === params[8],
        );
        if (dupReq) {
          const error = new Error("Duplicate entry");
          error.code = "ER_DUP_ENTRY";
          error.errno = 1062;
          throw error;
        }
        tables.access_elevated_requests.push({
          request_id: params[0], organisation_id: params[1], target_type: params[2],
          target_id: params[3], requested_permissions: params[4], requested_by: params[5],
          target_user_id: params[6], reason: params[7], decision: "pending", version: 1,
          intent_hash: params[8],
        });
        return [{ affectedRows: 1 }, []];
      }

      // Route SELECT
      if (normalized.includes("FROM access_role_definitions WHERE role_id")) {
        const roleId = params[0];
        const row = tables.access_role_definitions.find((r) => r.role_id === roleId);
        return [row ? [row] : [], []];
      }
      if (normalized.includes("FROM access_role_assignments WHERE assignment_id")) {
        const id = params[0];
        const row = tables.access_role_assignments.find((r) => r.assignment_id === id);
        return [row ? [row] : [], []];
      }
      if (normalized.includes("FROM access_delegations WHERE delegation_id")) {
        const id = params[0];
        const row = tables.access_delegations.find((r) => r.delegation_id === id);
        return [row ? [row] : [], []];
      }
      if (normalized.includes("FROM access_elevated_requests WHERE request_id")) {
        const id = params[0];
        const row = tables.access_elevated_requests.find((r) => r.request_id === id);
        return [row ? [row] : [], []];
      }
      if (normalized.includes("FROM access_elevated_requests") && normalized.includes("intent_hash")) {
        const [orgId, targetType, targetId, hash] = params;
        const row = tables.access_elevated_requests.find(
          (r) => r.organisation_id === orgId && r.target_type === targetType
                 && r.target_id === targetId && r.intent_hash === hash,
        );
        return [row ? [row] : [], []];
      }
      if (normalized.includes("FROM access_authorization_operations") && normalized.includes("operation_type")) {
        const [orgId, opType, key] = params;
        const row = tables.access_authorization_operations.find(
          (op) => op.organisation_id === orgId && op.operation_type === opType && op.idempotency_key === key,
        );
        return [row ? [row] : [], []];
      }
      if (normalized.includes("FROM organisation_memberships WHERE membership_id")) {
        const id = params[0];
        const row = tables.organisation_memberships.find((m) => m.membership_id === id);
        return [row ? [row] : [], []];
      }
      if (normalized.includes("FROM organisation_memberships") && normalized.includes("user_id = ? AND organisation_id = ?")) {
        const [userId, orgId] = params;
        const row = tables.organisation_memberships.find((m) => m.user_id === userId && m.organisation_id === orgId && m.status === "active");
        return [row ? [row] : [], []];
      }
      if (normalized.includes("DISTINCT membership_id FROM access_role_assignments")) {
        const roleId = params[0];
        const rows = tables.access_role_assignments
          .filter((a) => a.role_id === roleId && a.status === "active")
          .map((a) => ({ membership_id: a.membership_id }));
        return [rows, []];
      }
      if (normalized.includes("FROM access_audit_events WHERE organisation_id")) {
        const orgId = params[0];
        const rows = tables.access_audit_events.filter((e) => e.organisation_id === orgId);
        return [rows, []];
      }
      if (normalized.includes("authorization_version FROM organisation_memberships")) {
        const id = params[0];
        const row = tables.organisation_memberships.find((m) => m.membership_id === id);
        return [row ? [{ authorization_version: row.authorization_version }] : [], []];
      }

      // System-role resolution queries
      if (normalized.includes("FROM membership_roles mr") && normalized.includes("JOIN roles r")) {
        const membershipId = params[0];
        const rows = [];
        const memberRoles = tables.membership_roles.filter((mr) => mr.membership_id === membershipId && !mr.revoked_at);
        for (const mr of memberRoles) {
          const rolePerms = tables.role_permissions.filter((rp) => rp.role_id === mr.role_id);
          for (const rp of rolePerms) {
            const role = tables.roles.find((r) => r.role_id === mr.role_id);
            const perm = tables.permissions.find((p) => p.permission_id === rp.permission_id);
            if (role && perm) {
              rows.push({ permission_key: perm.permission_key, role_key: role.role_key });
            }
          }
        }
        return [rows, []];
      }

      // Custom-role assignment resolution
      if (normalized.includes("FROM access_role_assignments ara") && normalized.includes("JOIN access_role_definitions")) {
        const [orgId, userId] = params;
        const rows = [];
        const assignments = tables.access_role_assignments.filter(
          (a) => a.organisation_id === orgId && a.subject_user_id === userId && a.status === "active",
        );
        for (const assignment of assignments) {
          const role = tables.access_role_definitions.find((r) => r.role_id === assignment.role_id && r.status === "active");
          if (!role) continue;
          const perms = tables.access_role_permissions.filter((rp) => rp.role_id === assignment.role_id);
          for (const perm of perms) {
            rows.push({
              permission_key: perm.permission_key, role_key: role.role_key, assignment_id: assignment.assignment_id,
            });
          }
        }
        return [rows, []];
      }

      // Delegation resolution
      if (normalized.includes("FROM access_delegations d") && normalized.includes("JOIN access_delegation_permissions")) {
        const [orgId, userId] = params;
        const rows = [];
        const delegations = tables.access_delegations.filter(
          (d) => d.organisation_id === orgId && d.grantee_user_id === userId && d.status === "active",
        );
        for (const delegation of delegations) {
          const perms = tables.access_delegation_permissions.filter((dp) => dp.delegation_id === delegation.delegation_id);
          for (const perm of perms) {
            rows.push({
              delegation_id: delegation.delegation_id, grantor_user_id: delegation.grantor_user_id,
              permission_key: perm.permission_key,
            });
          }
        }
        return [rows, []];
      }

      // UPDATE handlers
      if (normalized.includes("UPDATE organisation_memberships") && normalized.includes("authorization_version = authorization_version + 1")) {
        if (normalized.includes("membership_id = ?")) {
          const id = params[0];
          const member = tables.organisation_memberships.find((m) => m.membership_id === id);
          if (member) {
            member.authorization_version = (member.authorization_version || 1) + 1;
            return [{ affectedRows: 1 }, []];
          }
          return [{ affectedRows: 0 }, []];
        }
        // For user+org based updates
        const [orgId, userId] = params;
        let affected = 0;
        for (const m of tables.organisation_memberships) {
          if (m.organisation_id === orgId && m.user_id === userId && m.status === "active") {
            m.authorization_version = (m.authorization_version || 1) + 1;
            affected += 1;
          }
        }
        return [{ affectedRows: affected }, []];
      }
      if (normalized.includes("UPDATE access_role_definitions")) {
        const roleId = params[params.length - 2];
        const expectedVersion = params[params.length - 1];
        const role = tables.access_role_definitions.find((r) => r.role_id === roleId && r.version === expectedVersion);
        if (role) {
          // Apply updates based on the SET clause
          if (normalized.includes("status = 'disabled'")) role.status = "disabled";
          role.version = expectedVersion + 1;
          if (normalized.includes("display_name")) role.display_name = params[0];
          return [{ affectedRows: 1 }, []];
        }
        return [{ affectedRows: 0 }, []];
      }
      if (normalized.includes("UPDATE access_role_assignments") && normalized.includes("status = 'revoked'")) {
        const id = params[params.length - 1];
        const assignment = tables.access_role_assignments.find((a) => a.assignment_id === id && a.status === "active");
        if (assignment) {
          assignment.status = "revoked";
          assignment.version += 1;
          return [{ affectedRows: 1 }, []];
        }
        return [{ affectedRows: 0 }, []];
      }
      if (normalized.includes("UPDATE access_delegations") && normalized.includes("status = 'revoked'")) {
        const id = params[params.length - 1];
        const delegation = tables.access_delegations.find((d) => d.delegation_id === id && d.status === "active");
        if (delegation) {
          delegation.status = "revoked";
          delegation.version += 1;
          return [{ affectedRows: 1 }, []];
        }
        return [{ affectedRows: 0 }, []];
      }
      if (normalized.includes("UPDATE access_elevated_requests") && normalized.includes("decision = 'approved'")) {
        const id = params[params.length - 1];
        const req = tables.access_elevated_requests.find((r) => r.request_id === id && r.decision === "pending");
        if (req) {
          req.decision = "approved";
          req.version += 1;
          return [{ affectedRows: 1 }, []];
        }
        return [{ affectedRows: 0 }, []];
      }
      if (normalized.includes("UPDATE access_elevated_requests") && normalized.includes("decision = 'rejected'")) {
        const id = params[params.length - 1];
        const req = tables.access_elevated_requests.find((r) => r.request_id === id && r.decision === "pending");
        if (req) {
          req.decision = "rejected";
          req.version += 1;
          return [{ affectedRows: 1 }, []];
        }
        return [{ affectedRows: 0 }, []];
      }

      // DELETE
      if (normalized.includes("DELETE FROM access_role_permissions WHERE role_id")) {
        const roleId = params[0];
        tables.access_role_permissions = tables.access_role_permissions.filter((rp) => rp.role_id !== roleId);
        return [{ affectedRows: 1 }, []];
      }

      return [[], []];
    },
  };

  return executor;
}

function seedMembership(executor, { membershipId, userId, organisationId }) {
  executor.tables.organisation_memberships.push({
    membership_id: membershipId,
    user_id: userId,
    organisation_id: organisationId,
    status: "active",
    authorization_version: 1,
  });
}

function seedSystemRole(executor, { roleId, roleKey, permissionKeys }) {
  executor.tables.roles.push({ role_id: roleId, role_key: roleKey });
  for (const pk of permissionKeys) {
    executor.tables.permissions.push({ permission_id: pk, permission_key: pk });
    executor.tables.role_permissions.push({ role_id: roleId, permission_id: pk });
  }
}

const ORG_ID = "org-001";
const USER_A = "user-aaa";
const USER_B = "user-bbb";
const USER_C = "user-ccc";
const MEMBERSHIP_A = "mem-aaa";
const MEMBERSHIP_B = "mem-bbb";
const ACTOR = "actor-001";
const CORRELATION = "corr-001";

// === Custom Role Tests ===

test("create custom role succeeds", async () => {
  const db = createFakeExecutor();
  seedMembership(db, { membershipId: MEMBERSHIP_A, userId: USER_A, organisationId: ORG_ID });
  const repo = createAccessRepository(db);
  const result = await repo.createCustomRole({
    organisationId: ORG_ID, roleKey: "analyst_v2", displayName: "Analyst V2",
    actorId: ACTOR, correlationId: CORRELATION, idempotencyKey: "create-analyst-v2", executor: db,
  });
  assert.ok(result.roleId);
  assert.equal(result.replayed, false);
  assert.equal(result.roleKey, "analyst_v2");
  assert.ok(db.tables.access_audit_events.length >= 1);
});

test("create custom role idempotency returns existing result", async () => {
  const db = createFakeExecutor();
  const repo = createAccessRepository(db);
  const first = await repo.createCustomRole({
    organisationId: ORG_ID, roleKey: "dedup_role", displayName: "Dedup",
    actorId: ACTOR, correlationId: CORRELATION, idempotencyKey: "dedup-key", executor: db,
  });
  const second = await repo.createCustomRole({
    organisationId: ORG_ID, roleKey: "dedup_role", displayName: "Dedup",
    actorId: ACTOR, correlationId: CORRELATION, idempotencyKey: "dedup-key", executor: db,
  });
  assert.equal(second.replayed, true);
  assert.equal(second.operationId, first.operationId);
});

test("tenant role-key conflict throws ACCESS_ROLE_KEY_CONFLICT", async () => {
  const db = createFakeExecutor();
  const repo = createAccessRepository(db);
  await repo.createCustomRole({
    organisationId: ORG_ID, roleKey: "unique_key", displayName: "Role 1",
    actorId: ACTOR, correlationId: CORRELATION, idempotencyKey: "key-1", executor: db,
  });
  await assert.rejects(
    () => repo.createCustomRole({
      organisationId: ORG_ID, roleKey: "unique_key", displayName: "Role 2",
      actorId: ACTOR, correlationId: CORRELATION, idempotencyKey: "key-2", executor: db,
    }),
    (error) => error.code === ACCESS_ERROR_CODE.ROLE_KEY_CONFLICT,
  );
});

test("same role key in different tenant is allowed", async () => {
  const db = createFakeExecutor();
  const repo = createAccessRepository(db);
  const r1 = await repo.createCustomRole({
    organisationId: "org-1", roleKey: "shared_key", displayName: "Role 1",
    actorId: ACTOR, correlationId: CORRELATION, idempotencyKey: "key-1", executor: db,
  });
  const r2 = await repo.createCustomRole({
    organisationId: "org-2", roleKey: "shared_key", displayName: "Role 2",
    actorId: ACTOR, correlationId: CORRELATION, idempotencyKey: "key-2", executor: db,
  });
  assert.ok(r1.roleId !== r2.roleId);
});

test("system role immutable when updating metadata", async () => {
  const db = createFakeExecutor();
  db.tables.access_role_definitions.push({
    role_id: "sys-role", organisation_id: ORG_ID, role_key: "system_role",
    role_class: "system", status: "active", version: 1,
  });
  const repo = createAccessRepository(db);
  await assert.rejects(
    () => repo.updateCustomRoleMetadata({
      organisationId: ORG_ID, roleId: "sys-role", displayName: "New Name",
      expectedVersion: 1, actorId: ACTOR, correlationId: CORRELATION, executor: db,
    }),
    (error) => error.code === ACCESS_ERROR_CODE.SYSTEM_ROLE_IMMUTABLE,
  );
});

test("stale role version rejected", async () => {
  const db = createFakeExecutor();
  const repo = createAccessRepository(db);
  const created = await repo.createCustomRole({
    organisationId: ORG_ID, roleKey: "v_role", displayName: "V Role",
    actorId: ACTOR, correlationId: CORRELATION, idempotencyKey: "v-key", executor: db,
  });
  // Update version to 2
  await repo.updateCustomRoleMetadata({
    organisationId: ORG_ID, roleId: created.roleId, displayName: "V2",
    expectedVersion: 1, actorId: ACTOR, correlationId: CORRELATION, executor: db,
  });
  // Try again with stale version
  await assert.rejects(
    () => repo.updateCustomRoleMetadata({
      organisationId: ORG_ID, roleId: created.roleId, displayName: "V3",
      expectedVersion: 1, actorId: ACTOR, correlationId: CORRELATION, executor: db,
    }),
    (error) => error.code === ACCESS_ERROR_CODE.VERSION_CONFLICT,
  );
});

test("unknown permission rejected when replacing role permissions", async () => {
  const db = createFakeExecutor();
  const repo = createAccessRepository(db);
  const created = await repo.createCustomRole({
    organisationId: ORG_ID, roleKey: "perm_role", displayName: "Perm Role",
    actorId: ACTOR, correlationId: CORRELATION, idempotencyKey: "perm-key", executor: db,
  });
  await assert.rejects(
    () => repo.replaceCustomRolePermissions({
      organisationId: ORG_ID, roleId: created.roleId,
      permissionKeys: ["claims.view_own", "nonexistent.permission"],
      expectedVersion: 1, actorId: ACTOR, correlationId: CORRELATION, executor: db,
    }),
    (error) => error.code === ACCESS_ERROR_CODE.PERMISSION_UNKNOWN,
  );
});

test("non-tenant-assignable permission rejected", async () => {
  const db = createFakeExecutor();
  const repo = createAccessRepository(db);
  const created = await repo.createCustomRole({
    organisationId: ORG_ID, roleKey: "platform_role", displayName: "Platform",
    actorId: ACTOR, correlationId: CORRELATION, idempotencyKey: "plat-key", executor: db,
  });
  await assert.rejects(
    () => repo.replaceCustomRolePermissions({
      organisationId: ORG_ID, roleId: created.roleId,
      permissionKeys: ["organisation.manage"], // system-only
      expectedVersion: 1, actorId: ACTOR, correlationId: CORRELATION, executor: db,
    }),
    (error) => error.code === ACCESS_ERROR_CODE.PERMISSION_NOT_ASSIGNABLE,
  );
});

// === Assignment Tests ===

test("assignment linkage mismatch rejected", async () => {
  const db = createFakeExecutor();
  seedMembership(db, { membershipId: MEMBERSHIP_A, userId: USER_A, organisationId: ORG_ID });
  const repo = createAccessRepository(db);
  const role = await repo.createCustomRole({
    organisationId: ORG_ID, roleKey: "test_role", displayName: "Test",
    actorId: ACTOR, correlationId: CORRELATION, idempotencyKey: "role-1", executor: db,
  });
  await assert.rejects(
    () => repo.createRoleAssignment({
      organisationId: ORG_ID, membershipId: MEMBERSHIP_A,
      subjectUserId: USER_B, // Mismatch: membership belongs to USER_A
      roleId: role.roleId, actorId: ACTOR, correlationId: CORRELATION,
      idempotencyKey: "assign-1", executor: db,
    }),
    (error) => error.code === ACCESS_ERROR_CODE.ASSIGNMENT_LINKAGE_MISMATCH,
  );
});

test("assignment to disabled role rejected", async () => {
  const db = createFakeExecutor();
  seedMembership(db, { membershipId: MEMBERSHIP_A, userId: USER_A, organisationId: ORG_ID });
  const repo = createAccessRepository(db);
  const role = await repo.createCustomRole({
    organisationId: ORG_ID, roleKey: "disabled_role", displayName: "Disabled",
    actorId: ACTOR, correlationId: CORRELATION, idempotencyKey: "d-role", executor: db,
  });
  await repo.disableCustomRole({
    organisationId: ORG_ID, roleId: role.roleId, expectedVersion: 1,
    actorId: ACTOR, correlationId: CORRELATION, executor: db,
  });
  await assert.rejects(
    () => repo.createRoleAssignment({
      organisationId: ORG_ID, membershipId: MEMBERSHIP_A,
      subjectUserId: USER_A, roleId: role.roleId,
      actorId: ACTOR, correlationId: CORRELATION, idempotencyKey: "assign-disabled", executor: db,
    }),
    (error) => error.code === ACCESS_ERROR_CODE.ROLE_DISABLED,
  );
});

test("revoke assignment succeeds and advances authorization version", async () => {
  const db = createFakeExecutor();
  seedMembership(db, { membershipId: MEMBERSHIP_A, userId: USER_A, organisationId: ORG_ID });
  const repo = createAccessRepository(db);
  const role = await repo.createCustomRole({
    organisationId: ORG_ID, roleKey: "revoke_role", displayName: "Revoke",
    actorId: ACTOR, correlationId: CORRELATION, idempotencyKey: "rev-role", executor: db,
  });
  const assignment = await repo.createRoleAssignment({
    organisationId: ORG_ID, membershipId: MEMBERSHIP_A, subjectUserId: USER_A,
    roleId: role.roleId, actorId: ACTOR, correlationId: CORRELATION,
    idempotencyKey: "rev-assign", executor: db,
  });
  const versionBefore = db.tables.organisation_memberships[0].authorization_version;
  const revoked = await repo.revokeRoleAssignment({
    organisationId: ORG_ID, assignmentId: assignment.assignmentId,
    reason: "test", actorId: ACTOR, correlationId: CORRELATION, executor: db,
  });
  assert.ok(revoked.operationId);
  const versionAfter = db.tables.organisation_memberships[0].authorization_version;
  assert.ok(versionAfter > versionBefore, "Authorization version must advance on revocation");
});

test("revoke inactive assignment throws ASSIGNMENT_INACTIVE", async () => {
  const db = createFakeExecutor();
  seedMembership(db, { membershipId: MEMBERSHIP_A, userId: USER_A, organisationId: ORG_ID });
  const repo = createAccessRepository(db);
  const role = await repo.createCustomRole({
    organisationId: ORG_ID, roleKey: "inact_role", displayName: "Inact",
    actorId: ACTOR, correlationId: CORRELATION, idempotencyKey: "inact-role", executor: db,
  });
  const assignment = await repo.createRoleAssignment({
    organisationId: ORG_ID, membershipId: MEMBERSHIP_A, subjectUserId: USER_A,
    roleId: role.roleId, actorId: ACTOR, correlationId: CORRELATION,
    idempotencyKey: "inact-assign", executor: db,
  });
  await repo.revokeRoleAssignment({
    organisationId: ORG_ID, assignmentId: assignment.assignmentId,
    actorId: ACTOR, correlationId: CORRELATION, executor: db,
  });
  await assert.rejects(
    () => repo.revokeRoleAssignment({
      organisationId: ORG_ID, assignmentId: assignment.assignmentId,
      actorId: ACTOR, correlationId: CORRELATION, executor: db,
    }),
    (error) => error.code === ACCESS_ERROR_CODE.ASSIGNMENT_INACTIVE,
  );
});

// === Delegation Tests ===

test("self-delegation throws DELEGATION_SELF_FORBIDDEN", async () => {
  const db = createFakeExecutor();
  const repo = createAccessRepository(db);
  const future = new Date(Date.now() + 3600_000);
  await assert.rejects(
    () => repo.createDelegation({
      organisationId: ORG_ID, grantorUserId: USER_A, granteeUserId: USER_A,
      permissionKeys: ["claims.view_own"], expiresAt: future, reason: "test",
      actorId: ACTOR, correlationId: CORRELATION, idempotencyKey: "self-deleg", executor: db,
    }),
    (error) => error.code === ACCESS_ERROR_CODE.DELEGATION_SELF_FORBIDDEN,
  );
});

test("unknown permission in delegation throws PERMISSION_UNKNOWN", async () => {
  const db = createFakeExecutor();
  const repo = createAccessRepository(db);
  const future = new Date(Date.now() + 3600_000);
  await assert.rejects(
    () => repo.createDelegation({
      organisationId: ORG_ID, grantorUserId: USER_A, granteeUserId: USER_B,
      permissionKeys: ["nonexistent.perm"], expiresAt: future, reason: "test",
      actorId: ACTOR, correlationId: CORRELATION, idempotencyKey: "unk-deleg", executor: db,
    }),
    (error) => error.code === ACCESS_ERROR_CODE.PERMISSION_UNKNOWN,
  );
});

test("non-delegable permission throws PERMISSION_NOT_DELEGABLE", async () => {
  const db = createFakeExecutor();
  const repo = createAccessRepository(db);
  const future = new Date(Date.now() + 3600_000);
  await assert.rejects(
    () => repo.createDelegation({
      organisationId: ORG_ID, grantorUserId: USER_A, granteeUserId: USER_B,
      permissionKeys: ["investigations.confirm"], // elevated and non-delegable
      expiresAt: future, reason: "test",
      actorId: ACTOR, correlationId: CORRELATION, idempotencyKey: "nd-deleg", executor: db,
    }),
    (error) => error.code === ACCESS_ERROR_CODE.PERMISSION_NOT_DELEGABLE,
  );
});

test("excessive expiry throws DELEGATION_EXPIRY_INVALID", async () => {
  const db = createFakeExecutor();
  const repo = createAccessRepository(db);
  const excessive = new Date(Date.now() + 800 * 3600_000); // 800 hours > 720
  await assert.rejects(
    () => repo.createDelegation({
      organisationId: ORG_ID, grantorUserId: USER_A, granteeUserId: USER_B,
      permissionKeys: ["claims.view_own"], expiresAt: excessive, reason: "test",
      actorId: ACTOR, correlationId: CORRELATION, idempotencyKey: "exc-deleg", executor: db,
    }),
    (error) => error.code === ACCESS_ERROR_CODE.DELEGATION_EXPIRY_INVALID,
  );
});

test("delegation with missing grantor authority throws DELEGATION_AUTHORITY_MISSING", async () => {
  const db = createFakeExecutor();
  const repo = createAccessRepository(db);
  const future = new Date(Date.now() + 3600_000);
  await assert.rejects(
    () => repo.createDelegation({
      organisationId: ORG_ID, grantorUserId: USER_A, granteeUserId: USER_B,
      permissionKeys: ["claims.view_own", "reports.view_own"],
      expiresAt: future, reason: "test",
      actorId: ACTOR, correlationId: CORRELATION, idempotencyKey: "auth-deleg",
      grantorEffectivePermissions: new Set(["claims.view_own"]), // missing reports.view_own
      executor: db,
    }),
    (error) => error.code === ACCESS_ERROR_CODE.DELEGATION_AUTHORITY_MISSING,
  );
});

test("revoke delegation succeeds", async () => {
  const db = createFakeExecutor();
  seedMembership(db, { membershipId: MEMBERSHIP_B, userId: USER_B, organisationId: ORG_ID });
  const repo = createAccessRepository(db);
  const future = new Date(Date.now() + 3600_000);
  const delegation = await repo.createDelegation({
    organisationId: ORG_ID, grantorUserId: USER_A, granteeUserId: USER_B,
    permissionKeys: ["claims.view_own"], expiresAt: future, reason: "cover",
    actorId: ACTOR, correlationId: CORRELATION, idempotencyKey: "rev-deleg", executor: db,
  });
  const revoked = await repo.revokeDelegation({
    organisationId: ORG_ID, delegationId: delegation.delegationId,
    reason: "no longer needed", actorId: ACTOR, correlationId: CORRELATION, executor: db,
  });
  assert.ok(revoked.operationId);
});

// === Elevated Approval Tests ===

test("requester self-approval throws ELEVATED_REVIEWER_NOT_INDEPENDENT", async () => {
  const db = createFakeExecutor();
  const repo = createAccessRepository(db);
  const request = await repo.createElevatedRequest({
    organisationId: ORG_ID, targetType: "role_permission_set", targetId: "role-1",
    requestedPermissions: ["access.assignments.manage"], requestedBy: USER_A,
    reason: "need access", correlationId: CORRELATION, executor: db,
  });
  await assert.rejects(
    () => repo.approveElevatedRequest({
      organisationId: ORG_ID, requestId: request.requestId,
      reviewedBy: USER_A, // same as requester
      correlationId: CORRELATION, executor: db,
    }),
    (error) => error.code === ACCESS_ERROR_CODE.ELEVATED_REVIEWER_NOT_INDEPENDENT,
  );
});

test("target self-approval throws ELEVATED_REVIEWER_NOT_INDEPENDENT", async () => {
  const db = createFakeExecutor();
  const repo = createAccessRepository(db);
  const request = await repo.createElevatedRequest({
    organisationId: ORG_ID, targetType: "assignment", targetId: "assign-1",
    requestedPermissions: ["access.assignments.manage"], requestedBy: USER_A,
    targetUserId: USER_B, reason: "elevate", correlationId: CORRELATION, executor: db,
  });
  await assert.rejects(
    () => repo.approveElevatedRequest({
      organisationId: ORG_ID, requestId: request.requestId,
      reviewedBy: USER_B, // target user
      correlationId: CORRELATION, executor: db,
    }),
    (error) => error.code === ACCESS_ERROR_CODE.ELEVATED_REVIEWER_NOT_INDEPENDENT,
  );
});

test("double decision throws ELEVATED_ALREADY_DECIDED", async () => {
  const db = createFakeExecutor();
  const repo = createAccessRepository(db);
  const request = await repo.createElevatedRequest({
    organisationId: ORG_ID, targetType: "role_permission_set", targetId: "role-2",
    requestedPermissions: ["access.assignments.manage"], requestedBy: USER_A,
    reason: "need", correlationId: CORRELATION, executor: db,
  });
  await repo.approveElevatedRequest({
    organisationId: ORG_ID, requestId: request.requestId,
    reviewedBy: USER_C, correlationId: CORRELATION, executor: db,
  });
  await assert.rejects(
    () => repo.rejectElevatedRequest({
      organisationId: ORG_ID, requestId: request.requestId,
      reviewedBy: USER_B, reason: "too late", correlationId: CORRELATION, executor: db,
    }),
    (error) => error.code === ACCESS_ERROR_CODE.ELEVATED_ALREADY_DECIDED,
  );
});

// === Effective-Permission Resolver Tests ===

test("resolver combines system-role and custom-role permissions", async () => {
  const db = createFakeExecutor();
  seedMembership(db, { membershipId: MEMBERSHIP_A, userId: USER_A, organisationId: ORG_ID });
  seedSystemRole(db, { roleId: "claims_analyst", roleKey: "claims_analyst", permissionKeys: ["claims.view_own", "claims.ingest_own"] });
  db.tables.membership_roles.push({ membership_id: MEMBERSHIP_A, role_id: "claims_analyst", revoked_at: null });

  const repo = createAccessRepository(db);

  // Create custom role and assign it
  const role = await repo.createCustomRole({
    organisationId: ORG_ID, roleKey: "custom_reader", displayName: "Custom Reader",
    actorId: ACTOR, correlationId: CORRELATION, idempotencyKey: "cr-1", executor: db,
  });
  await repo.replaceCustomRolePermissions({
    organisationId: ORG_ID, roleId: role.roleId, permissionKeys: ["reports.view_own"],
    expectedVersion: 1, actorId: ACTOR, correlationId: CORRELATION, executor: db,
  });
  await repo.createRoleAssignment({
    organisationId: ORG_ID, membershipId: MEMBERSHIP_A, subjectUserId: USER_A,
    roleId: role.roleId, actorId: ACTOR, correlationId: CORRELATION,
    idempotencyKey: "assign-cr", executor: db,
  });

  const result = await repo.resolveEffectivePermissions({
    organisationId: ORG_ID, userId: USER_A, membershipId: MEMBERSHIP_A, executor: db,
  });

  assert.ok(result.permissionKeys.includes("claims.view_own"), "Should include system-role permission");
  assert.ok(result.permissionKeys.includes("claims.ingest_own"), "Should include system-role permission");
  assert.ok(result.permissionKeys.includes("reports.view_own"), "Should include custom-role permission");
  assert.ok(result.permissions.length >= 3);

  // Verify source explanation
  const claimsSource = result.permissions.find((p) => p.permission === "claims.view_own");
  assert.ok(claimsSource);
  assert.ok(claimsSource.sources.some((s) => s.type === "system_role"));

  const reportsSource = result.permissions.find((p) => p.permission === "reports.view_own");
  assert.ok(reportsSource);
  assert.ok(reportsSource.sources.some((s) => s.type === "custom_role_assignment"));
});

test("resolver retains fixed platform and desktop system-role permissions", async () => {
  const db = createFakeExecutor();
  seedMembership(db, { membershipId: MEMBERSHIP_A, userId: USER_A, organisationId: ORG_ID });
  const permissionKeys = [
    "platform_releases.view",
    "platform_releases.request",
    "platform_releases.approve",
    "platform_administrators.manage",
    "desktop_devices.manage",
    "desktop_fleet_policy.manage",
  ];
  seedSystemRole(db, {
    roleId: "platform_administrator",
    roleKey: "platform_administrator",
    permissionKeys,
  });
  db.tables.membership_roles.push({
    membership_id: MEMBERSHIP_A,
    role_id: "platform_administrator",
    revoked_at: null,
  });

  const result = await createAccessRepository(db).resolveEffectivePermissions({
    organisationId: ORG_ID,
    userId: USER_A,
    membershipId: MEMBERSHIP_A,
    executor: db,
  });

  assert.deepEqual(new Set(result.permissionKeys), new Set(permissionKeys));
  assert.ok(result.permissions.every((permission) => (
    permission.sources.some((source) => source.type === "system_role")
  )));
});

test("resolver excludes permissions from disabled role", async () => {
  const db = createFakeExecutor();
  seedMembership(db, { membershipId: MEMBERSHIP_A, userId: USER_A, organisationId: ORG_ID });
  const repo = createAccessRepository(db);

  const role = await repo.createCustomRole({
    organisationId: ORG_ID, roleKey: "disable_test", displayName: "Disable Test",
    actorId: ACTOR, correlationId: CORRELATION, idempotencyKey: "dt-1", executor: db,
  });
  await repo.replaceCustomRolePermissions({
    organisationId: ORG_ID, roleId: role.roleId, permissionKeys: ["claims.view_own"],
    expectedVersion: 1, actorId: ACTOR, correlationId: CORRELATION, executor: db,
  });
  await repo.createRoleAssignment({
    organisationId: ORG_ID, membershipId: MEMBERSHIP_A, subjectUserId: USER_A,
    roleId: role.roleId, actorId: ACTOR, correlationId: CORRELATION,
    idempotencyKey: "dt-assign", executor: db,
  });

  // Disable the role
  await repo.disableCustomRole({
    organisationId: ORG_ID, roleId: role.roleId, expectedVersion: 2,
    actorId: ACTOR, correlationId: CORRELATION, executor: db,
  });

  const result = await repo.resolveEffectivePermissions({
    organisationId: ORG_ID, userId: USER_A, membershipId: MEMBERSHIP_A, executor: db,
  });

  assert.equal(result.permissionKeys.includes("claims.view_own"), false,
    "Disabled role permissions should not appear in effective permissions");
});

test("resolver includes delegated permissions from active delegation", async () => {
  const db = createFakeExecutor();
  seedMembership(db, { membershipId: MEMBERSHIP_A, userId: USER_A, organisationId: ORG_ID });
  seedMembership(db, { membershipId: MEMBERSHIP_B, userId: USER_B, organisationId: ORG_ID });

  // Give USER_A system-role permissions so they can delegate
  seedSystemRole(db, { roleId: "analyst", roleKey: "analyst", permissionKeys: ["claims.view_own", "reports.view_own"] });
  db.tables.membership_roles.push({ membership_id: MEMBERSHIP_A, role_id: "analyst", revoked_at: null });

  const repo = createAccessRepository(db);
  const future = new Date(Date.now() + 3600_000);

  await repo.createDelegation({
    organisationId: ORG_ID, grantorUserId: USER_A, granteeUserId: USER_B,
    permissionKeys: ["claims.view_own"], expiresAt: future, reason: "coverage",
    actorId: ACTOR, correlationId: CORRELATION, idempotencyKey: "deleg-test", executor: db,
  });

  const result = await repo.resolveEffectivePermissions({
    organisationId: ORG_ID, userId: USER_B, membershipId: MEMBERSHIP_B, executor: db,
  });

  assert.ok(result.permissionKeys.includes("claims.view_own"), "Delegated permission should appear");
  const delegSource = result.permissions.find((p) => p.permission === "claims.view_own");
  assert.ok(delegSource?.sources.some((s) => s.type === "delegation"), "Should have delegation source");
});

// === Authorization Version Tests ===

test("authorization version advances on assignment creation", async () => {
  const db = createFakeExecutor();
  seedMembership(db, { membershipId: MEMBERSHIP_A, userId: USER_A, organisationId: ORG_ID });
  const repo = createAccessRepository(db);
  const initialVersion = db.tables.organisation_memberships[0].authorization_version;

  const role = await repo.createCustomRole({
    organisationId: ORG_ID, roleKey: "ver_role", displayName: "Ver",
    actorId: ACTOR, correlationId: CORRELATION, idempotencyKey: "ver-role", executor: db,
  });
  await repo.createRoleAssignment({
    organisationId: ORG_ID, membershipId: MEMBERSHIP_A, subjectUserId: USER_A,
    roleId: role.roleId, actorId: ACTOR, correlationId: CORRELATION,
    idempotencyKey: "ver-assign", executor: db,
  });

  const newVersion = db.tables.organisation_memberships[0].authorization_version;
  assert.ok(newVersion > initialVersion, "Version must advance on assignment");
});

test("authorization version check detects staleness", async () => {
  const db = createFakeExecutor();
  seedMembership(db, { membershipId: MEMBERSHIP_A, userId: USER_A, organisationId: ORG_ID });
  const repo = createAccessRepository(db);

  // Artificially advance membership version
  db.tables.organisation_memberships[0].authorization_version = 5;

  const result = await repo.checkAuthorizationVersionFresh({
    membershipId: MEMBERSHIP_A, sessionVersion: 3, executor: db,
  });
  assert.equal(result.fresh, false);
  assert.equal(result.reason, "version_mismatch");
  assert.equal(result.currentVersion, 5);
  assert.equal(result.sessionVersion, 3);
});

test("authorization version check passes when fresh", async () => {
  const db = createFakeExecutor();
  seedMembership(db, { membershipId: MEMBERSHIP_A, userId: USER_A, organisationId: ORG_ID });
  const repo = createAccessRepository(db);

  const result = await repo.checkAuthorizationVersionFresh({
    membershipId: MEMBERSHIP_A, sessionVersion: 1, executor: db,
  });
  assert.equal(result.fresh, true);
});

// === Audit Tests ===

test("audit events are written for every mutation", async () => {
  const db = createFakeExecutor();
  seedMembership(db, { membershipId: MEMBERSHIP_A, userId: USER_A, organisationId: ORG_ID });
  const repo = createAccessRepository(db);

  await repo.createCustomRole({
    organisationId: ORG_ID, roleKey: "audit_role", displayName: "Audit",
    actorId: ACTOR, correlationId: CORRELATION, idempotencyKey: "audit-1", executor: db,
  });

  const events = await repo.readAccessAuditHistory({ organisationId: ORG_ID, executor: db });
  assert.ok(events.length >= 1);
  assert.ok(events.some((e) => e.action === "role.created"));
});

// === Idempotency Tests ===

test("idempotency conflict with different intent throws ACCESS_IDEMPOTENCY_CONFLICT", async () => {
  const db = createFakeExecutor();
  const repo = createAccessRepository(db);

  await repo.createCustomRole({
    organisationId: ORG_ID, roleKey: "idemp_role", displayName: "Idemp",
    actorId: ACTOR, correlationId: CORRELATION, idempotencyKey: "same-key", executor: db,
  });

  // Same idempotency key but different intent (different role key)
  await assert.rejects(
    () => repo.createCustomRole({
      organisationId: ORG_ID, roleKey: "different_role", displayName: "Different",
      actorId: ACTOR, correlationId: CORRELATION, idempotencyKey: "same-key", executor: db,
    }),
    (error) => error.code === ACCESS_ERROR_CODE.IDEMPOTENCY_CONFLICT,
  );
});

// === Cross-tenant Tests ===

test("cross-tenant role update rejected", async () => {
  const db = createFakeExecutor();
  const repo = createAccessRepository(db);
  const created = await repo.createCustomRole({
    organisationId: ORG_ID, roleKey: "tenant_role", displayName: "Tenant",
    actorId: ACTOR, correlationId: CORRELATION, idempotencyKey: "tenant-1", executor: db,
  });
  await assert.rejects(
    () => repo.updateCustomRoleMetadata({
      organisationId: "other-org", roleId: created.roleId, displayName: "Hacked",
      expectedVersion: 1, actorId: ACTOR, correlationId: CORRELATION, executor: db,
    }),
    (error) => error.code === ACCESS_ERROR_CODE.TENANT_MISMATCH,
  );
});
