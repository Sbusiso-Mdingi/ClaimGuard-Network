import assert from "node:assert/strict";
import test from "node:test";

import { createControlPlaneRepositories } from "../src/index.js";

function normalized(sql) {
  return String(sql).replace(/\s+/g, " ").trim();
}

function createHarness({ targetType = "role_permission_set" } = {}) {
  const calls = [];
  let storedOperation = null;
  const executor = {
    async getConnection() {
      return {
        execute: executor.execute.bind(executor),
        async beginTransaction() {},
        async commit() {},
        async rollback() {},
        release() {},
      };
    },
    async execute(rawSql, params = []) {
      const sql = normalized(rawSql);
      calls.push({ sql, params });

      if (sql.includes("FROM organisation_memberships") && sql.includes("FOR UPDATE")) {
        return [[{
          membership_id: "membership-requester",
          user_id: "user-requester",
          organisation_id: "org-1",
          status: "active",
          authorization_version: 1,
        }], []];
      }
      if (sql.includes("FROM access_role_definitions") && sql.includes("FOR UPDATE")) {
        return [[{
          role_id: "role-1",
          organisation_id: "org-1",
          role_class: "custom",
          status: "active",
          version: 1,
        }], []];
      }
      if (sql.includes("FROM access_role_assignments") && sql.includes("FOR UPDATE")) {
        return [[{
          assignment_id: "assignment-1",
          membership_id: "membership-target",
          subject_user_id: "user-target",
          role_id: "role-1",
          status: "active",
          version: 1,
        }], []];
      }
      if (sql.includes("SELECT permission_key FROM access_role_permissions")) {
        return [[{ permission_key: "access.assignments.manage" }], []];
      }
      if (sql.startsWith("INSERT INTO access_authorization_operations")) {
        if (storedOperation) {
          const error = new Error("duplicate operation");
          error.code = "ER_DUP_ENTRY";
          error.errno = 1062;
          throw error;
        }
        storedOperation = {
          operationId: params[0],
          intentHash: params[4],
          resultJson: params[5],
        };
        return [{ affectedRows: 1 }, []];
      }
      if (sql.startsWith("SELECT operation_id, intent_hash, result_json")) {
        return [[{
          operation_id: storedOperation.operationId,
          intent_hash: storedOperation.intentHash,
          result_json: storedOperation.resultJson,
        }], []];
      }
      if (sql.startsWith("INSERT INTO access_elevated_requests")) return [{ affectedRows: 1 }, []];
      if (sql.startsWith("UPDATE access_elevated_requests SET decision = 'superseded'")) {
        return [{ affectedRows: 2 }, []];
      }
      if (sql.startsWith("INSERT INTO access_audit_events")) return [{ affectedRows: 1 }, []];
      throw new Error(`Unexpected SQL: ${sql}`);
    },
  };
  const repositories = createControlPlaneRepositories(executor);
  const input = {
    organisationId: "org-1",
    targetType,
    targetId: targetType === "assignment" ? "assignment-1" : "role-1",
    targetVersion: 1,
    requestedPermissions: ["access.assignments.manage"],
    requestedBy: "user-requester",
    requesterMembershipId: "membership-requester",
    reason: "Temporary governed access",
    correlationId: `corr-${targetType}`,
    idempotencyKey: `idem-${targetType}`,
  };
  return { calls, repositories, input };
}

for (const targetType of ["role_permission_set", "assignment"]) {
  test(`elevated ${targetType} request is inserted before scoped supersession`, async () => {
    const { calls, repositories, input } = createHarness({ targetType });
    const result = await repositories.runInTransaction((tx) => tx.access.createElevatedRequest(input));

    assert.equal(result.decision, "pending");
    assert.equal(result.version, 1);
    assert.equal(result.replayed, false);

    const insertIndex = calls.findIndex(({ sql }) => sql.startsWith("INSERT INTO access_elevated_requests"));
    const supersedeIndex = calls.findIndex(({ sql }) => sql.startsWith("UPDATE access_elevated_requests SET decision = 'superseded'"));
    const auditIndex = calls.findIndex(({ sql }) => sql.startsWith("INSERT INTO access_audit_events"));
    assert.ok(insertIndex >= 0);
    assert.ok(supersedeIndex > insertIndex);
    assert.ok(auditIndex > supersedeIndex);

    const insert = calls[insertIndex];
    const supersede = calls[supersedeIndex];
    assert.match(supersede.sql, /organisation_id = \?/);
    assert.match(supersede.sql, /target_type = \?/);
    assert.match(supersede.sql, /target_id = \?/);
    assert.match(supersede.sql, /decision = 'pending'/);
    assert.match(supersede.sql, /request_id <> \?/);
    assert.equal(supersede.params[0], result.requestId);
    assert.equal(supersede.params.at(-1), result.requestId);
    assert.equal(insert.params[0], result.requestId);
    assert.deepEqual(supersede.params.slice(1, 4), [input.organisationId, input.targetType, input.targetId]);

    const targetLockIndex = calls.findIndex(({ sql }) => sql.includes("FOR UPDATE")
      && sql.includes(targetType === "assignment" ? "access_role_assignments" : "access_role_definitions"));
    assert.ok(targetLockIndex >= 0 && targetLockIndex < insertIndex);
  });
}

test("elevated request replay returns the authoritative result without repeating mutations", async () => {
  const { calls, repositories, input } = createHarness();
  const original = await repositories.runInTransaction((tx) => tx.access.createElevatedRequest(input));
  const mutationCount = calls.filter(({ sql }) => sql.startsWith("INSERT INTO access_elevated_requests")
    || sql.startsWith("UPDATE access_elevated_requests SET decision = 'superseded'")
    || sql.startsWith("INSERT INTO access_audit_events")).length;

  const replay = await repositories.runInTransaction((tx) => tx.access.createElevatedRequest(input));
  assert.equal(replay.replayed, true);
  assert.equal(replay.requestId, original.requestId);
  assert.equal(replay.decision, "pending");
  assert.equal(replay.version, 1);
  assert.equal(calls.filter(({ sql }) => sql.startsWith("INSERT INTO access_elevated_requests")
    || sql.startsWith("UPDATE access_elevated_requests SET decision = 'superseded'")
    || sql.startsWith("INSERT INTO access_audit_events")).length, mutationCount);
});

test("elevated request idempotency rejects the same key with different intent", async () => {
  const { repositories, input } = createHarness();
  await repositories.runInTransaction((tx) => tx.access.createElevatedRequest(input));

  await assert.rejects(
    () => repositories.runInTransaction((tx) => tx.access.createElevatedRequest({
      ...input,
      reason: "Changed governed intent",
    })),
    (error) => error?.code === "ACCESS_IDEMPOTENCY_CONFLICT",
  );
});
