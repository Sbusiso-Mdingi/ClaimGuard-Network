import assert from "node:assert/strict";
import test from "node:test";

import { createClerkWorkforceService } from "../src/services/clerk-workforce-service.js";

const invitation = Object.freeze({
  invitation: {
    invitationId: "invitation-1",
    organisationId: "org-1",
    invitationType: "scheme_administrator",
    roleKey: "scheme_administrator",
    email: "administrator@example.com",
    expiresAt: "2099-01-01T00:00:00.000Z",
  },
});

function invitationHarness({ createError = null, attachError = null } = {}) {
  const calls = { cancel: [], revoke: [], attach: [] };
  const organizations = {
    async createOrganizationInvitation() {
      if (createError) throw createError;
      return { id: "clerk-invitation-1", url: "https://clerk.example/invitations/1" };
    },
    async revokeOrganizationInvitation(input) { calls.revoke.push(input); },
  };
  const controlPlaneRepositories = {
    identity: {
      async getClerkOrganisationMapping() {
        return { status: "active", clerkOrganisationId: "clerk-org-1" };
      },
    },
    async runInTransaction(callback) { return callback(this); },
  };
  const controlPlaneService = {
    async attachClerkInvitation(input) {
      calls.attach.push(input);
      if (attachError) throw attachError;
    },
    async cancelUndeliveredClerkInvitation(input, actor) { calls.cancel.push({ input, actor }); },
  };
  const service = createClerkWorkforceService({
    clerkClient: { organizations },
    controlPlaneRepositories,
    controlPlaneService,
    signUpRedirectUrl: "https://work.sequrin.example/sign-up",
  });
  return { service, calls };
}

test("failed Clerk delivery cancels the governed internal invitation", async () => {
  const { service, calls } = invitationHarness({ createError: new Error("delivery failed") });

  await assert.rejects(service.createInvitation({ internalInvitation: invitation, actor: { id: "admin-1" } }), /delivery failed/);
  assert.equal(calls.revoke.length, 0);
  assert.equal(calls.cancel[0].input.reason, "clerk_delivery_failed");
});

test("failed binding revokes Clerk delivery and cancels the internal invitation", async () => {
  const { service, calls } = invitationHarness({ attachError: new Error("binding failed") });

  await assert.rejects(service.createInvitation({
    internalInvitation: invitation,
    actor: { id: "admin-1" },
    inviterClerkUserId: "clerk-admin-1",
  }), /binding failed/);
  assert.deepEqual(calls.revoke[0], {
    organizationId: "clerk-org-1",
    invitationId: "clerk-invitation-1",
    requestingUserId: "clerk-admin-1",
  });
  assert.equal(calls.cancel[0].input.reason, "clerk_binding_failed");
});

test("platform administrator activation revalidates the inviter's current authority", async () => {
  const repositories = {
    authentication: {
      async getOrganisationByClerkId() {
        return { organisationId: "org-platform", organisationType: "platform", mappingStatus: "active" };
      },
      async getExternalCredential() { return null; },
    },
    identity: {
      async getPendingWorkforceInvitation() {
        return {
          invitationId: "invitation-platform",
          roleKey: "platform_administrator",
          invitedBy: "former-admin",
          externalIdentityProvider: "clerk",
          externalInvitationId: "external-invitation",
          expiresAt: "2099-01-01T00:00:00.000Z",
        };
      },
      async getSafeUserByCanonicalContact() { return null; },
      async getSafeUser() { return { userId: "former-admin", status: "disabled" }; },
      async getMembershipForUserOrganisation() {
        return { membershipId: "membership-former", status: "active" };
      },
      async listMembershipRoles() { return ["platform_administrator"]; },
    },
    async runInTransaction(callback) { return callback(this); },
  };
  const service = createClerkWorkforceService({
    clerkClient: { organizations: {} },
    controlPlaneRepositories: repositories,
    controlPlaneService: {},
    signUpRedirectUrl: "https://work.sequrin.example/sign-up",
  });

  await assert.rejects(service.activateAuthenticatedIdentity({
    clerkOrganisationId: "clerk-platform",
    clerkUser: {
      id: "clerk-new-admin",
      primaryEmailAddress: {
        emailAddress: "new-admin@example.com",
        verification: { status: "verified" },
      },
    },
  }), (error) => error.code === "PLATFORM_ADMINISTRATOR_INVITER_INACTIVE");
});
