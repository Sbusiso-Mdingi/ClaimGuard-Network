import assert from "node:assert/strict";
import test from "node:test";

import {
  bootstrapDevelopmentPlatformAdministrator,
  DEVELOPMENT_PLATFORM_ADMIN_BOOTSTRAP_CONFIRMATION,
  DEVELOPMENT_PLATFORM_ADMIN_MEMBERSHIP_REPAIR_CONFIRMATION,
  getDevelopmentPlatformAdminBootstrapStatus,
  repairDevelopmentPlatformAdministratorMembership,
} from "../src/development-platform-admin-bootstrap.js";

function fixture({ administratorCount = 1 } = {}) {
  const credentials = [];
  const assignments = [];
  const audits = [];
  const repairs = [];
  const futureValidFrom =
    new Date(
      Date.now()
      + 60 * 60 * 1000,
    );
  const administrators = Array.from(
    { length: administratorCount },
    (_, index) => ({
      userId: `platform-admin-${index + 1}`,
      displayName: `Administrator ${index + 1}`,
      canonicalContact: `admin${index + 1}@example.com`,
      username: `admin.${index + 1}`,
      userStatus: "active",
      membershipId:
        `membership-platform-admin-${index + 1}`,
      membershipStatus: "active",
      credentialStatus: "active",
      roles: ["platform_administrator"],
    }),
  );
  const repositories = {
    organisations: {
      async list() {
        return [{
          organisationId: "org-platform",
          displayName: "ClaimGuard",
          organisationType: "platform",
          status: "active",
        }];
      },
    },
    identity: {
      async listUsersByOrganisation() {
        return administrators;
      },
      async getSafeUserByCanonicalContact() {
        return null;
      },
      async resolveRole() {
        return {
          roleId: "platform_administrator",
          roleKey: "platform_administrator",
          organisationScope: "platform",
        };
      },
      async createUser(input) {
        return { userId: "platform-admin-development-2", ...input };
      },
      async createCredential(input) {
        credentials.push(input);
        return {
          credentialId: "credential-development-2",
          userId: input.userId,
          organisationId: input.organisationId,
          normalizedUsername: input.username,
          status: input.status,
        };
      },
      async createMembership(input) {
        return {
          membershipId: "membership-development-2",
          ...input,
        };
      },
      async assignRole(input) {
        assignments.push(input);
        return input;
      },
      async getMembership(membershipId) {
        const administrator =
          administrators.find(
            (candidate) =>
              candidate.membershipId
              === membershipId,
          );
        return administrator
          ? {
            membershipId,
            userId:
              administrator.userId,
            organisationId:
              "org-platform",
            status:
              "active",
            validFrom:
              administrator.userId
                === "platform-admin-2"
                ? futureValidFrom
                : new Date(
                  Date.now()
                  - 60 * 60 * 1000,
                ),
          }
          : null;
      },
      async repairFutureActiveMembershipStart(input) {
        repairs.push(input);
        return {
          membershipId:
            input.membershipId,
          userId:
            input.userId,
          organisationId:
            input.organisationId,
          status:
            "active",
          validFrom:
            new Date(),
        };
      },
    },
    security: {
      async recordPlatformAudit(input) {
        audits.push(input);
        return { auditEventId: "audit-development-bootstrap-1" };
      },
    },
    async runInTransaction(operation) {
      return operation(repositories);
    },
  };
  return {
    repositories,
    credentials,
    assignments,
    audits,
    repairs,
    futureValidFrom,
  };
}

test("development bootstrap status is read-only and requires one usable existing administrator", async () => {
  const { repositories } = fixture();
  const status = await getDevelopmentPlatformAdminBootstrapStatus({
    repositories,
  });

  assert.equal(status.bootstrapEligible, true);
  assert.equal(status.activePlatformAdministrators.length, 1);
  assert.equal(status.activePlatformAdministrators[0].userId, "platform-admin-1");
  assert.equal("passwordHash" in status.activePlatformAdministrators[0], false);
});

test("development bootstrap creates a second scoped account and a permanent audit without exposing its password", async () => {
  const { repositories, credentials, assignments, audits } = fixture();
  const password = "Temporary-Development-Password-123!";
  const result = await bootstrapDevelopmentPlatformAdministrator(
    {
      allowDevelopmentBootstrap: true,
      confirmation: DEVELOPMENT_PLATFORM_ADMIN_BOOTSTRAP_CONFIRMATION,
      expectedExistingAdministratorId: "platform-admin-1",
      displayName: "Development Platform Administrator 2",
      email: "development.admin.2@claimguard.local",
      username: "development.platform.admin.2",
      password,
      reason: "Exercise two-account development governance before production.",
      actor: "Sbusiso-Mdingi",
      correlationId: "development-bootstrap-test",
    },
    { repositories },
  );

  assert.equal(result.temporaryDevelopmentAccess, true);
  assert.equal(result.roleKey, "platform_administrator");
  assert.equal(result.auditEventId, "audit-development-bootstrap-1");
  assert.equal(credentials.length, 1);
  assert.equal(credentials[0].passwordAlgorithm, "argon2id");
  assert.notEqual(credentials[0].passwordHash, password);
  assert.match(credentials[0].passwordHash, /^\$argon2id\$/);
  assert.equal(assignments[0].assignedBy, "platform-admin-1");
  assert.equal(audits[0].action, "platform_administrator.development_bootstrap");
  assert.equal(audits[0].afterSummary.temporaryDevelopmentAccess, true);
  assert.equal(JSON.stringify(audits).includes(password), false);
  assert.equal(JSON.stringify(result).includes(password), false);
});

test("development bootstrap fails closed without its gate or with an unexpected administrator count", async () => {
  const input = {
    allowDevelopmentBootstrap: false,
    confirmation: DEVELOPMENT_PLATFORM_ADMIN_BOOTSTRAP_CONFIRMATION,
    expectedExistingAdministratorId: "platform-admin-1",
    displayName: "Development Platform Administrator 2",
    email: "development.admin.2@claimguard.local",
    username: "development.platform.admin.2",
    password: "Temporary-Development-Password-123!",
    reason: "Exercise two-account development governance before production.",
    actor: "Sbusiso-Mdingi",
  };
  await assert.rejects(
    () => bootstrapDevelopmentPlatformAdministrator(
      input,
      { repositories: fixture().repositories },
    ),
    /bootstrap is disabled/,
  );
  await assert.rejects(
    () => bootstrapDevelopmentPlatformAdministrator(
      { ...input, allowDevelopmentBootstrap: true },
      { repositories: fixture({ administratorCount: 2 }).repositories },
    ),
    /exactly the expected single active platform administrator/,
  );
});

test("development bootstrap membership repair is exact, transactional, and audited", async () => {
  const {
    repositories,
    repairs,
    audits,
    futureValidFrom,
  } =
    fixture({
      administratorCount: 2,
    });
  const result =
    await repairDevelopmentPlatformAdministratorMembership(
      {
        allowDevelopmentBootstrap:
          true,
        confirmation:
          DEVELOPMENT_PLATFORM_ADMIN_MEMBERSHIP_REPAIR_CONFIRMATION,
        expectedExistingAdministratorId:
          "platform-admin-1",
        targetAdministratorId:
          "platform-admin-2",
        targetMembershipId:
          "membership-platform-admin-2",
        targetUsername:
          "admin.2",
        reason:
          "Correct the local-time bootstrap timestamp to database UTC.",
        actor:
          "Sbusiso-Mdingi",
        correlationId:
          "development-bootstrap-repair-test",
      },
      {
        repositories,
      },
    );

  assert.equal(
    result.repaired,
    true,
  );
  assert.deepEqual(
    repairs,
    [{
      membershipId:
        "membership-platform-admin-2",
      userId:
        "platform-admin-2",
      organisationId:
        "org-platform",
    }],
  );
  assert.equal(
    audits[0].action,
    "platform_administrator.development_bootstrap_membership_repair",
  );
  assert.equal(
    audits[0].beforeSummary.validFrom,
    futureValidFrom.toISOString(),
  );
  assert.equal(
    audits[0].afterSummary.timezoneCorrection,
    "utc",
  );
});

test("development bootstrap membership repair fails closed for a mismatched target", async () => {
  const {
    repositories,
    repairs,
  } =
    fixture({
      administratorCount: 2,
    });

  await assert.rejects(
    () =>
      repairDevelopmentPlatformAdministratorMembership(
        {
          allowDevelopmentBootstrap:
            true,
          confirmation:
            DEVELOPMENT_PLATFORM_ADMIN_MEMBERSHIP_REPAIR_CONFIRMATION,
          expectedExistingAdministratorId:
            "platform-admin-1",
          targetAdministratorId:
            "platform-admin-2",
          targetMembershipId:
            "unexpected-membership",
          targetUsername:
            "admin.2",
          reason:
            "Correct the local-time bootstrap timestamp to database UTC.",
          actor:
            "Sbusiso-Mdingi",
        },
        {
          repositories,
        },
      ),
    /does not match the exact configured second platform administrator/,
  );
  assert.equal(
    repairs.length,
    0,
  );
});
