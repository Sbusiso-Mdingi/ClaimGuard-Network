import assert from "node:assert/strict";
import test from "node:test";

import { Hono } from "hono";

import { createTenantContextMiddleware } from "../src/tenant-context-middleware.js";
import { resolveTenantContext } from "../src/tenant-context.js";

function createTenantRepositoryStub({
  byId = new Map(),
  bySlug = new Map(),
  defaultTenant = null,
} = {}) {
  return {
    async lookupTenantById(tenantId) {
      return byId.get(tenantId) || null;
    },
    async lookupTenantBySlug(tenantSlug) {
      return bySlug.get(tenantSlug) || null;
    },
    async getDefaultTenant() {
      return defaultTenant;
    },
  };
}

test("resolveTenantContext uses header in development", async () => {
  const tenantRepository = createTenantRepositoryStub({
    byId: new Map([
      [
        "tenant_alpha",
        {
          tenant_id: "tenant_alpha",
          tenant_slug: "alpha",
          tenant_name: "Alpha",
          status: "active",
        },
      ],
    ]),
  });

  const request = new Request("http://localhost/health", {
    headers: {
      "x-claimguard-tenant": "tenant_alpha",
    },
  });

  const tenantContext = await resolveTenantContext({
    request,
    tenantRepository,
    nodeEnv: "development",
    defaultTenantId: "tenant_default",
  });

  assert.equal(tenantContext.tenant_id, "tenant_alpha");
  assert.equal(tenantContext.tenant_slug, "alpha");
  assert.equal(tenantContext.source, "header");
  assert.equal(Object.isFrozen(tenantContext), true);
});

test("resolveTenantContext uses configured default tenant when no valid header is present", async () => {
  const tenantRepository = createTenantRepositoryStub({
    byId: new Map([
      [
        "tenant_cfg",
        {
          tenant_id: "tenant_cfg",
          tenant_slug: "configured",
          tenant_name: "Configured",
          status: "active",
        },
      ],
    ]),
  });

  const request = new Request("http://localhost/health");
  const tenantContext = await resolveTenantContext({
    request,
    tenantRepository,
    nodeEnv: "development",
    defaultTenantId: "tenant_cfg",
  });

  assert.equal(tenantContext.tenant_id, "tenant_cfg");
  assert.equal(tenantContext.tenant_slug, "configured");
  assert.equal(tenantContext.source, "default_config");
});

test("resolveTenantContext falls back to legacy default tenant", async () => {
  const tenantRepository = createTenantRepositoryStub({
    defaultTenant: {
      tenant_id: "tenant_default",
      tenant_slug: "default",
      tenant_name: "Default",
      status: "active",
    },
  });

  const request = new Request("http://localhost/health");
  const tenantContext = await resolveTenantContext({
    request,
    tenantRepository,
    nodeEnv: "production",
    defaultTenantId: null,
  });

  assert.equal(tenantContext.tenant_id, "tenant_default");
  assert.equal(tenantContext.tenant_slug, "default");
  assert.equal(tenantContext.source, "legacy_fallback");
});

test("tenant middleware attaches req.tenantContext without changing route behavior", async () => {
  const tenantRepository = createTenantRepositoryStub({
    bySlug: new Map([
      [
        "alpha",
        {
          tenant_id: "tenant_alpha",
          tenant_slug: "alpha",
          tenant_name: "Alpha",
          status: "active",
        },
      ],
    ]),
    defaultTenant: {
      tenant_id: "tenant_default",
      tenant_slug: "default",
      tenant_name: "Default",
      status: "active",
    },
  });

  const app = new Hono();
  app.use(
    "*",
    createTenantContextMiddleware({
      tenantRepository,
      nodeEnv: "development",
      defaultTenantId: null,
    }),
  );

  app.get("/health", (c) => {
    return c.json({
      status: "ok",
      tenantContext: c.get("tenantContext"),
      requestTenantContext: c.req.raw.tenantContext || null,
    });
  });

  const response = await app.request("http://localhost/health", {
    headers: {
      "x-claimguard-tenant": "alpha",
    },
  });
  const json = await response.json();

  assert.equal(response.status, 200);
  assert.equal(json.status, "ok");
  assert.equal(json.tenantContext.tenant_id, "tenant_alpha");
  assert.equal(json.tenantContext.source, "header");
  assert.equal(json.requestTenantContext.tenant_slug, "alpha");
});