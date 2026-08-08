import assert from "node:assert/strict";
import test from "node:test";

import { createIdentityRepository } from "../src/identity-repository.js";

const now = new Date("2026-08-08T10:00:00.000Z");

function executorFixture({ invitationAffectedRows = 1 } = {}) {
  const calls = [];
  const executor = {
    async execute(sql, parameters) {
      calls.push({ sql, parameters });
      if (sql.includes("FROM clerk_organisation_mappings")) {
        return [[{
          mapping_id: "mapping-1",
          organisation_id: "org-1",
          clerk_organisation_id: "clerk-org-1",
          status: "active",
          created_by: "admin-1",
          created_at: now,
          updated_at: now,
          disabled_at: null,
        }]];
      }
      if (sql.includes("FROM admin_invitations")) {
        return [[{
          invitation_id: "invitation-1",
          organisation_id: "org-1",
          invitation_type: "scheme_administrator",
          role_key: "fraud_analyst",
          email: "analyst@example.com",
          status: "pending",
          invited_by: "admin-1",
          expires_at: new Date("2026-08-09T10:00:00.000Z"),
          external_identity_provider: "clerk",
          external_invitation_id: "clerk-invitation-1",
        }]];
      }
      if (sql.includes("SELECT * FROM users")) {
        return [[{
          user_id: "user-1",
          display_name: "Alpha Analyst",
          canonical_contact: "analyst@example.com",
          status: "active",
          authentication_version: 1,
          created_at: now,
          updated_at: now,
        }]];
      }
      if (sql.includes("SELECT * FROM organisation_memberships")) {
        return [[{
          membership_id: "membership-1",
          user_id: "user-1",
          organisation_id: "org-1",
          status: "active",
          valid_from: now,
          created_at: now,
          updated_at: now,
        }]];
      }
      if (sql.includes("UPDATE admin_invitations")) {
        return [{ affectedRows: invitationAffectedRows }];
      }
      if (sql.includes("UPDATE credential_identities")) {
        return [{ affectedRows: 2 }];
      }
      return [{ affectedRows: 1 }];
    },
  };
  return { executor, calls };
}

test("Clerk identity repository maps organisations and governs invitation consumption", async () => {
  const { executor, calls } = executorFixture();
  const repository = createIdentityRepository(executor);

  const mapping = await repository.getClerkOrganisationMapping("org-1");
  assert.equal(mapping.clerkOrganisationId, "clerk-org-1");
  assert.equal(mapping.disabledAt, null);

  const createdMapping = await repository.createClerkOrganisationMapping({
    mappingId: "mapping-1",
    organisationId: "org-1",
    clerkOrganisationId: "clerk-org-1",
    createdBy: "admin-1",
  });
  assert.equal(createdMapping.mappingId, "mapping-1");

  assert.equal(await repository.disableLocalCredentialsForUserOrganisation({
    userId: "user-1",
    organisationId: "org-1",
  }), 2);

  const invitation = await repository.getPendingWorkforceInvitation({
    organisationId: "org-1",
    email: " Analyst@Example.com ",
  }, { lockForUpdate: true });
  assert.equal(invitation.roleKey, "fraud_analyst");
  assert.equal(invitation.externalInvitationId, "clerk-invitation-1");
  assert.equal(calls.at(-1).parameters[1], "analyst@example.com");
  assert.match(calls.at(-1).sql, /FOR UPDATE/);

  assert.equal((await repository.activateInvitedUser("user-1")).status, "active");
  assert.equal((await repository.activateInvitedMembership("membership-1")).status, "active");
  assert.deepEqual(await repository.consumeWorkforceInvitation({
    invitationId: "invitation-1",
    userId: "user-1",
    externalInvitationId: "clerk-invitation-1",
  }), { invitationId: "invitation-1", userId: "user-1" });

  const renderedCalls = JSON.stringify(calls);
  assert.equal(renderedCalls.includes("password_hash = NULL"), true);
  assert.equal(renderedCalls.includes("external_identity_provider = 'clerk'"), true);
});

test("workforce invitation consumption rejects stale writers", async () => {
  const { executor } = executorFixture({ invitationAffectedRows: 0 });
  const repository = createIdentityRepository(executor);

  await assert.rejects(
    repository.consumeWorkforceInvitation({ invitationId: "stale", userId: "user-1" }),
    (error) => error.code === "INVITATION_CONSUMED" && error.status === 409,
  );
});
