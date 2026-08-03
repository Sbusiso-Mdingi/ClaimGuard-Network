import assert from "node:assert/strict";
import test from "node:test";

import { createClaimsReadRepository } from "../src/claims-read-repository.js";
import { CANONICAL_OPERATIONAL_SCHEMA_VERSION } from "../src/operational-schema.js";

const claimRow = {
  claim_id: "claim-identity-1",
  current_claim_version: 1,
  scheme_id: "SCHEME1",
  member_id: "member-token-1",
  provider_id: "provider-token-1",
  member_first_name: "Sbusiso",
  member_last_name: "Mdingi",
  provider_practice_name: "Dlamini Family Practice",
  provider_practice_number: 1001,
  provider_specialty: Buffer.from("General Practitioner"),
  provider_region: "Bloemfontein",
  service_date: "2026-08-01",
  amount: "1250.00",
  billing_code: "GP01",
  created_at: "2026-08-01T08:00:00.000Z",
  updated_at: "2026-08-01T08:00:00.000Z",
};

function context() {
  return {
    organisationId: "org-identity-test",
    organisationType: "medical_scheme",
    organisationStatus: "active",
    routeId: "route-identity-test",
    routeType: "legacy_shared",
    routeGeneration: 1,
    operationalTenantId: "tenant-1",
    operationalTenantSlug: "identity-test",
    logicalDatabaseIdentifier: "legacy-operational-shared",
    databaseName: "operational",
    schemaVersion: CANONICAL_OPERATIONAL_SCHEMA_VERSION,
    deploymentClass: "demo",
    region: "southafricanorth",
  };
}

function fakePool() {
  return {
    calls: [],
    async execute(sql) {
      this.calls.push(sql);
      if (sql.includes("COUNT(*) AS total")) return [[{ total: 1 }]];
      if (sql.includes("FROM claims c") && sql.includes("ORDER BY c.updated_at DESC")) {
        return [[claimRow]];
      }
      if (sql.includes("FROM claim_detection_results")) return [[]];
      if (sql.includes("FROM claim_processing_outbox")) return [[]];
      if (sql.includes("FROM investigations i")) return [[]];
      throw new Error(`Unexpected SQL: ${sql}`);
    },
  };
}

test("claim reads expose minimal member and provider presentation alongside tokens", async () => {
  const pool = fakePool();
  const repository = createClaimsReadRepository(pool, {
    dataPlaneContext: context(),
    allowLegacyTenantContext: false,
  });

  const result = await repository.listClaims({ page: 1, pageSize: 25 });
  const claim = result.claims[0];

  assert.equal(claim.memberId, "member-token-1");
  assert.equal(claim.providerId, "provider-token-1");
  assert.deepEqual(claim.member, { displayName: "S. Mdingi" });
  assert.deepEqual(claim.provider, {
    displayName: "Dlamini Family Practice",
    practiceNumber: "1001",
    specialty: "General Practitioner",
    region: "Bloemfontein",
  });

  const baseQuery = pool.calls.find((sql) => sql.includes("ORDER BY c.updated_at DESC"));
  assert.match(baseQuery, /LEFT JOIN members m/);
  assert.match(baseQuery, /m\.tenant_id = c\.tenant_id/);
  assert.match(baseQuery, /m\.scheme_id = c\.scheme_id/);
  assert.match(baseQuery, /LEFT JOIN providers p/);
  assert.match(baseQuery, /p\.tenant_id = c\.tenant_id/);
  assert.match(baseQuery, /p\.scheme_id = c\.scheme_id/);
});
