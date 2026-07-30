import {
  ARGON2ID_VERSION,
  hashPassword,
  passwordParametersRecord,
} from "./password.js";
import { normalizeUsername } from "./validation.js";

export const DEVELOPMENT_PLATFORM_ADMIN_BOOTSTRAP_CONFIRMATION =
  "BOOTSTRAP_DEVELOPMENT_PLATFORM_ADMINISTRATOR";

function requiredText(value, name, maximumLength) {
  const normalized = String(value || "").trim();
  if (!normalized || normalized.length > maximumLength) {
    throw new TypeError(`${name} is required and must not exceed ${maximumLength} characters.`);
  }
  return normalized;
}

function normalizedEmail(value) {
  const email = requiredText(value, "email", 320).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new TypeError("email must be a valid email address.");
  }
  return email;
}

async function platformState(repositories) {
  const organisations = await repositories.organisations.list();
  const platformOrganisations = organisations.filter(
    (organisation) => organisation.organisationType === "platform",
  );
  if (platformOrganisations.length !== 1) {
    throw new Error("Exactly one ClaimGuard platform organisation is required.");
  }
  const organisation = platformOrganisations[0];
  const administrators = (
    await repositories.identity.listUsersByOrganisation(
      organisation.organisationId,
    )
  ).filter(
    (candidate) =>
      candidate.userStatus === "active"
      && candidate.membershipStatus === "active"
      && candidate.credentialStatus === "active"
      && candidate.roles.includes("platform_administrator"),
  );
  return { organisation, administrators };
}

export async function getDevelopmentPlatformAdminBootstrapStatus({
  repositories,
}) {
  if (!repositories) throw new TypeError("repositories are required.");
  const { organisation, administrators } = await platformState(repositories);
  return {
    organisation: {
      organisationId: organisation.organisationId,
      displayName: organisation.displayName,
      organisationType: organisation.organisationType,
      status: organisation.status,
    },
    activePlatformAdministrators: administrators.map((administrator) => ({
      userId: administrator.userId,
      displayName: administrator.displayName,
      canonicalContact: administrator.canonicalContact,
      username: administrator.username,
      userStatus: administrator.userStatus,
      membershipStatus: administrator.membershipStatus,
      credentialStatus: administrator.credentialStatus,
    })),
    bootstrapEligible: administrators.length === 1,
  };
}

export async function bootstrapDevelopmentPlatformAdministrator(
  {
    allowDevelopmentBootstrap,
    confirmation,
    expectedExistingAdministratorId,
    displayName,
    email,
    username,
    password,
    reason,
    actor,
    correlationId = null,
  },
  { repositories },
) {
  if (allowDevelopmentBootstrap !== true) {
    throw new Error(
      "Development platform administrator bootstrap is disabled.",
    );
  }
  if (confirmation !== DEVELOPMENT_PLATFORM_ADMIN_BOOTSTRAP_CONFIRMATION) {
    throw new Error(
      `Bootstrap requires confirmation ${DEVELOPMENT_PLATFORM_ADMIN_BOOTSTRAP_CONFIRMATION}.`,
    );
  }
  const expectedAdministratorId = requiredText(
    expectedExistingAdministratorId,
    "expectedExistingAdministratorId",
    36,
  );
  const canonicalDisplayName = requiredText(displayName, "displayName", 255);
  const canonicalEmail = normalizedEmail(email);
  const canonicalUsername = normalizeUsername(
    requiredText(username, "username", 255),
  );
  const plaintextPassword = String(password || "");
  if (plaintextPassword.length < 16 || plaintextPassword.length > 128) {
    throw new TypeError("password must contain between 16 and 128 characters.");
  }
  const canonicalReason = requiredText(reason, "reason", 512);
  if (canonicalReason.length < 20) {
    throw new TypeError("reason must contain at least 20 characters.");
  }
  const canonicalActor = requiredText(actor, "actor", 255);
  const passwordHash = await hashPassword(plaintextPassword);

  return repositories.runInTransaction(async (transaction) => {
    const { organisation, administrators } = await platformState(transaction);
    if (
      administrators.length !== 1
      || administrators[0].userId !== expectedAdministratorId
    ) {
      throw new Error(
        "Development bootstrap requires exactly the expected single active platform administrator.",
      );
    }
    const existingUser = await transaction.identity
      .getSafeUserByCanonicalContact(canonicalEmail, { lockForUpdate: true });
    if (existingUser) {
      throw new Error("The development bootstrap email already belongs to a user.");
    }
    const role = await transaction.identity.resolveRole(
      "platform_administrator",
    );
    if (!role || role.organisationScope !== "platform") {
      throw new Error("The platform administrator role is unavailable or incorrectly scoped.");
    }

    const user = await transaction.identity.createUser({
      displayName: canonicalDisplayName,
      canonicalContact: canonicalEmail,
      status: "active",
    });
    const credential = await transaction.identity.createCredential({
      userId: user.userId,
      organisationId: organisation.organisationId,
      authenticationProvider: "local_password",
      username: canonicalUsername,
      status: "active",
      passwordHash,
      passwordAlgorithm: "argon2id",
      passwordParameters: passwordParametersRecord(),
      passwordVersion: ARGON2ID_VERSION,
    });
    const membership = await transaction.identity.createMembership({
      userId: user.userId,
      organisationId: organisation.organisationId,
      status: "active",
      validFrom: new Date(),
      invitedBy: expectedAdministratorId,
    });
    await transaction.identity.assignRole({
      membershipId: membership.membershipId,
      roleId: role.roleId,
      assignedBy: expectedAdministratorId,
    });
    const audit = await transaction.security.recordPlatformAudit({
      actorType: "user",
      actorId: expectedAdministratorId,
      organisationScopeId: organisation.organisationId,
      action: "platform_administrator.development_bootstrap",
      targetType: "user",
      targetId: user.userId,
      beforeSummary: {
        activePlatformAdministratorCount: 1,
      },
      afterSummary: {
        activePlatformAdministratorCount: 2,
        canonicalContact: canonicalEmail,
        username: canonicalUsername,
        roleKey: "platform_administrator",
        temporaryDevelopmentAccess: true,
        reason: canonicalReason,
        requestedBy: canonicalActor,
      },
      correlationId,
      outcome: "success",
      source: "development-platform-admin-bootstrap",
    });

    return {
      organisation: {
        organisationId: organisation.organisationId,
        displayName: organisation.displayName,
      },
      user,
      credential,
      membership,
      roleKey: "platform_administrator",
      temporaryDevelopmentAccess: true,
      auditEventId: audit.auditEventId,
    };
  });
}
