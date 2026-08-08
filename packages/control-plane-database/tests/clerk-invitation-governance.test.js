import assert from "node:assert/strict";
import test from "node:test";

import { createControlPlaneService } from "../src/control-plane-service.js";

function transactionPool(execute) {
  const counters = { commits: 0, rollbacks: 0 };
  const connection = {
    async beginTransaction() {},
    async commit() { counters.commits += 1; },
    async rollback() { counters.rollbacks += 1; },
    release() {},
    execute,
  };
  return {
    pool: {
      async getConnection() { return connection; },
      execute,
    },
    counters,
  };
}

function serviceFixture({ invitationStatus = "pending", externalInvitationId = null } = {}) {
  const audits = [];
  const statements = [];
  const invitation = {
    invitation_id: "invitation-1",
    organisation_id: "org-1",
    invitation_type: "scheme_administrator",
    role_key: "fraud_analyst",
    email: "analyst@example.com",
    status: invitationStatus,
    invited_by: "admin-1",
    created_at: new Date("2026-08-08T09:00:00.000Z"),
    expires_at: new Date("2099-01-01T00:00:00.000Z"),
    consumed_at: null,
    consumed_by_user_id: null,
    revoked_at: null,
    revoked_by: null,
    external_identity_provider: externalInvitationId ? "clerk" : null,
    external_invitation_id: externalInvitationId,
  };
  const execute = async (sql, parameters) => {
    const normalized = String(sql).replace(/\s+/g, " ").trim();
    statements.push({ sql: normalized, parameters });
    if (normalized.startsWith("SELECT invitation_id, organisation_id, status")) return [[invitation]];
    if (normalized.startsWith("SELECT invitation_id, organisation_id, invitation_type")) return [[invitation]];
    return [{ affectedRows: 1 }];
  };
  const { pool, counters } = transactionPool(execute);
  const repositories = {
    organisations: {
      async getById() {
        return { organisationId: "org-1", organisationType: "medical_scheme" };
      },
    },
    identity: {
      async resolveRole(roleKey) {
        return { roleId: "role-1", roleKey, organisationScope: "medical_scheme" };
      },
    },
    security: {
      async recordPlatformAudit(input) {
        audits.push(input);
        return { auditEventId: `audit-${audits.length}` };
      },
    },
  };
  return {
    service: createControlPlaneService({ pool, repositories }),
    audits,
    statements,
    counters,
    repositories,
  };
}

test("medical-scheme workforce invitations pin the requested canonical role", async () => {
  const fixture = serviceFixture();
  const invitation = await fixture.service.createAdminInvitation({
    organisationId: "org-1",
    email: " Analyst@Example.com ",
    roleKey: "fraud_analyst",
    invitedBy: "admin-1",
    expiresInHours: 24,
  }, { id: "admin-1", correlationId: "request-1" });

  assert.equal(invitation.roleKey, "fraud_analyst");
  assert.equal(invitation.email, "analyst@example.com");
  const insert = fixture.statements.find(({ sql }) => sql.startsWith("INSERT INTO admin_invitations"));
  assert.equal(insert.parameters[4], "fraud_analyst");
  assert.equal(JSON.stringify(insert).includes(invitation.token), false);
  assert.equal(fixture.audits[0].afterSummary.roleKey, "fraud_analyst");
});

test("Clerk invitation binding is transactional, idempotent to the same provider record, and audited", async () => {
  const fixture = serviceFixture({ externalInvitationId: "clerk-invitation-1" });
  const result = await fixture.service.attachClerkInvitation({
    invitationId: "invitation-1",
    externalInvitationId: "clerk-invitation-1",
  }, { type: "user", id: "admin-1", correlationId: "request-1" });

  assert.deepEqual(result, {
    invitationId: "invitation-1",
    externalInvitationId: "clerk-invitation-1",
  });
  assert.equal(fixture.audits[0].action, "workforce_invitation.clerk_bound");
  assert.equal(fixture.audits[0].afterSummary.provider, "clerk");
  assert.deepEqual(fixture.counters, { commits: 1, rollbacks: 0 });
});

test("Clerk invitation binding rejects invalid, stale, and conflicting records", async () => {
  const invalid = serviceFixture();
  await assert.rejects(
    invalid.service.attachClerkInvitation({ invitationId: "invitation-1", externalInvitationId: "" }),
    (error) => error.code === "CLERK_INVITATION_ID_REQUIRED",
  );

  const stale = serviceFixture({ invitationStatus: "revoked" });
  await assert.rejects(
    stale.service.attachClerkInvitation({
      invitationId: "invitation-1",
      externalInvitationId: "clerk-invitation-1",
    }),
    (error) => error.code === "INVITATION_NOT_PENDING",
  );

  const conflict = serviceFixture({ externalInvitationId: "clerk-invitation-other" });
  await assert.rejects(
    conflict.service.attachClerkInvitation({
      invitationId: "invitation-1",
      externalInvitationId: "clerk-invitation-1",
    }),
    (error) => error.code === "CLERK_INVITATION_BINDING_CONFLICT",
  );
  assert.equal(conflict.counters.rollbacks, 1);
});

test("failed Clerk delivery revokes only a still-pending internal invitation", async () => {
  const pending = serviceFixture();
  assert.equal(await pending.service.cancelUndeliveredClerkInvitation({
    invitationId: "invitation-1",
    reason: "provider delivery unavailable",
  }, { id: "admin-1" }), true);
  assert.equal(pending.audits[0].action, "workforce_invitation.delivery_failed");
  assert.equal(pending.audits[0].outcome, "failure");

  const consumed = serviceFixture({ invitationStatus: "consumed" });
  assert.equal(await consumed.service.cancelUndeliveredClerkInvitation({
    invitationId: "invitation-1",
  }, { id: "admin-1" }), false);
  assert.equal(consumed.audits.length, 0);
});

test("invitation listings expose provider provenance without internal token hashes", async () => {
  const fixture = serviceFixture({ externalInvitationId: "clerk-invitation-1" });
  const invitations = await fixture.service.listInvitations("org-1");

  assert.equal(invitations[0].roleKey, "fraud_analyst");
  assert.equal(invitations[0].externalIdentityProvider, "clerk");
  assert.equal(invitations[0].externalInvitationId, "clerk-invitation-1");
  assert.equal("token" in invitations[0], false);
});
