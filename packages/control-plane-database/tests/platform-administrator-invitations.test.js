import assert from "node:assert/strict";
import test from "node:test";

import { createControlPlaneService } from "../src/control-plane-service.js";

function transactionPool(execute) {
  const counters = { commits: 0, rollbacks: 0 };
  const connection = {
    async beginTransaction() {},
    async commit() {
      counters.commits += 1;
    },
    async rollback() {
      counters.rollbacks += 1;
    },
    release() {},
    execute,
  };
  return {
    pool: {
      async getConnection() {
        return connection;
      },
      execute,
    },
    counters,
  };
}

function platformOrganisation() {
  return {
    organisationId: "org-platform",
    displayName: "ClaimGuard",
    canonicalSlug: "claimguard",
    organisationType: "platform",
    status: "active",
  };
}

test("platform administrator invitation stores only a token hash and records its privileged audit", async () => {
  const inserts = [];
  const auditEvents = [];
  const { pool, counters } = transactionPool(async (sql, parameters) => {
    const normalizedSql = String(sql).replace(/\s+/g, " ").trim();
    if (normalizedSql.startsWith("SELECT invitation_id, expires_at")) {
      return [[], []];
    }
    if (normalizedSql.startsWith("INSERT INTO admin_invitations")) {
      inserts.push({ sql: normalizedSql, parameters });
      return [{ affectedRows: 1 }, []];
    }
    throw new Error(`Unexpected SQL: ${normalizedSql}`);
  });
  const repositories = {
    organisations: {
      async list() {
        return [platformOrganisation()];
      },
    },
    identity: {
      async getSafeUser(userId) {
        assert.equal(userId, "platform-admin-1");
        return {
          userId,
          canonicalContact: "primary@example.com",
          status: "active",
        };
      },
      async listUsersByOrganisation() {
        return [{
          userId: "platform-admin-1",
          canonicalContact: "primary@example.com",
          userStatus: "active",
          membershipStatus: "active",
          roles: ["platform_administrator"],
        }];
      },
    },
    security: {
      async recordPlatformAudit(event) {
        auditEvents.push(event);
        return { auditEventId: "audit-create-platform-admin-1" };
      },
    },
  };
  const service = createControlPlaneService({ pool, repositories });

  const result = await service.createPlatformAdministratorInvitation(
    {
      email: "Second@Example.com",
      invitedBy: "platform-admin-1",
      reauthenticatedAt: "2026-07-30T09:00:00.000Z",
      expiresInHours: 24,
    },
    {
      type: "user",
      id: "platform-admin-1",
      correlationId: "request-1",
      source: "test",
    },
  );

  assert.equal(result.invitation.email, "second@example.com");
  assert.equal(result.invitation.invitationType, "platform_administrator");
  assert.match(result.token, /^[A-Za-z0-9_-]{40,}$/);
  assert.equal(inserts.length, 1);
  assert.equal(inserts[0].parameters[2], "second@example.com");
  assert.match(inserts[0].parameters[3], /^[a-f0-9]{64}$/);
  assert.notEqual(inserts[0].parameters[3], result.token);
  assert.equal(JSON.stringify(inserts).includes(result.token), false);
  assert.equal(auditEvents.length, 1);
  assert.equal(
    auditEvents[0].action,
    "platform_administrator.invitation_create",
  );
  assert.equal(auditEvents[0].afterSummary.reauthenticated, true);
  assert.equal(JSON.stringify(auditEvents).includes(result.token), false);
  assert.equal(result.auditEventId, "audit-create-platform-admin-1");
  assert.deepEqual(counters, { commits: 1, rollbacks: 0 });
});

test("platform invitation acceptance requires an active inviter and assigns only the platform role", async () => {
  const invitation = {
    invitation_id: "invitation-platform-1",
    organisation_id: "org-platform",
    invitation_type: "platform_administrator",
    email: "second@example.com",
    status: "pending",
    invited_by: "platform-admin-1",
    expires_at: new Date(Date.now() + 60_000),
  };
  const assignedRoles = [];
  const credentials = [];
  const auditEvents = [];
  const { pool, counters } = transactionPool(async (sql, parameters) => {
    const normalizedSql = String(sql).replace(/\s+/g, " ").trim();
    if (normalizedSql.startsWith("SELECT * FROM admin_invitations")) {
      return [[invitation], []];
    }
    if (
      normalizedSql.startsWith(
        "UPDATE admin_invitations SET status = 'consumed'",
      )
    ) {
      assert.deepEqual(parameters, [
        "platform-admin-2",
        "invitation-platform-1",
      ]);
      return [{ affectedRows: 1 }, []];
    }
    throw new Error(`Unexpected SQL: ${normalizedSql}`);
  });
  const repositories = {
    organisations: {
      async getById(organisationId) {
        assert.equal(organisationId, "org-platform");
        return platformOrganisation();
      },
    },
    identity: {
      async getSafeUser(userId) {
        assert.equal(userId, "platform-admin-1");
        return {
          userId,
          canonicalContact: "primary@example.com",
          status: "active",
        };
      },
      async getMembershipForUserOrganisation({ userId, organisationId }) {
        assert.equal(organisationId, "org-platform");
        if (userId === "platform-admin-1") {
          return {
            membershipId: "membership-platform-1",
            userId,
            organisationId,
            status: "active",
          };
        }
        assert.equal(userId, "platform-admin-2");
        return null;
      },
      async listMembershipRoles(membershipId) {
        assert.equal(membershipId, "membership-platform-1");
        return ["platform_administrator"];
      },
      async getSafeUserByCanonicalContact(canonicalContact) {
        assert.equal(canonicalContact, "second@example.com");
        return null;
      },
      async createUser(input) {
        return {
          userId: "platform-admin-2",
          ...input,
        };
      },
      async createCredential(input) {
        credentials.push(input);
        return { credentialId: "credential-platform-2" };
      },
      async createMembership(input) {
        return {
          membershipId: "membership-platform-2",
          ...input,
        };
      },
      async resolveRole(roleKey) {
        assert.equal(roleKey, "platform_administrator");
        return {
          roleId: "role-platform-administrator",
          roleKey,
          organisationScope: "platform",
        };
      },
      async assignRole(input) {
        assignedRoles.push(input);
        return input;
      },
    },
    security: {
      async recordPlatformAudit(event) {
        auditEvents.push(event);
        return { auditEventId: "audit-accept-platform-admin-1" };
      },
    },
  };
  const service = createControlPlaneService({ pool, repositories });

  const result = await service.signupWithInvitation(
    {
      token: "one-time-platform-invitation-token",
      displayName: "Second Administrator",
      username: "second.admin",
      password: "Strong-Platform-Password-123",
    },
    { correlationId: "signup-request-1" },
  );

  assert.equal(result.user.userId, "platform-admin-2");
  assert.equal(result.roleKey, "platform_administrator");
  assert.equal(result.invitationType, "platform_administrator");
  assert.equal(credentials.length, 1);
  assert.equal(credentials[0].userId, "platform-admin-2");
  assert.equal(credentials[0].organisationId, "org-platform");
  assert.equal(credentials[0].passwordAlgorithm, "argon2id");
  assert.equal(assignedRoles.length, 1);
  assert.equal(assignedRoles[0].roleId, "role-platform-administrator");
  assert.equal(
    auditEvents[0].action,
    "platform_administrator.invitation_accept",
  );
  assert.equal(
    JSON.stringify(auditEvents).includes(
      "one-time-platform-invitation-token",
    ),
    false,
  );
  assert.deepEqual(counters, { commits: 1, rollbacks: 0 });
});

test("platform invitation revocation records the actor and never returns a token", async () => {
  const invitation = {
    invitation_id: "invitation-platform-1",
    organisation_id: "org-platform",
    invitation_type: "platform_administrator",
    email: "second@example.com",
    status: "pending",
    invited_by: "platform-admin-1",
    expires_at: new Date(Date.now() + 60_000),
  };
  const auditEvents = [];
  const { pool } = transactionPool(async (sql, parameters) => {
    const normalizedSql = String(sql).replace(/\s+/g, " ").trim();
    if (normalizedSql.startsWith("SELECT * FROM admin_invitations")) {
      return [[invitation], []];
    }
    if (normalizedSql.startsWith("UPDATE admin_invitations")) {
      assert.deepEqual(parameters, [
        "platform-admin-1",
        "invitation-platform-1",
      ]);
      return [{ affectedRows: 1 }, []];
    }
    throw new Error(`Unexpected SQL: ${normalizedSql}`);
  });
  const repositories = {
    organisations: {
      async list() {
        return [platformOrganisation()];
      },
    },
    security: {
      async recordPlatformAudit(event) {
        auditEvents.push(event);
        return { auditEventId: "audit-revoke-platform-admin-1" };
      },
    },
  };
  const service = createControlPlaneService({ pool, repositories });

  const result = await service.revokePlatformAdministratorInvitation(
    {
      invitationId: "invitation-platform-1",
      revokedBy: "platform-admin-1",
      reauthenticatedAt: "2026-07-30T09:30:00.000Z",
    },
    {
      type: "user",
      id: "platform-admin-1",
      source: "test",
    },
  );

  assert.equal(result.invitation.status, "revoked");
  assert.equal("token" in result, false);
  assert.equal(
    auditEvents[0].action,
    "platform_administrator.invitation_revoke",
  );
  assert.equal(auditEvents[0].afterSummary.reauthenticated, true);
  assert.equal(result.auditEventId, "audit-revoke-platform-admin-1");
});
