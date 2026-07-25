import assert from "node:assert/strict";
import test from "node:test";

import { createBackendApp } from "../src/backend.js";

const tenant = {
  tenant_id: "tenant_alpha",
  tenant_slug: "alpha",
  tenant_name: "Alpha Medical Scheme",
  scheme_id: "scheme_alpha",
  status: "active",
};

function headers(role = "investigator") {
  return {
    "x-claimguard-user": "investigator-alpha",
    "x-claimguard-role": role,
    "x-claimguard-user-tenant": tenant.tenant_id,
    "x-claimguard-tenant": tenant.tenant_id,
  };
}

function tenantRepository() {
  return {
    async lookupTenantById(id) { return id === tenant.tenant_id ? tenant : null; },
    async lookupTenantBySlug(slug) { return slug === tenant.tenant_slug ? tenant : null; },
    async lookupTenantBySchemeId(id) { return id === tenant.scheme_id ? tenant : null; },
    async getDefaultTenant() { return tenant; },
  };
}

test("investigation queue forwards filters and authenticated actor", async () => {
  let received = null;
  const app = createBackendApp({
    tenantRepository: tenantRepository(),
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
    { headers: headers() },
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
  const app = createBackendApp({
    tenantRepository: tenantRepository(),
    investigationRepository: { async listInvestigations() { return { investigations: [], pagination: {} }; } },
  });

  const response = await app.request("/investigations/queue", { headers: headers("claims_analyst") });
  assert.equal(response.status, 403);
});
