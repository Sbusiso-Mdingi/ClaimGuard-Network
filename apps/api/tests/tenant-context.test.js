import assert from "node:assert/strict";
import test from "node:test";

import { Hono } from "hono";

import { TenantMismatchError } from "../src/application-errors.js";
import { createAuthenticationMiddleware } from "../src/middleware/authorization-middleware.js";
import { createTenantContextMiddleware } from "../src/tenant-context-middleware.js";
import { resolveTenantContext } from "../src/tenant-context.js";

const alphaTenant = {
  tenant_id: "tenant_alpha",
  tenant_slug: "alpha",
  tenant_name: "Alpha",
  scheme_id: "scheme_alpha",
  status: "active",
};

const betaTenant = {
  tenant_id: "tenant_beta",
  tenant_slug: "beta",
  tenant_name: "Beta",
  scheme_id: "scheme_beta",
  status: "active",
};

function createTenantRepositoryStub() {
  const tenants = [alphaTenant, betaTenant];
  return {
    async lookupTenantById(tenantId) {
      return tenants.find((tenant) => tenant.tenant_id === tenantId) || null;
    },
    async lookupTenantBySlug(tenantSlug) {
      return tenants.find((tenant) => tenant.tenant_slug === tenantSlug) || null;
    },
  };
}

function authenticatedContext(tenantId = alphaTenant.tenant_id) {
  return {
    is_authenticated: true,
    user_id: "user-alpha",
    roles: ["scheme_user"],
    permissions: new Set(),
    tenant_id: tenantId,
    source: "header",
  };
}

test("resolveTenantContext derives the immutable tenant from authenticated membership", async () => {
  const tenantContext = await resolveTenantContext({
    request: new Request("http://localhost/detection/report", {
      headers: { "x-claimguard-tenant": "alpha" },
    }),
    authContext: authenticatedContext("tenant_alpha"),
    tenantRepository: createTenantRepositoryStub(),
  });

  assert.equal(tenantContext.tenant_id, "tenant_alpha");
  assert.equal(tenantContext.tenant_slug, "alpha");
  assert.equal(tenantContext.scheme_id, "scheme_alpha");
  assert.equal(tenantContext.source, "authenticated_membership");
  assert.equal(Object.isFrozen(tenantContext), true);
});

test("resolveTenantContext leaves anonymous health requests tenant-neutral", async () => {
  const tenantContext = await resolveTenantContext({
    request: new Request("http://localhost/health"),
    authContext: { is_authenticated: false },
    tenantRepository: createTenantRepositoryStub(),
    defaultTenantId: "tenant_alpha",
  });

  assert.equal(tenantContext.tenant_id, null);
  assert.equal(tenantContext.tenant_slug, null);
  assert.equal(tenantContext.source, "anonymous");
});

test("resolveTenantContext fails closed on contradictory tenant headers", async () => {
  await assert.rejects(
    () => resolveTenantContext({
      request: new Request("http://localhost/detection/report", {
        headers: { "x-claimguard-tenant": "tenant_beta" },
      }),
      authContext: authenticatedContext("tenant_alpha"),
      tenantRepository: createTenantRepositoryStub(),
    }),
    TenantMismatchError,
  );
});

test("tenant middleware canonicalizes auth, request, and async tenant context", async () => {
  const app = new Hono();
  app.use("*", createAuthenticationMiddleware());
  app.use("*", createTenantContextMiddleware({ tenantRepository: createTenantRepositoryStub() }));
  app.get("/context", (c) => c.json({
    tenantContext: c.get("tenantContext"),
    authContext: c.get("authContext"),
    requestTenantContext: c.req.raw.tenantContext,
  }));

  const response = await app.request("http://localhost/context", {
    headers: {
      "x-claimguard-user": "user-alpha",
      "x-claimguard-role": "scheme_user",
      "x-claimguard-user-tenant": "alpha",
      "x-claimguard-tenant": "tenant_alpha",
    },
  });
  const json = await response.json();

  assert.equal(response.status, 200);
  assert.equal(json.tenantContext.tenant_id, "tenant_alpha");
  assert.equal(json.authContext.tenant_id, "tenant_alpha");
  assert.equal(json.requestTenantContext.tenant_slug, "alpha");
});
