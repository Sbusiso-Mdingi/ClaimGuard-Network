import assert from "node:assert/strict";
import test from "node:test";

import { createClaimsReadRepository } from "../src/claims-read-repository.js";
import { runWithTenantContext } from "../src/tenant-context-store.js";

function createPoolStub() {
  const calls = [];
  return {
    calls,
    async execute(sql, params = []) {
      calls.push({ sql, params });
      if (/SELECT COUNT\(\*\) AS total FROM claims/i.test(sql)) {
        return [[{ total: 3 }]];
      }
      if (/FROM claims c/i.test(sql) && /LIMIT \d+ OFFSET \d+/i.test(sql)) {
        return [[
          {
            claim_id: "C-3",
            scheme_id: "scheme_a",
            member_id: "member-3",
            provider_id: "provider-3",
            service_date: "2026-07-16",
            amount: 45.25,
            billing_code: "CONSULT",
            created_at: "2026-07-16T00:00:00.000Z",
            updated_at: "2026-07-17T00:00:00.000Z",
          },
        ]];
      }
      if (/FROM investigations i/i.test(sql) && /claim_id IN/i.test(sql)) {
        return [[
          {
            claim_id: "C-3",
            investigation_id: "INV-3",
            status: "OPEN",
            priority: "HIGH",
            updated_at: "2026-07-17T00:00:00.000Z",
          },
        ]];
      }
      if (/FROM investigations i/i.test(sql) && /claim_id = \?/i.test(sql)) {
        return [[]];
      }
      if (/WHERE c\.tenant_id = \? AND c\.claim_id = \?/i.test(sql)) {
        if (params[1] === "C-3") {
          return [[{
            claim_id: "C-3",
            scheme_id: "scheme_a",
            member_id: "member-3",
            provider_id: "provider-3",
            service_date: "2026-07-16",
            amount: 45.25,
            billing_code: "CONSULT",
            created_at: "2026-07-16T00:00:00.000Z",
            updated_at: "2026-07-17T00:00:00.000Z",
          }]];
        }
        return [[]];
      }
      throw new Error(`Unexpected SQL: ${sql}`);
    },
  };
}

function context() {
  return {
    organisationId: "org-1",
    organisationType: "medical_scheme",
    organisationStatus: "active",
    routeId: "route-1",
    routeType: "legacy_shared",
    routeGeneration: 1,
    operationalTenantId: "tenant_alpha",
    operationalTenantSlug: "alpha",
    logicalDatabaseIdentifier: "legacy-operational-shared",
    databaseName: "operational",
    schemaVersion: "13",
    deploymentClass: "demo",
    region: "westeurope",
  };
}

test("claims read repository lists tenant-scoped claims with bounded pagination", async () => {
  const pool = createPoolStub();
  const repository = createClaimsReadRepository(pool, {
    dataPlaneContext: context(),
    allowLegacyTenantContext: false,
    maxPageSize: 100,
  });

  const result = await repository.listClaims({ page: "2", pageSize: "999" });

  assert.equal(result.pagination.page, 2);
  assert.equal(result.pagination.pageSize, 100);
  assert.equal(result.pagination.requestedPageSize, 999);
  assert.equal(result.pagination.maxPageSize, 100);
  assert.equal(result.pagination.total, 3);
  assert.equal(result.claims.length, 1);
  assert.equal(result.claims[0].claimId, "C-3");
  assert.equal(result.claims[0].investigation.investigationId, "INV-3");

  const tenantParams = pool.calls.map((call) => call.params).flat().filter((value) => value === "tenant_alpha");
  assert.equal(tenantParams.length >= 2, true);
});

test("claims read repository returns null for unknown or empty claim identifiers", async () => {
  const pool = createPoolStub();
  const repository = createClaimsReadRepository(pool, {
    dataPlaneContext: context(),
    allowLegacyTenantContext: false,
  });

  assert.equal(await repository.getClaimById("   "), null);
  assert.equal(await repository.getClaimById("C-404"), null);

  const claim = await repository.getClaimById("C-3");
  assert.equal(claim.claimId, "C-3");
  assert.equal(claim.investigation, null);
});

test("claims read repository can resolve tenant from request context store when explicitly allowed", async () => {
  const pool = createPoolStub();
  const repository = createClaimsReadRepository(pool, {
    allowLegacyTenantContext: true,
  });

  const result = await runWithTenantContext({ tenant_id: "tenant_alpha" }, async () => repository.listClaims({}));

  assert.equal(result.claims.length, 1);
});
