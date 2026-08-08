import assert from "node:assert/strict";
import test from "node:test";

import { createClaimsReadRepository } from "../src/claims-read-repository.js";
import { CANONICAL_OPERATIONAL_SCHEMA_VERSION } from "../src/operational-schema.js";

function context() {
  return {
    organisationId: "org-context-test",
    organisationType: "medical_scheme",
    organisationStatus: "active",
    routeId: "route-context-test",
    routeType: "legacy_shared",
    routeGeneration: 1,
    operationalTenantId: "tenant-context",
    operationalTenantSlug: "context-test",
    logicalDatabaseIdentifier: "legacy-operational-shared",
    databaseName: "operational",
    schemaVersion: CANONICAL_OPERATIONAL_SCHEMA_VERSION,
    deploymentClass: "demo",
    region: "southafricanorth",
  };
}

const row = {
  claim_id: "claim-context-1",
  current_claim_version: 2,
  scheme_id: "SCHEME-A",
  member_id: "MEMBER-8F1A",
  provider_id: "PROVIDER-7B2C",
  member_first_name: "Amahle",
  member_last_name: "Nkosi",
  member_date_of_birth: "1992-04-12",
  member_gender: "F",
  member_home_region: "Gauteng",
  member_join_date: "2020-01-15",
  provider_practice_name: "Dr Priya Naidoo Family Practice With A Long but Valid Facility Name",
  provider_practice_number: "PR-1001",
  provider_specialty: "General Practice",
  provider_kind: "PRACTICE",
  provider_category: "GENERAL_PRACTITIONER",
  provider_region: "Gauteng",
  service_date: "2026-07-20",
  received_date: "2026-07-23",
  amount: "1250.50",
  quantity: "2.000",
  billing_code: "0190",
  benefit_option: "COMPREHENSIVE",
  network_type: "DSP",
  line_type: "PROFESSIONAL_SERVICE",
  tariff_discipline: "014",
  diagnosis_code: "Z76.0",
  rendering_practitioner_id: "RP-200",
  rendering_practitioner_category: "MEDICAL_PRACTITIONER",
  rendering_known_to_billing_provider: 1,
  created_at: "2026-07-23T08:00:00.000Z",
  updated_at: "2026-07-23T08:00:00.000Z",
  sync_updated_at: "2026-07-23T08:00:00.000Z",
};

function pool() {
  const calls = [];
  return {
    calls,
    async execute(sql) {
      calls.push(sql);
      if (sql.includes("AS sync_updated_at")) return [[row]];
      if (sql.includes("FROM claim_detection_results")) return [[{
        claim_id: row.claim_id,
        claim_version: 2,
        detection_strategy_id: 7,
        strategy_type: "approved_model",
        model_deployment_id: "model:sealed",
        analysis_mode: "PROSPECTIVE_CLAIM_SCREENING",
        scored_at: "2026-07-23T08:01:00.000Z",
        result_payload: JSON.stringify({
          score: { fraudProbability: 0.8, threshold: 0.4, reviewRecommended: true },
          inputDrift: {
            status: "WATCH",
            signals: [{ feature: "diagnosis_code", kind: "UNSEEN_CATEGORY", observed: "Z76.0", expected: "training vocabulary" }],
            message: "One unfamiliar model input was detected.",
          },
        }),
      }]];
      if (sql.includes("FROM claim_processing_outbox")) return [[]];
      if (sql.includes("FROM investigations i")) return [[]];
      throw new Error(`Unexpected SQL: ${sql}`);
    },
  };
}

test("desktop sync carries human identities and raw model inputs without changing the persisted score", async () => {
  const fake = pool();
  const repository = createClaimsReadRepository(fake, { dataPlaneContext: context() });
  const result = await repository.listDesktopClaimChanges({ scopeStart: "2026-05-01T00:00:00.000Z" });
  const claim = result.changes[0].record;

  assert.equal(claim.member.displayName, "Amahle Nkosi");
  assert.equal(claim.memberId, "MEMBER-8F1A");
  assert.deepEqual(claim.member, {
    displayName: "Amahle Nkosi",
    dateOfBirth: "1992-04-12",
    gender: "F",
    homeRegion: "Gauteng",
    joinDate: "2020-01-15",
  });
  assert.equal(claim.provider.displayName.includes("Priya Naidoo"), true);
  assert.equal(claim.providerId, "PROVIDER-7B2C");
  assert.equal(claim.provider.kind, "PRACTICE");
  assert.equal(claim.provider.category, "GENERAL_PRACTITIONER");
  assert.equal(claim.diagnosisCode, "Z76.0");
  assert.equal(claim.receivedDate, "2026-07-23");
  assert.equal(claim.submissionLagDays, 3);
  assert.equal(claim.renderingKnownToBillingProvider, true);
  assert.equal(claim.riskScore, 100);

  const query = fake.calls.find((sql) => sql.includes("AS sync_updated_at"));
  assert.match(query, /m\.tenant_id = c\.tenant_id/);
  assert.match(query, /m\.scheme_id = c\.scheme_id/);
  assert.match(query, /p\.tenant_id = c\.tenant_id/);
  assert.match(query, /p\.scheme_id = c\.scheme_id/);
  assert.match(query, /c\.diagnosis_code/);
  assert.match(query, /p\.provider_category/);
});

test("reference-data ingestion versions reference entities without mutating claim timestamps", async () => {
  const source = await import("node:fs/promises").then(({ readFile }) => readFile(new URL("../src/claim-ingestion-repository.js", import.meta.url), "utf8"));
  const referenceIngestion = source.match(
    /async function ingestReferenceData\([\s\S]*?\n}\n\nasync function readActiveStrategy\(/,
  )?.[0];

  assert.ok(referenceIngestion, "reference-data ingestion source contract must remain discoverable");
  assert.match(referenceIngestion, /persistMemberVersion\(\s*connection,\s*\{/);
  assert.match(referenceIngestion, /persistProviderVersion\(\s*connection,\s*\{/);
  assert.match(referenceIngestion, /recordWrite\(summary\.members,\s*result\)/);
  assert.match(referenceIngestion, /recordWrite\(summary\.providers,\s*result\)/);
  assert.doesNotMatch(
    referenceIngestion,
    /UPDATE\s+claims[\s\S]*?SET[\s\S]*?updated_at\s*=\s*UTC_TIMESTAMP\(3\)/,
  );
});
