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

test("Clerk invitation delivery returns only provider-governed invitation material", async () => {
  const { service, calls } = invitationHarness();

  const result = await service.createInvitation({
    internalInvitation: { ...invitation, token: "internal-token-must-not-leak" },
    actor: { id: "admin-1" },
    inviterClerkUserId: "clerk-admin-1",
  });

  assert.equal(result.token, undefined);
  assert.equal(result.clerkInvitationId, "clerk-invitation-1");
  assert.equal(result.invitationUrl, "https://clerk.example/invitations/1");
  assert.equal(result.delivery, "clerk_email");
  assert.deepEqual(calls.attach[0], {
    invitationId: "invitation-1",
    externalInvitationId: "clerk-invitation-1",
  });
});

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

test("Clerk organisation provisioning compensates a failed internal mapping", async () => {
  const calls = { created: [], deleted: [] };
  const service = createClerkWorkforceService({
    clerkClient: {
      organizations: {
        async createOrganization(input) {
          calls.created.push(input);
          return { id: "clerk-org-created" };
        },
        async deleteOrganization(id) { calls.deleted.push(id); },
      },
    },
    controlPlaneRepositories: {
      identity: {
        async getClerkOrganisationMapping() { return null; },
        async createClerkOrganisationMapping() { throw new Error("mapping failed"); },
      },
      organisations: {
        async getById() {
          return { organisationId: "org-1", displayName: "Alpha Health", canonicalSlug: "alpha-health" };
        },
      },
      async runInTransaction(callback) { return callback(this); },
    },
    controlPlaneService: {},
    signUpRedirectUrl: "https://work.sequrin.example/sign-up",
  });

  await assert.rejects(
    service.ensureClerkOrganisation("org-1", { id: "admin-1" }),
    /mapping failed/,
  );
  assert.equal(calls.created[0].privateMetadata.authority, "sequrin-control-plane");
  assert.deepEqual(calls.deleted, ["clerk-org-created"]);
});

test("Clerk invitation revocation is bound to the internal organisation mapping", async () => {
  const revoked = [];
  const service = createClerkWorkforceService({
    clerkClient: {
      organizations: {
        async revokeOrganizationInvitation(input) { revoked.push(input); },
      },
    },
    controlPlaneRepositories: {
      identity: {
        async getClerkOrganisationMapping() {
          return { status: "active", clerkOrganisationId: "clerk-org-1" };
        },
      },
      async runInTransaction(callback) { return callback(this); },
    },
    controlPlaneService: {},
    signUpRedirectUrl: "https://work.sequrin.example/sign-up",
  });

  assert.equal(await service.revokeInvitation({ invitation: {} }), false);
  assert.equal(await service.revokeInvitation({
    invitation: {
      organisationId: "org-1",
      externalIdentityProvider: "clerk",
      externalInvitationId: "clerk-invitation-1",
    },
    requestingClerkUserId: "clerk-admin-1",
  }), true);
  assert.deepEqual(revoked[0], {
    organizationId: "clerk-org-1",
    invitationId: "clerk-invitation-1",
    requestingUserId: "clerk-admin-1",
  });
});

function activationHarness({ existingCredential = null, invitationRecord = undefined } = {}) {
  const calls = {
    users: [], memberships: [], roles: [], credentials: [], consumed: [], audits: [],
  };
  const pendingInvitation = invitationRecord === undefined ? {
    invitationId: "invitation-1",
    organisationId: "org-1",
    roleKey: "fraud_analyst",
    invitedBy: "admin-1",
    expiresAt: "2099-01-01T00:00:00.000Z",
    externalIdentityProvider: "clerk",
    externalInvitationId: "clerk-invitation-1",
  } : invitationRecord;
  const repositories = {
    authentication: {
      async getOrganisationByClerkId() {
        return {
          organisationId: "org-1",
          organisationType: "medical_scheme",
          mappingStatus: "active",
        };
      },
      async getExternalCredential() { return existingCredential; },
    },
    identity: {
      async getPendingWorkforceInvitation() { return pendingInvitation; },
      async getSafeUserByCanonicalContact() { return null; },
      async createUser(input) {
        calls.users.push(input);
        return { userId: "user-1", status: "active" };
      },
      async getMembershipForUserOrganisation() { return null; },
      async createMembership(input) {
        calls.memberships.push(input);
        return { membershipId: "membership-1", status: "active" };
      },
      async resolveRole(roleKey) {
        return { roleId: "role-fraud", roleKey, organisationScope: "medical_scheme" };
      },
      async assignRole(input) { calls.roles.push(input); },
      async createCredential(input) { calls.credentials.push(input); },
      async disableLocalCredentialsForUserOrganisation() { return 1; },
      async consumeWorkforceInvitation(input) { calls.consumed.push(input); },
    },
    security: {
      async recordPlatformAudit(input) { calls.audits.push(input); },
    },
    async runInTransaction(callback) { return callback(this); },
  };
  const service = createClerkWorkforceService({
    clerkClient: { organizations: {} },
    controlPlaneRepositories: repositories,
    controlPlaneService: {},
    signUpRedirectUrl: "https://work.sequrin.example/sign-up",
  });
  return { service, calls };
}

test("a governed Clerk invitation activates internal identity, membership, role, and audit", async () => {
  const { service, calls } = activationHarness();
  const result = await service.activateAuthenticatedIdentity({
    clerkOrganisationId: "clerk-org-1",
    correlationId: "correlation-1",
    clerkUser: {
      id: "clerk-user-1",
      fullName: "Alpha Analyst",
      primaryEmailAddress: {
        emailAddress: "Analyst@Example.com",
        verification: { status: "verified" },
      },
    },
  });

  assert.deepEqual(result, {
    linked: true,
    userId: "user-1",
    membershipId: "membership-1",
    invitationConsumed: true,
    localCredentialsDisabled: 1,
  });
  assert.equal(calls.users[0].canonicalContact, "analyst@example.com");
  assert.equal(calls.memberships[0].organisationId, "org-1");
  assert.deepEqual(calls.roles[0], {
    membershipId: "membership-1",
    roleId: "role-fraud",
    assignedBy: "admin-1",
  });
  assert.equal(calls.credentials[0].authenticationProvider, "oidc");
  assert.equal(calls.credentials[0].externalSubject, "clerk-user-1");
  assert.equal(calls.consumed[0].externalInvitationId, "clerk-invitation-1");
  assert.equal(calls.audits[0].action, "workforce_identity.clerk_bound");
  assert.equal(calls.audits[0].correlationId, "correlation-1");
});

test("an already linked Clerk subject is idempotent and uninvited identities fail closed", async () => {
  const linked = activationHarness({ existingCredential: { userId: "existing-user" } });
  assert.deepEqual(await linked.service.activateAuthenticatedIdentity({
    clerkOrganisationId: "clerk-org-1",
    clerkUser: {
      id: "clerk-existing",
      primaryEmailAddress: {
        emailAddress: "existing@example.com",
        verification: { status: "verified" },
      },
    },
  }), { linked: false, userId: "existing-user" });

  const uninvited = activationHarness({ invitationRecord: null });
  await assert.rejects(uninvited.service.activateAuthenticatedIdentity({
    clerkOrganisationId: "clerk-org-1",
    clerkUser: {
      id: "clerk-uninvited",
      primaryEmailAddress: {
        emailAddress: "uninvited@example.com",
        verification: { status: "verified" },
      },
    },
  }), (error) => error.code === "CLERK_IDENTITY_NOT_INVITED");
});
