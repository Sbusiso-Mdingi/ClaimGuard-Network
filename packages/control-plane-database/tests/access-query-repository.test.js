import assert from "node:assert/strict";
import test from "node:test";

import { createControlPlaneRepositories } from "../src/index.js";

function executor(handler) {
  return {
    async execute(sql, params = []) {
      return handler(String(sql).replace(/\s+/g, " ").trim(), params);
    },
  };
}

test("access resource reads constrain every query by organisation", async () => {
  const seen = [];
  const db = executor(async (sql, params) => {
    seen.push({ sql, params });
    if (sql.includes("FROM access_role_definitions ard")) {
      return [[{ role_id: "role-1", organisation_id: "org-1", role_key: "reader", display_name: "Reader", description: "", role_class: "custom", status: "active", version: 1, permission_key: "claims.view_own" }], []];
    }
    if (sql.includes("FROM access_role_assignments ara")) {
      return [[{ assignment_id: "assignment-1", organisation_id: "org-1", membership_id: "membership-1", subject_user_id: "user-1", role_id: "role-1", role_key: "reader", display_name: "Reader", status: "active", version: 1 }], []];
    }
    if (sql.includes("FROM access_delegations d")) {
      return [[{ delegation_id: "delegation-1", organisation_id: "org-1", grantor_user_id: "user-admin", grantee_user_id: "user-1", reason: "cover", status: "active", version: 1, permission_key: "claims.view_own" }], []];
    }
    if (sql.includes("FROM access_elevated_requests")) {
      return [[{ request_id: "request-1", organisation_id: "org-1", target_type: "role_assignment", target_id: "assignment-1", requested_permissions: JSON.stringify(["access.assignments.manage"]), requested_by: "user-requester", target_user_id: "user-1", reason: "temporary", decision: "pending", version: 1 }], []];
    }
    throw new Error(`Unexpected SQL: ${sql}`);
  });
  const access = createControlPlaneRepositories(db).access;

  assert.equal((await access.listRoles({ organisationId: "org-1" }))[0].permissionKeys[0], "claims.view_own");
  assert.equal((await access.listAssignments({ organisationId: "org-1" }))[0].membershipId, "membership-1");
  assert.equal((await access.listDelegations({ organisationId: "org-1" }))[0].permissionKeys[0], "claims.view_own");
  assert.deepEqual((await access.listElevatedRequests({ organisationId: "org-1" }))[0].permissionKeys, ["access.assignments.manage"]);
  for (const query of seen) {
    assert.match(query.sql, /organisation_id = \?/);
    assert.equal(query.params[0], "org-1");
  }
});

test("membership and explanation lookups hide foreign organisations", async () => {
  const db = executor(async (sql, params) => {
    if (sql.includes("WHERE organisation_id = ? AND membership_id = ?")) {
      if (params[0] !== "org-1" || params[1] !== "membership-1") return [[], []];
      return [[{ membership_id: "membership-1", user_id: "user-1", organisation_id: "org-1", status: "active", authorization_version: 5 }], []];
    }
    if (sql.includes("WHERE organisation_id = ? AND user_id = ?")) {
      if (params[0] !== "org-1" || params[1] !== "user-1") return [[], []];
      return [[{ membership_id: "membership-1", user_id: "user-1", organisation_id: "org-1", status: "active", authorization_version: 5 }], []];
    }
    if (sql.includes("FROM users u") && sql.includes("organisation_memberships om")) {
      return [[{ user_id: "user-1", user_status: "active", membership_id: "membership-1", membership_status: "active", organisation_id: "org-1" }], []];
    }
    if (sql.includes("FROM access_system_role_assignments")) return [[], []];
    if (sql.includes("FROM access_role_assignments ara")) return [[], []];
    if (sql.includes("FROM access_delegations d")) return [[], []];
    throw new Error(`Unexpected SQL: ${sql}`);
  });
  const access = createControlPlaneRepositories(db).access;

  assert.equal((await access.getMembership({ organisationId: "org-1", membershipId: "membership-1" })).userId, "user-1");
  assert.equal(await access.getMembership({ organisationId: "org-2", membershipId: "membership-1" }), null);
  const explanation = await access.explainUserAccess({ organisationId: "org-1", userId: "user-1" });
  assert.equal(explanation.organisationId, "org-1");
  assert.equal(explanation.authorizationVersion, 5);
  assert.deepEqual(explanation.permissions, []);
  assert.equal(await access.explainUserAccess({ organisationId: "org-2", userId: "user-1" }), null);
});

test("audit reads enforce bounded pages and omit internal summaries", async () => {
  const db = executor(async (sql, params) => {
    assert.match(sql, /FROM access_audit_events/);
    assert.equal(params[0], "org-1");
    assert.equal(params.at(-1), 2);
    return [[{
      audit_event_id: "audit-2", actor_type: "user", actor_id: "user-admin",
      subject_id: "user-1", action: "assignment.create", target_type: "role_assignment",
      target_id: "assignment-1", before_version: null, after_version: 1,
      reason: "approved", correlation_id: "corr-1", outcome: "success",
      occurred_at: new Date("2026-08-06T00:00:00Z"),
    }, {
      audit_event_id: "audit-1", actor_type: "user", actor_id: "user-admin",
      action: "role.create", target_type: "role", target_id: "role-1",
      outcome: "success", occurred_at: new Date("2026-08-05T00:00:00Z"),
    }], []];
  });
  const access = createControlPlaneRepositories(db).access;
  const result = await access.listAudit({ organisationId: "org-1", pageSize: 1 });

  assert.equal(result.events.length, 1);
  assert.equal(result.nextCursor, "audit-2");
  assert.equal(Object.hasOwn(result.events[0], "beforeSummary"), false);
  assert.equal(Object.hasOwn(result.events[0], "afterSummary"), false);
  await assert.rejects(() => access.listAudit({ organisationId: "org-1", pageSize: 101 }), /between 1 and 100/);
});
