import assert from "node:assert/strict";
import test from "node:test";

import {
  createControlPlaneService,
  createRequiredRoleIdentityRepository,
} from "../src/index.js";

test("required role identity guard rejects a missing scheme administrator role", async () => {
  const identity = createRequiredRoleIdentityRepository({
    async resolveRole() {
      return null;
    },
  });

  await assert.rejects(
    () => identity.resolveRole("scheme_administrator"),
    (error) => {
      assert.equal(error.code, "ROLE_NOT_FOUND");
      assert.equal(error.status, 404);
      return true;
    },
  );

  assert.equal(await identity.resolveRole("investigator"), null);
});

test("invitation signup rolls back when the scheme administrator role is unavailable", async () => {
  const invitation = {
    invitation_id: "invitation-role-missing",
    organisation_id: "org-ubuntu",
    email: "admin@ubuntu.example",
    status: "pending",
    invited_by: "platform-admin-1",
    expires_at: new Date(Date.now() + 60_000),
  };

  let commits = 0;
  let rollbacks = 0;
  let credentialCreations = 0;
  let invitationConsumed = false;
  let roleAssignments = 0;
  let auditWrites = 0;

  const connection = {
    async beginTransaction() {},

    async commit() {
      commits += 1;
    },

    async rollback() {
      rollbacks += 1;
    },

    release() {},

    async execute(sql) {
      const normalizedSql = String(sql).replace(/\s+/g, " ").trim();

      if (
        normalizedSql.startsWith(
          "SELECT * FROM admin_invitations WHERE token_hash = ? FOR UPDATE",
        )
      ) {
        return [[invitation], []];
      }

      if (
        normalizedSql.startsWith(
          "SELECT credential_id FROM credential_identities",
        )
      ) {
        return [[], []];
      }

      if (
        normalizedSql.startsWith(
          "UPDATE admin_invitations SET status = 'consumed'",
        )
      ) {
        invitationConsumed = true;
        return [{ affectedRows: 1 }, []];
      }

      throw new Error(`Unexpected SQL: ${normalizedSql}`);
    },
  };

  const pool = {
    async getConnection() {
      return connection;
    },
  };

  const repositories = {
    identity: {
      async getInternalCredentialByUsername() {
        return null;
      },

      async getSafeUserByCanonicalContact() {
        return {
          userId: "user-existing",
          displayName: "Ubuntu Administrator",
          canonicalContact: "admin@ubuntu.example",
          status: "active",
        };
      },

      async createCredential() {
        credentialCreations += 1;
        return {
          credentialId: "credential-created-in-rolled-back-transaction",
        };
      },

      async getMembershipForUserOrganisation() {
        return {
          membershipId: "membership-existing",
          userId: "user-existing",
          organisationId: "org-ubuntu",
          status: "active",
        };
      },

      async resolveRole(roleKey) {
        assert.equal(roleKey, "scheme_administrator");
        return null;
      },

      async assignRole() {
        roleAssignments += 1;
      },
    },

    security: {
      async recordPlatformAudit() {
        auditWrites += 1;
      },
    },
  };

  const service = createControlPlaneService({
    pool,
    repositories,
  });

  await assert.rejects(
    () => service.signupWithInvitation(
      {
        token: "valid-invitation-token",
        displayName: "Ubuntu Administrator",
        username: "ubuntu.admin",
        password: "Strong-Ubuntu-Password-123",
      },
      {
        correlationId: "missing-role-test",
      },
    ),
    (error) => {
      assert.equal(error.code, "ROLE_NOT_FOUND");
      assert.equal(error.status, 404);
      return true;
    },
  );

  assert.equal(commits, 1);
  assert.equal(rollbacks, 1);
  assert.equal(credentialCreations, 1);
  assert.equal(invitationConsumed, false);
  assert.equal(invitation.status, "pending");
  assert.equal(roleAssignments, 0);
  assert.equal(auditWrites, 0);
});
