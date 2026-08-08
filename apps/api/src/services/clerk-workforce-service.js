import {
  ControlPlaneConflictError,
  ControlPlaneNotFoundError,
} from "@claimguard/control-plane-database";

function verifiedPrimaryEmail(clerkUser) {
  const primary = clerkUser?.primaryEmailAddress || null;
  if (primary?.verification?.status !== "verified") return null;
  return String(primary.emailAddress || "").trim().toLowerCase() || null;
}

function displayName(clerkUser, email) {
  return String(clerkUser?.fullName || "").trim()
    || [clerkUser?.firstName, clerkUser?.lastName].filter(Boolean).join(" ").trim()
    || email;
}

function externalInvitationRecord(result) {
  return result?.invitation || result || null;
}

function clerkRole(roleKey) {
  return ["scheme_administrator", "platform_administrator"].includes(roleKey)
    ? "org:admin"
    : "org:member";
}

function invitationDays(expiresAt) {
  const remaining = new Date(expiresAt).getTime() - Date.now();
  return Math.max(1, Math.ceil(remaining / 86_400_000));
}

export function createClerkWorkforceService({
  clerkClient,
  controlPlaneRepositories,
  controlPlaneService,
  signUpRedirectUrl,
}) {
  if (!clerkClient?.organizations) throw new TypeError("Clerk organizations API is required.");
  if (!controlPlaneRepositories?.runInTransaction) {
    throw new TypeError("Control-plane transactions are required.");
  }

  async function ensureClerkOrganisation(organisationId, actor) {
    const existing = await controlPlaneRepositories.identity
      .getClerkOrganisationMapping(organisationId);
    if (existing?.status === "active") return existing;
    if (existing) {
      throw new ControlPlaneConflictError(
        "The Clerk organisation mapping is disabled.",
        "CLERK_ORGANISATION_MAPPING_DISABLED",
      );
    }

    const organisation = await controlPlaneRepositories.organisations.getById(organisationId);
    if (!organisation) {
      throw new ControlPlaneNotFoundError(
        "The internal organisation was not found.",
        "ORGANISATION_NOT_FOUND",
      );
    }
    const created = await clerkClient.organizations.createOrganization({
      name: organisation.displayName,
      slug: organisation.canonicalSlug,
      privateMetadata: {
        claimGuardOrganisationId: organisation.organisationId,
        authority: "sequrin-control-plane",
      },
    });
    try {
      return await controlPlaneRepositories.identity.createClerkOrganisationMapping({
        organisationId,
        clerkOrganisationId: created.id,
        createdBy: actor?.id || null,
      });
    } catch (error) {
      await clerkClient.organizations.deleteOrganization(created.id).catch(() => {});
      throw error;
    }
  }

  async function createInvitation({ internalInvitation, actor, inviterClerkUserId = null }) {
    const invitation = externalInvitationRecord(internalInvitation);
    if (!invitation?.invitationId || !invitation.organisationId || !invitation.email) {
      throw new TypeError("A governed internal invitation is required.");
    }
    const mapping = await ensureClerkOrganisation(invitation.organisationId, actor);
    const roleKey = invitation.roleKey
      || (invitation.invitationType === "platform_administrator"
        ? "platform_administrator"
        : "scheme_administrator");
    const clerkInvitation = await clerkClient.organizations.createOrganizationInvitation({
      organizationId: mapping.clerkOrganisationId,
      emailAddress: invitation.email,
      role: clerkRole(roleKey),
      expiresInDays: invitationDays(invitation.expiresAt),
      inviterUserId: inviterClerkUserId || undefined,
      redirectUrl: signUpRedirectUrl,
      privateMetadata: {
        claimGuardInvitationId: invitation.invitationId,
        claimGuardRoleKey: roleKey,
      },
    });
    try {
      await controlPlaneService.attachClerkInvitation({
        invitationId: invitation.invitationId,
        externalInvitationId: clerkInvitation.id,
      }, actor);
    } catch (error) {
      await clerkClient.organizations.revokeOrganizationInvitation({
        organizationId: mapping.clerkOrganisationId,
        invitationId: clerkInvitation.id,
        requestingUserId: inviterClerkUserId || undefined,
      }).catch(() => {});
      throw error;
    }
    return {
      ...internalInvitation,
      token: undefined,
      clerkInvitationId: clerkInvitation.id,
      invitationUrl: clerkInvitation.url || null,
      delivery: "clerk_email",
    };
  }

  async function revokeInvitation({ invitation, requestingClerkUserId = null }) {
    if (
      invitation?.externalIdentityProvider !== "clerk"
      || !invitation.externalInvitationId
      || !invitation.organisationId
    ) return false;
    const mapping = await controlPlaneRepositories.identity
      .getClerkOrganisationMapping(invitation.organisationId);
    if (!mapping?.clerkOrganisationId) return false;
    await clerkClient.organizations.revokeOrganizationInvitation({
      organizationId: mapping.clerkOrganisationId,
      invitationId: invitation.externalInvitationId,
      requestingUserId: requestingClerkUserId || undefined,
    });
    return true;
  }

  async function activateAuthenticatedIdentity({ clerkUser, clerkOrganisationId, correlationId = null }) {
    const email = verifiedPrimaryEmail(clerkUser);
    if (!email) {
      throw new ControlPlaneConflictError(
        "A verified Clerk email is required.",
        "CLERK_VERIFIED_EMAIL_REQUIRED",
      );
    }
    const mappedOrganisation = await controlPlaneRepositories.authentication
      .getOrganisationByClerkId(clerkOrganisationId);
    if (!mappedOrganisation || mappedOrganisation.mappingStatus !== "active") {
      throw new ControlPlaneNotFoundError(
        "The Clerk organisation is not linked to Sequrin.",
        "CLERK_ORGANISATION_UNMAPPED",
      );
    }

    return controlPlaneRepositories.runInTransaction(async (repositories) => {
      const existingCredential = await repositories.authentication.getExternalCredential({
        organisationId: mappedOrganisation.organisationId,
        authenticationProvider: "oidc",
        externalSubject: clerkUser.id,
      });
      if (existingCredential) return { linked: false, userId: existingCredential.userId };

      const invitation = await repositories.identity.getPendingWorkforceInvitation({
        organisationId: mappedOrganisation.organisationId,
        email,
      }, { lockForUpdate: true });
      let user = await repositories.identity.getSafeUserByCanonicalContact(email, {
        lockForUpdate: true,
      });
      if (!user && !invitation) {
        throw new ControlPlaneNotFoundError(
          "This verified identity has no active Sequrin account or governed invitation.",
          "CLERK_IDENTITY_NOT_INVITED",
        );
      }
      if (invitation) {
        if (
          invitation.externalIdentityProvider !== "clerk"
          || !invitation.externalInvitationId
        ) {
          throw new ControlPlaneConflictError(
            "The invitation was not issued through Clerk.",
            "CLERK_INVITATION_BINDING_REQUIRED",
          );
        }
        if (new Date(invitation.expiresAt).getTime() <= Date.now()) {
          throw new ControlPlaneConflictError(
            "The workforce invitation has expired.",
            "INVITATION_EXPIRED",
          );
        }
      }

      if (!user) {
        user = await repositories.identity.createUser({
          displayName: displayName(clerkUser, email),
          canonicalContact: email,
          status: "active",
        });
      } else if (user.status === "invited") {
        user = await repositories.identity.activateInvitedUser(user.userId);
      }
      if (user.status !== "active") {
        throw new ControlPlaneConflictError(
          "The internal user identity is not active.",
          "USER_INACTIVE",
        );
      }

      let membership = await repositories.identity.getMembershipForUserOrganisation({
        userId: user.userId,
        organisationId: mappedOrganisation.organisationId,
      }, { lockForUpdate: true });
      if (!membership) {
        if (!invitation) {
          throw new ControlPlaneNotFoundError(
            "The internal organisation membership was not found.",
            "MEMBERSHIP_NOT_FOUND",
          );
        }
        membership = await repositories.identity.createMembership({
          userId: user.userId,
          organisationId: mappedOrganisation.organisationId,
          status: "active",
          validFrom: new Date(),
          invitedBy: invitation.invitedBy,
        });
      } else if (membership.status === "invited") {
        membership = await repositories.identity.activateInvitedMembership(membership.membershipId);
      }
      if (membership.status !== "active") {
        throw new ControlPlaneConflictError(
          "The internal organisation membership is not active.",
          "MEMBERSHIP_INACTIVE",
        );
      }

      if (invitation) {
        const role = await repositories.identity.resolveRole(invitation.roleKey);
        if (!role || role.organisationScope !== mappedOrganisation.organisationType) {
          throw new ControlPlaneConflictError(
            "The invited role does not match the organisation scope.",
            "WORKFORCE_INVITATION_ROLE_SCOPE_MISMATCH",
          );
        }
        await repositories.identity.assignRole({
          membershipId: membership.membershipId,
          roleId: role.roleId,
          assignedBy: invitation.invitedBy,
        });
      }

      await repositories.identity.createCredential({
        userId: user.userId,
        organisationId: mappedOrganisation.organisationId,
        authenticationProvider: "oidc",
        username: email,
        externalSubject: clerkUser.id,
        status: "active",
      });
      const localCredentialsDisabled = await repositories.identity
        .disableLocalCredentialsForUserOrganisation({
          userId: user.userId,
          organisationId: mappedOrganisation.organisationId,
        });
      if (invitation) {
        await repositories.identity.consumeWorkforceInvitation({
          invitationId: invitation.invitationId,
          userId: user.userId,
          externalInvitationId: invitation.externalInvitationId,
        });
      }
      await repositories.security.recordPlatformAudit({
        actorType: "user",
        actorId: user.userId,
        organisationScopeId: mappedOrganisation.organisationId,
        action: "workforce_identity.clerk_bound",
        targetType: "credential_identity",
        targetId: user.userId,
        beforeSummary: { localCredentialsActive: localCredentialsDisabled > 0 },
        afterSummary: {
          authenticationProvider: "clerk",
          invitationConsumed: Boolean(invitation),
          localCredentialsDisabled,
        },
        correlationId,
        outcome: "success",
        source: "clerk-workforce-service",
      });
      return {
        linked: true,
        userId: user.userId,
        membershipId: membership.membershipId,
        invitationConsumed: Boolean(invitation),
        localCredentialsDisabled,
      };
    });
  }

  return Object.freeze({
    ensureClerkOrganisation,
    createInvitation,
    revokeInvitation,
    activateAuthenticatedIdentity,
  });
}
