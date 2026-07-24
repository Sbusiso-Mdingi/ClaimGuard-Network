import assert from "node:assert/strict";
import test from "node:test";

import { createControlPlaneService } from "../src/index.js";

test("expired administrator invitations persist and reject deterministically", async () => {
  const invitation = {
    invitation_id: "invitation-expired",
    organisation_id: "org-ubuntu",
    email: "admin@ubuntu.example",
    status: "pending",
    invited_by: "platform-admin-1",
    expires_at: new Date(Date.now() - 60_000),
  };

  let commits = 0;
  let rollbacks = 0;
  let expiryUpdates = 0;
  let identityCalls = 0;

  const connection = {
    async beginTransaction() {},

    async commit() {
      commits += 1;
    },

    async rollback() {
      rollbacks += 1;
    },

    release() {},

    async execute(sql, parameters) {
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
          "UPDATE admin_invitations SET status = 'expired'",
        )
      ) {
        assert.deepEqual(parameters, ["invitation-expired"]);
        assert.equal(invitation.status, "pending");

        invitation.status = "expired";
        expiryUpdates += 1;

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

  const unexpectedIdentityCall = async () => {
    identityCalls += 1;
    throw new Error("Identity data must not be touched for an expired invitation.");
  };

  const repositories = {
    identity: {
      getSafeUserByCanonicalContact: unexpectedIdentityCall,
      createUser: unexpectedIdentityCall,
      createCredential: unexpectedIdentityCall,
      getMembershipForUserOrganisation: unexpectedIdentityCall,
      createMembership: unexpectedIdentityCall,
      resolveRole: unexpectedIdentityCall,
      assignRole: unexpectedIdentityCall,
    },

    security: {
      async recordPlatformAudit() {
        throw new Error("A rejected expired invitation must not write a success audit.");
      },
    },
  };

  const service = createControlPlaneService({
    pool,
    repositories,
  });

  const attemptSignup = () =>
    service.signupWithInvitation(
      {
        token: "expired-invitation-token",
        displayName: "Ubuntu Administrator",
        username: "ubuntu.admin",
        password: "Strong-Ubuntu-Password-123",
      },
      {
        correlationId: "expired-invitation-test",
      },
    );

  for (let attempt = 0; attempt < 2; attempt += 1) {
    await assert.rejects(
      attemptSignup,
      (error) => {
        assert.equal(error.code, "INVITATION_EXPIRED");
        assert.equal(error.status, 409);
        return true;
      },
    );
  }

  assert.equal(invitation.status, "expired");
  assert.equal(expiryUpdates, 1);
  assert.equal(commits, 2);
  assert.equal(rollbacks, 0);
  assert.equal(identityCalls, 0);
});
