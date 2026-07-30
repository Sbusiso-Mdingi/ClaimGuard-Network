import assert from "node:assert/strict";
import test from "node:test";

import {
  bootstrapDevelopmentPlatformAdministrator,
  DEVELOPMENT_PLATFORM_ADMIN_BOOTSTRAP_CONFIRMATION,
  getDevelopmentPlatformAdminBootstrapStatus,
} from "../src/development-platform-admin-bootstrap.js";

function fixture({ administratorCount = 1 } = {}) {
  const credentials = [];
  const assignments = [];
  const audits = [];
  const administrators = Array.from(
    { length: administratorCount },
    (_, index) => ({
      userId: `platform-admin-${index + 1}`,
      displayName: `Administrator ${index + 1}`,
      canonicalContact: `admin${index + 1}@example.com`,
      username: `admin.${index + 1}`,
      userStatus: "active",
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
  return { repositories, credentials, assignments, audits };
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
