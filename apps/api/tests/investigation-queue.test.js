import assert from "node:assert/strict";
import test from "node:test";

import { CLAIMGUARD_ROLES } from "../src/authorization-policy.js";
import { createBackendApp } from "../src/backend.js";
import { createStaticAuthenticationProvider } from "./helpers/authentication-provider.js";

const tenant = {
  tenant_id: "tenant_alpha",
  tenant_slug: "alpha",
  tenant_name: "Alpha Medical Scheme",
  scheme_id: "scheme_alpha",
  status: "active",
};

const organisation = Object.freeze({
  organisationId: "org-alpha",
  organisationType: "medical_scheme",
  displayName: tenant.tenant_name,
});

function tenantRepository() {
  return {
    async lookupTenantById(id) { return id === tenant.tenant_id ? tenant : null; },
    async lookupTenantBySlug(slug) { return slug === tenant.tenant_slug ? tenant : null; },
    async lookupTenantBySchemeId(id) { return id === tenant.scheme_id ? tenant : null; },
    async getDefaultTenant() { return tenant; },
  };
}

function createApp({ role = CLAIMGUARD_ROLES.INVESTIGATOR, investigationRepository }) {
  return createBackendApp({
    tenantRepository: tenantRepository(),
    investigationRepository,
    authenticationProvider: createStaticAuthenticationProvider({
      userId: role === CLAIMGUARD_ROLES.INVESTIGATOR ? "investigator-alpha" : "scheme-user-alpha",
      roles: [role],
      tenantId: tenant.tenant_id,
      organisationId: organisation.organisationId,
      organisation,
    }),
  });
}

test("investigation queue forwards filters and authenticated actor", async () => {
  let received = null;
  const app = createApp({
    investigationRepository: {
      async listInvestigations(filters) {
        received = filters;
        return {
          investigations: [{ investigationId: "INV-1", claimId: "CLAIM-1", status: "OPEN", priority: "HIGH" }],
          pagination: { page: 1, pageSize: 25, total: 1, totalPages: 1, hasNextPage: false, hasPreviousPage: false },
          filters: { status: "OPEN", priority: "HIGH", search: "CLAIM", assignment: "mine" },
        };
      },
    },
  });

  const response = await app.request(
    "/investigations/queue?page=1&pageSize=25&status=OPEN&priority=HIGH&search=CLAIM&assignment=mine",
  );
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.equal(payload.available, true);
  assert.equal(payload.investigations[0].investigationId, "INV-1");
  assert.equal(received.actorId, "investigator-alpha");
  assert.equal(received.assignment, "mine");
  assert.equal(received.status, "OPEN");
});

test("investigation queue requires investigation view authority", async () => {
  const app = createApp({
    role: CLAIMGUARD_ROLES.SCHEME_USER,
    investigationRepository: {
      async listInvestigations() {
        return { investigations: [], pagination: {} };
      },
    },
  });

  const response = await app.request("/investigations/queue");
  assert.equal(response.status, 403);
});

test("investigation queue hides unexpected database details and returns a request ID", async () => {
  const databaseError = Object.assign(
    new Error("Incorrect arguments to mysqld_stmt_execute"),
    { code: "ER_WRONG_ARGUMENTS", errno: 1210 },
  );
  const app = createApp({
    investigationRepository: {
      async listInvestigations() {
        throw databaseError;
      },
    },
  });

  const response = await app.request("/investigations/queue", {
    headers: { "x-request-id": "queue-safe-error-test" },
  });
  const payload = await response.json();

  assert.equal(response.status, 500);
  assert.equal(payload.available, false);
  assert.equal(payload.code, "INVESTIGATION_OPERATION_FAILED");
  assert.equal(payload.requestId, "queue-safe-error-test");
  assert.equal(payload.message, "The investigation service is currently unavailable.");
  assert.equal(JSON.stringify(payload).includes("mysqld_stmt_execute"), false);
});
