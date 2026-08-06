import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";

import {
  applyControlPlaneMigrations,
  createControlPlanePool,
  createControlPlaneRepositories,
} from "../src/index.js";

const databaseUrl = process.env.CONTROL_PLANE_TEST_MYSQL_URL || "";

async function seedTenant(pool, { organisationId, slug, requesterId, requesterMembershipId }) {
  await pool.execute(
    `INSERT INTO organisations
      (organisation_id, display_name, canonical_slug, organisation_type,
       deployment_class, status, activation_state)
     VALUES (?, ?, ?, 'medical_scheme', 'demo', 'active', 'activated')`,
    [organisationId, `Supersession ${slug}`, slug],
  );
  await pool.execute(
    `INSERT INTO users (user_id, display_name, status, authentication_version)
     VALUES (?, 'Supersession Requester', 'active', 1)`,
    [requesterId],
  );
  await pool.execute(
    `INSERT INTO organisation_memberships
      (membership_id, user_id, organisation_id, status, valid_from, authorization_version)
     VALUES (?, ?, ?, 'active', UTC_TIMESTAMP(3), 1)`,
    [requesterMembershipId, requesterId, organisationId],
  );
}

async function insertRequest(pool, {
  requestId, organisationId, targetType, targetId, requestedBy, requesterMembershipId,
  decision, idempotencyKey, supersededByRequestId = null,
}) {
  const intentHash = crypto.createHash("sha256").update(requestId).digest("hex");
  await pool.execute(
    `INSERT INTO access_elevated_requests
      (request_id, organisation_id, target_type, target_id, target_version, requested_permissions,
       requested_by, requester_membership_id, reason, decision, version, intent_hash,
       idempotency_key, superseded_by_request_id)
     VALUES (?, ?, ?, ?, 1, JSON_ARRAY('access.assignments.manage'), ?, ?, ?, ?, 1, ?, ?, ?)`,
    [requestId, organisationId, targetType, targetId, requestedBy, requesterMembershipId,
      `fixture ${decision}`, decision, intentHash, idempotencyKey, supersededByRequestId],
  );
}

test(
  "real MySQL elevated supersession inserts the referenced request first and rolls back atomically",
  { skip: !databaseUrl },
  async () => {
    const pool = createControlPlanePool(databaseUrl);
    try {
      await applyControlPlaneMigrations(pool, { applicationVersion: "elevated-supersession-test" });
      const organisationId = crypto.randomUUID();
      const requesterId = crypto.randomUUID();
      const requesterMembershipId = crypto.randomUUID();
      const foreignOrganisationId = crypto.randomUUID();
      const foreignRequesterId = crypto.randomUUID();
      const foreignMembershipId = crypto.randomUUID();
      const suffix = crypto.randomUUID().replaceAll("-", "").slice(0, 12);
      await seedTenant(pool, {
        organisationId,
        slug: `supersession-${suffix}`,
        requesterId,
        requesterMembershipId,
      });
      await seedTenant(pool, {
        organisationId: foreignOrganisationId,
        slug: `supersession-foreign-${suffix}`,
        requesterId: foreignRequesterId,
        requesterMembershipId: foreignMembershipId,
      });

      const repositories = createControlPlaneRepositories(pool);
      const role = await repositories.runInTransaction((tx) => tx.access.createCustomRole({
        organisationId,
        roleKey: `supersession_role_${suffix}`,
        displayName: "Supersession Role",
        actorId: requesterId,
        correlationId: `role-${suffix}`,
        idempotencyKey: `role-${suffix}`,
      }));
      const unrelatedRole = await repositories.runInTransaction((tx) => tx.access.createCustomRole({
        organisationId,
        roleKey: `supersession_unrelated_${suffix}`,
        displayName: "Unrelated Role",
        actorId: requesterId,
        correlationId: `role-unrelated-${suffix}`,
        idempotencyKey: `role-unrelated-${suffix}`,
      }));

      const requestInput = {
        organisationId,
        targetType: "role_permission_set",
        targetId: role.roleId,
        targetVersion: 1,
        requestedPermissions: ["access.assignments.manage"],
        requestedBy: requesterId,
        requesterMembershipId,
        reason: "Governed supersession proof",
      };
      const old = await repositories.runInTransaction((tx) => tx.access.createElevatedRequest({
        ...requestInput,
        reason: "Original governed request",
        correlationId: `old-${suffix}`,
        idempotencyKey: `old-${suffix}`,
      }));
      const unrelated = await repositories.runInTransaction((tx) => tx.access.createElevatedRequest({
        ...requestInput,
        targetId: unrelatedRole.roleId,
        correlationId: `unrelated-${suffix}`,
        idempotencyKey: `unrelated-${suffix}`,
      }));

      const approvedId = crypto.randomUUID();
      const rejectedId = crypto.randomUUID();
      const supersededId = crypto.randomUUID();
      const supersedingFixtureId = crypto.randomUUID();
      const otherTypeId = crypto.randomUUID();
      const foreignId = crypto.randomUUID();
      await insertRequest(pool, {
        requestId: approvedId, organisationId, targetType: "role_permission_set", targetId: role.roleId,
        requestedBy: requesterId, requesterMembershipId, decision: "approved", idempotencyKey: `approved-${suffix}`,
      });
      await insertRequest(pool, {
        requestId: rejectedId, organisationId, targetType: "role_permission_set", targetId: role.roleId,
        requestedBy: requesterId, requesterMembershipId, decision: "rejected", idempotencyKey: `rejected-${suffix}`,
      });
      await insertRequest(pool, {
        requestId: supersedingFixtureId, organisationId, targetType: "role_permission_set", targetId: role.roleId,
        requestedBy: requesterId, requesterMembershipId, decision: "approved", idempotencyKey: `superseding-${suffix}`,
      });
      await insertRequest(pool, {
        requestId: supersededId, organisationId, targetType: "role_permission_set", targetId: role.roleId,
        requestedBy: requesterId, requesterMembershipId, decision: "superseded",
        idempotencyKey: `superseded-${suffix}`, supersededByRequestId: supersedingFixtureId,
      });
      await insertRequest(pool, {
        requestId: otherTypeId, organisationId, targetType: "assignment", targetId: role.roleId,
        requestedBy: requesterId, requesterMembershipId, decision: "pending", idempotencyKey: `other-type-${suffix}`,
      });
      await insertRequest(pool, {
        requestId: foreignId, organisationId: foreignOrganisationId, targetType: "role_permission_set", targetId: role.roleId,
        requestedBy: foreignRequesterId, requesterMembershipId: foreignMembershipId,
        decision: "pending", idempotencyKey: `foreign-${suffix}`,
      });

      const newer = await repositories.runInTransaction((tx) => tx.access.createElevatedRequest({
        ...requestInput,
        correlationId: `new-${suffix}`,
        idempotencyKey: `new-${suffix}`,
      }));
      assert.equal(newer.decision, "pending");
      assert.equal(newer.version, 1);

      const [rows] = await pool.execute(
        `SELECT request_id, organisation_id, target_type, target_id, decision,
                superseded_by_request_id, version
         FROM access_elevated_requests
         WHERE request_id IN (?, ?, ?, ?, ?, ?, ?, ?)
         ORDER BY request_id`,
        [old.requestId, newer.requestId, unrelated.requestId, approvedId, rejectedId,
          supersededId, otherTypeId, foreignId],
      );
      const byId = new Map(rows.map((row) => [row.request_id, row]));
      assert.equal(byId.get(old.requestId).decision, "superseded");
      assert.equal(byId.get(old.requestId).superseded_by_request_id, newer.requestId);
      assert.equal(Number(byId.get(old.requestId).version), 2);
      assert.equal(byId.get(newer.requestId).decision, "pending");
      assert.equal(byId.get(newer.requestId).superseded_by_request_id, null);
      assert.equal(Number(byId.get(newer.requestId).version), 1);
      assert.equal(byId.get(unrelated.requestId).decision, "pending");
      assert.equal(byId.get(approvedId).decision, "approved");
      assert.equal(byId.get(rejectedId).decision, "rejected");
      assert.equal(byId.get(supersededId).superseded_by_request_id, supersedingFixtureId);
      assert.equal(byId.get(otherTypeId).decision, "pending");
      assert.equal(byId.get(foreignId).decision, "pending");

      const [pendingRows] = await pool.execute(
        `SELECT request_id FROM access_elevated_requests
         WHERE organisation_id = ? AND target_type = 'role_permission_set'
           AND target_id = ? AND decision = 'pending'`,
        [organisationId, role.roleId],
      );
      assert.deepEqual(pendingRows.map((row) => row.request_id), [newer.requestId]);

      const replay = await repositories.runInTransaction((tx) => tx.access.createElevatedRequest({
        ...requestInput,
        correlationId: `replay-${suffix}`,
        idempotencyKey: `new-${suffix}`,
      }));
      assert.equal(replay.replayed, true);
      assert.equal(replay.requestId, newer.requestId);
      const [replayAudits] = await pool.execute(
        `SELECT audit_event_id FROM access_audit_events
         WHERE organisation_id = ? AND target_id = ? AND action = 'elevated_request.created'`,
        [organisationId, newer.requestId],
      );
      assert.equal(replayAudits.length, 1);

      await assert.rejects(
        () => repositories.runInTransaction((tx) => tx.access.createElevatedRequest({
          ...requestInput,
          reason: "Changed intent",
          correlationId: `mismatch-${suffix}`,
          idempotencyKey: `new-${suffix}`,
        })),
        (error) => error?.code === "ACCESS_IDEMPOTENCY_CONFLICT",
      );

      const rollbackKey = `rollback-${suffix}`;
      const rollbackCorrelation = `rollback-${suffix}`;
      await assert.rejects(
        () => repositories.runInTransaction(async (tx) => {
          await tx.access.createElevatedRequest({
            ...requestInput,
            reason: "Rollback governed request",
            correlationId: rollbackCorrelation,
            idempotencyKey: rollbackKey,
          });
          throw new Error("injected post-audit transaction failure");
        }),
        /injected post-audit transaction failure/,
      );
      const [rolledBackRequests] = await pool.execute(
        "SELECT request_id FROM access_elevated_requests WHERE organisation_id = ? AND idempotency_key = ?",
        [organisationId, rollbackKey],
      );
      const [rolledBackOperations] = await pool.execute(
        "SELECT operation_id FROM access_authorization_operations WHERE organisation_id = ? AND idempotency_key = ?",
        [organisationId, rollbackKey],
      );
      const [rolledBackAudits] = await pool.execute(
        "SELECT audit_event_id FROM access_audit_events WHERE organisation_id = ? AND correlation_id = ?",
        [organisationId, rollbackCorrelation],
      );
      assert.deepEqual(rolledBackRequests, []);
      assert.deepEqual(rolledBackOperations, []);
      assert.deepEqual(rolledBackAudits, []);
      const [currentRows] = await pool.execute(
        "SELECT decision, superseded_by_request_id, version FROM access_elevated_requests WHERE request_id = ?",
        [newer.requestId],
      );
      assert.equal(currentRows[0].decision, "pending");
      assert.equal(currentRows[0].superseded_by_request_id, null);
      assert.equal(Number(currentRows[0].version), 1);
    } finally {
      await pool.end();
    }
  },
);
