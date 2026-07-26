import assert from "node:assert/strict";
import test from "node:test";

import { createClaimsReadRepository } from "../src/prospective-claims-read-repository.js";

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
    schemaVersion: "14",
    deploymentClass: "demo",
    region: "westeurope",
  };
}

function createPool() {
  const claim = {
    claim_id: "C-ML-1",
    current_claim_version: 1,
    scheme_id: "scheme_a",
    member_id: "member-1",
    provider_id: "provider-1",
    service_date: "2026-07-25",
    amount: 650,
    billing_code: "0190",
    created_at: "2026-07-25T20:00:00.000Z",
    updated_at: "2026-07-25T20:01:00.000Z",
  };
  const result = {
    tenant_id: "tenant_alpha",
    claim_id: "C-ML-1",
    claim_version: 1,
    detection_strategy_id: 2,
    strategy_type: "approved_model",
    model_deployment_id: "claimguard-claim-fraud-baseline:1.0.0",
    source_job_id: "job-ml-1",
    request_id: "screen-request-1",
    analysis_mode: "PROSPECTIVE_CLAIM_SCREENING",
    ensemble_id: "claimguard-claim-fraud-baseline",
    ensemble_version: "1.0.0",
    feature_schema_version: "claim-feature-schema-2026.2",
    scored_at: "2026-07-25T20:02:00.000Z",
    result_payload: JSON.stringify({
      schemaVersion: "claimguard.claim-detection-result.v1",
      tenantId: "tenant_alpha",
      claimId: "C-ML-1",
      claimVersion: 1,
      sourceJobId: "job-ml-1",
      requestId: "screen-request-1",
      analysisMode: "PROSPECTIVE_CLAIM_SCREENING",
      strategy: {
        detectionStrategyId: 2,
        strategyType: "approved_model",
        modelDeploymentId: "claimguard-claim-fraud-baseline:1.0.0",
      },
      model: {
        deploymentId: "claimguard-claim-fraud-baseline:1.0.0",
        modelId: "claimguard-claim-fraud-baseline",
        modelVersion: "1.0.0",
        featureSchemaVersion: "claim-feature-schema-2026.2",
      },
      score: {
        fraudProbability: 0.9,
        predictedClass: "FRAUD",
        threshold: 0.08760971001434723,
        reviewRecommended: true,
      },
    }),
  };

  return {
    async execute(sql) {
      if (/FROM claims c/i.test(sql) && /c\.claim_id = \?/i.test(sql)) return [[claim]];
      if (/FROM claim_detection_results/i.test(sql)) return [[result]];
      if (/FROM claim_processing_outbox o/i.test(sql)) {
        return [[{
          claim_id: "C-ML-1",
          claim_version: 1,
          id: "job-ml-1",
          status: "completed",
          attempt_count: 1,
          max_attempts: 5,
          available_at: null,
          leased_at: null,
          lease_expires_at: null,
          failure_code: null,
          last_error: null,
          updated_at: "2026-07-25T20:02:00.000Z",
          completed_at: "2026-07-25T20:02:00.000Z",
          created_at: "2026-07-25T20:00:00.000Z",
        }]];
      }
      if (/FROM investigations i/i.test(sql)) return [[]];
      throw new Error(`Unexpected SQL: ${sql}`);
    },
  };
}

test("prospective ML detection is presented without retrospective ensemble fields", async () => {
  const repository = createClaimsReadRepository(createPool(), {
    dataPlaneContext: context(),
    allowLegacyTenantContext: false,
  });

  const claim = await repository.getClaimById("C-ML-1");

  assert.equal(claim.status, "FLAGGED");
  assert.equal(claim.riskScore, 100);
  assert.equal(claim.riskLevel, "High");
  assert.deepEqual(claim.triggeredRules, ["PROSPECTIVE_ML_REVIEW_RECOMMENDED"]);
  assert.equal(claim.detection.riskScoreBasis, "THRESHOLD_NORMALIZED_BASELINE");
  assert.equal(claim.detection.modelId, "claimguard-claim-fraud-baseline");
  assert.equal(claim.detection.modelVersion, "1.0.0");
  assert.equal(claim.detection.ensembleId, null);
  assert.equal(claim.detection.ensembleVersion, null);
  assert.match(claim.evidence[0], /Prospective ML model classified/);
});
