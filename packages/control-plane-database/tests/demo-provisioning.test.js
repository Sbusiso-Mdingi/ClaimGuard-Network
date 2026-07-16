import assert from "node:assert/strict";
import test from "node:test";

import { provisionDemoAccounts } from "../src/index.js";

test("demo provisioning represents every current scheme plus a platform administrator without private mapping", async () => {
  const organisations = new Map();
  const memberships = new Map();
  const assignments = [];
  const mappings = [];
  const catalogue = [];
  const routes = new Map();
  let sequence = 0;
  const repositories = {
    organisations: { async getBySlug(slug) { return organisations.get(slug) || null; } },
    authentication: {
      async getInternalCredential() { return null; },
      async getMembership({ userId, organisationId }) { return [...memberships.values()].find((item) => item.userId === userId && item.organisationId === organisationId) || null; },
      async revokeSessionsBy() { return 0; },
    },
    identity: {
      async createUser(input) { sequence += 1; return { ...input, userId: `user-${sequence}` }; },
      async createMembership(input) { const item = { ...input, membershipId: `membership-${sequence}` }; memberships.set(item.membershipId, item); return item; },
      async createCredential(input) { return { ...input, credentialId: `credential-${sequence}` }; },
    },
    routes: { async getSafeActiveForOrganisation(organisationId) { return routes.get(organisationId) || null; } },
  };
  const service = {
    async createDraftOrganisation(input) {
      const item = { ...input, organisationId: `org-${input.canonicalSlug}`, status: "draft", activationState: "not_activated" };
      organisations.set(input.canonicalSlug, item);
      return item;
    },
    async transitionOrganisation(id, status) {
      const item = [...organisations.values()].find((organisation) => organisation.organisationId === id);
      item.status = status;
      if (status === "active") item.activationState = "activated";
      return item;
    },
    async assignMembershipRole(input) { assignments.push(input); return input; },
    async registerRoute(input) {
      const route = { ...input, routeId: `route-${input.organisationId}`, routeGeneration: 1 };
      routes.set(input.organisationId, route);
      return route;
    },
  };
  const executor = {
    async execute(sql, params = []) {
      if (sql.startsWith("SELECT * FROM legacy_tenant_mappings")) return [[], []];
      if (sql.startsWith("INSERT INTO legacy_tenant_mappings")) { mappings.push(params); return [{ affectedRows: 1 }, []]; }
      if (sql.startsWith("INSERT INTO demo_account_catalogue")) { catalogue.push(params); return [{ affectedRows: 1 }, []]; }
      throw new Error(`Unexpected SQL: ${sql}`);
    },
  };
  const result = await provisionDemoAccounts({
    tenants: [
      { tenantId: "tenant-alpha", tenantSlug: "alpha", tenantName: "Alpha Health" },
      { tenantId: "tenant-beta", tenantSlug: "beta", tenantName: "Beta Health" },
    ],
    repositories, service, executor,
  });
  assert.equal(result.oneTimeCredentials.length, 11);
  assert.deepEqual([...new Set(result.oneTimeCredentials.map((entry) => entry.organisation))].sort(), ["alpha", "beta", "claimguard"]);
  assert.equal(result.oneTimeCredentials.filter((entry) => entry.role === "platform_administrator").length, 1);
  assert.equal(mappings.length, 2);
  assert.equal(routes.size, 3);
  assert.equal([...routes.values()].filter((route) => route.routeType === "legacy_shared").length, 2);
  assert.equal([...routes.values()].find((route) => route.routeType === "platform_none").databaseName, null);
  assert.equal(assignments.length, 11);
  assert.equal(catalogue.length, 11);
  assert.equal(result.oneTimeCredentials.every((entry) => entry.password.length >= 32), true);
});
