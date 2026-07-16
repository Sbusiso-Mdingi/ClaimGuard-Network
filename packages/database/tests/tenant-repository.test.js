import assert from "node:assert/strict";
import test from "node:test";

import {
  LEGACY_DEFAULT_TENANT_ID,
  createTenantRepository,
} from "../src/index.js";

function createFakePool(handler) {
  return {
    async query(sql, params) {
      return handler(String(sql), params);
    },
  };
}

test("tenant repository looks up tenant by tenant_id", async () => {
  const pool = createFakePool((sql, params) => {
    if (sql.includes("FROM tenants") && sql.includes("tenant_id = ?")) {
      assert.equal(params[0], "tenant_alpha");
      return [
        [
          {
            tenant_id: "tenant_alpha",
            tenant_slug: "alpha",
            tenant_name: "Alpha Tenant",
            status: "active",
          },
        ],
      ];
    }

    return [[]];
  });

  const repository = createTenantRepository(pool, { allowLegacyDefault: true });
  const tenant = await repository.lookupTenantById("tenant_alpha");

  assert.equal(tenant.tenant_id, "tenant_alpha");
  assert.equal(tenant.tenant_slug, "alpha");
  assert.equal(tenant.scheme_id, null);
});

test("tenant repository looks up tenant by tenant_slug", async () => {
  const pool = createFakePool((sql, params) => {
    if (sql.includes("FROM tenants") && sql.includes("tenant_slug = ?")) {
      assert.equal(params[0], "default");
      return [[{ tenant_id: LEGACY_DEFAULT_TENANT_ID, tenant_slug: "default", tenant_name: "Default", status: "active" }]];
    }

    return [[]];
  });

  const repository = createTenantRepository(pool);
  const tenant = await repository.lookupTenantBySlug("default");

  assert.equal(tenant.tenant_id, LEGACY_DEFAULT_TENANT_ID);
  assert.equal(tenant.tenant_slug, "default");
});

test("tenant repository looks up tenant by scheme_id using medical_schemes", async () => {
  const pool = createFakePool((sql, params) => {
    if (sql.includes("FROM medical_schemes")) {
      assert.equal(params[0], "S1");
      return [[{ tenant_id: "tenant_s1", tenant_slug: "scheme-1", tenant_name: "Scheme 1", status: "active" }]];
    }

    if (sql.includes("FROM schemes")) {
      throw new Error("Legacy schemes lookup should not run when medical_schemes has a match.");
    }

    return [[]];
  });

  const repository = createTenantRepository(pool);
  const tenant = await repository.lookupTenantBySchemeId("S1");

  assert.equal(tenant.tenant_id, "tenant_s1");
  assert.equal(tenant.scheme_id, "S1");
});

test("tenant repository falls back to schemes lookup when medical_schemes has no match", async () => {
  let medicalLookupCount = 0;
  let legacyLookupCount = 0;

  const pool = createFakePool((sql, params) => {
    if (sql.includes("FROM medical_schemes")) {
      medicalLookupCount += 1;
      assert.equal(params[0], "S2");
      return [[]];
    }

    if (sql.includes("FROM schemes")) {
      legacyLookupCount += 1;
      assert.equal(params[0], "S2");
      return [[{ tenant_id: "tenant_s2", tenant_slug: "scheme-2", tenant_name: "Scheme 2", status: "active" }]];
    }

    return [[]];
  });

  const repository = createTenantRepository(pool);
  const tenant = await repository.lookupTenantBySchemeId("S2");

  assert.equal(medicalLookupCount, 1);
  assert.equal(legacyLookupCount, 1);
  assert.equal(tenant.tenant_id, "tenant_s2");
  assert.equal(tenant.scheme_id, "S2");
});

test("tenant repository returns configured default tenant only with explicit legacy opt-in and validates existence", async () => {
  const pool = createFakePool((sql, params) => {
    if (sql.includes("FROM tenants") && sql.includes("tenant_id = ?") && params[0] === "tenant_cfg") {
      return [[{ tenant_id: "tenant_cfg", tenant_slug: "cfg", tenant_name: "Configured", status: "active" }]];
    }

    if (sql.includes("FROM tenants") && sql.includes("tenant_id = ?") && params[0] === "missing") {
      return [[]];
    }

    if (sql.includes("FROM tenants") && sql.includes("tenant_slug = ?")) {
      return [[]];
    }

    return [[]];
  });

  const repository = createTenantRepository(pool, { allowLegacyDefault: true });
  const defaultTenant = await repository.getDefaultTenant({ defaultTenantId: "tenant_cfg" });

  assert.equal(defaultTenant.tenant_id, "tenant_cfg");
  assert.equal(await repository.validateTenantExists("tenant_cfg"), true);
  assert.equal(await repository.validateTenantExists("missing"), false);
});
