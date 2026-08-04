import assert from "node:assert/strict";
import test from "node:test";

import { createClaimsReadRepository } from "../src/claims-read-repository.js";
import { CANONICAL_OPERATIONAL_SCHEMA_VERSION } from "../src/operational-schema.js";
import { runWithTenantContext } from "../src/tenant-context-store.js";

function baseClaim(overrides = {}) {
  return {
    claim_id: "C-3",
    current_claim_version: 2,
    scheme_id: "scheme_a",
    member_id: "member-3",
    provider_id: "provider-3",
    service_date: "2026-07-16",
    amount: 45.25,
    billing_code: "CONSULT",
    created_at: "2026-07-16T00:00:00.000Z",
    updated_at: "2026-07-17T00:00:00.000Z",
    ...overrides,
  };
}

function approvedModelResult(overrides = {}) {
  return {
    tenant_id: "tenant_alpha",
    claim_id: "C-3",
    claim_version: 2,
    detection_strategy_id: 29,
    strategy_type: "approved_model",
    model_deployment_id: "claimguard-claim-fraud-ensemble:1.1.0",
    source_job_id: "job-model-1",
    request_id: "request-model-1",
    analysis_mode: "PROSPECTIVE_APPROVED_MODEL",
    ensemble_id: "claimguard-claim-fraud-ensemble",
    ensemble_version: "1.1.0",
    feature_schema_version: "claims-v1",
    scored_at: "2026-07-17T00:01:00.000Z",
    result_payload: JSON.stringify({
      schemaVersion: "claimguard.claim-detection-result.v1",
      tenantId: "tenant_alpha",
      claimId: "C-3",
      claimVersion: 2,
      sourceJobId: "job-model-1",
      requestId: "request-model-1",
      analysisMode: "PROSPECTIVE_APPROVED_MODEL",
      strategy: {
        detectionStrategyId: 29,
        strategyType: "approved_model",
        modelDeploymentId: "claimguard-claim-fraud-ensemble:1.1.0",
      },
      model: {
        deploymentId: "claimguard-claim-fraud-ensemble:1.1.0",
        ensembleId: "claimguard-claim-fraud-ensemble",
        ensembleVersion: "1.1.0",
        featureSchemaVersion: "claims-v1",
      },
      score: {
        baselineFraudProbability: 0.91,
        baselinePredictedClass: "FRAUD",
        baselineThreshold: 0.0876,
        ringProbability: 0.2,
        ringReviewHit: true,
        ringThreshold: 0.148,
        phantomProbability: 0.1,
        phantomReviewHit: false,
        phantomThreshold: 0.8138,
        compositeReviewRecommended: true,
      },
    }),
    ...overrides,
  };
}

function pendingJob(overrides = {}) {
  return {
    claim_id: "C-3",
    claim_version: 2,
    id: "job-model-1",
    status: "pending",
    attempt_count: 0,
    max_attempts: 5,
    available_at: "2026-07-17T00:00:00.000Z",
    leased_at: null,
    lease_expires_at: null,
    failure_code: null,
    last_error: null,
    updated_at: "2026-07-17T00:00:00.000Z",
    completed_at: null,
    created_at: "2026-07-17T00:00:00.000Z",
    ...overrides,
  };
}

function investigationRow() {
  return {
    claim_id: "C-3",
    investigation_id: "INV-3",
    status: "OPEN",
    priority: "HIGH",
    updated_at: "2026-07-17T00:02:00.000Z",
  };
}

function createPoolStub({
  claims = [baseClaim()],
  detectionResults = [approvedModelResult()],
  processingJobs = [pendingJob({ status: "completed", completed_at: "2026-07-17T00:01:30.000Z" })],
  investigations = [investigationRow()],
} = {}) {
  const calls = [];
  return {
    calls,
    async execute(sql, params = []) {
      calls.push({ sql, params });
      if (/SELECT COUNT\(\*\) AS total FROM claims/i.test(sql)) {
        return [[{ total: claims.length }]];
      }
      if (/AS sync_updated_at/i.test(sql)) {
        return [claims.map((claim) => ({ ...claim, sync_updated_at: claim.updated_at }))];
      }
      if (/FROM claims c/i.test(sql) && /LIMIT \d+ OFFSET \d+/i.test(sql)) {
        return [claims];
      }
      if (/FROM claims c/i.test(sql) && /c\.claim_id = \?/i.test(sql)) {
        return [[claims.find((claim) => claim.claim_id === params[1])].filter(Boolean)];
      }
      if (/FROM claim_detection_results/i.test(sql)) {
        return [detectionResults];
      }
      if (/FROM claim_processing_outbox o/i.test(sql)) {
        return [processingJobs];
      }
      if (/FROM investigations i/i.test(sql)) {
        return [investigations];
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
    schemaVersion: CANONICAL_OPERATIONAL_SCHEMA_VERSION,
    deploymentClass: "demo",
    region: "westeurope",
  };
}

test("claims read repository returns current-version model detection and investigation state", async () => {
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
  assert.equal(result.pagination.total, 1);
  assert.equal(result.claims.length, 1);

  const claim = result.claims[0];
  assert.equal(claim.claimId, "C-3");
  assert.equal(claim.currentClaimVersion, 2);
  assert.equal(claim.status, "OPEN");
  assert.equal(claim.processingStatus, "scored");
  assert.equal(claim.processing.status, "scored");
  assert.equal(claim.processing.jobId, "job-model-1");
  assert.equal(claim.detection.strategyType, "approved_model");
  assert.equal(claim.detection.modelDeploymentId, "claimguard-claim-fraud-ensemble:1.1.0");
  assert.equal(claim.detection.reviewRecommended, true);
  assert.equal(claim.detection.riskScoreBasis, "THRESHOLD_NORMALIZED_MAX_COMPONENT");
  assert.equal(claim.riskScore, 100);
  assert.equal(claim.riskLevel, "High");
  assert.deepEqual(claim.triggeredRules, [
    "BASELINE_FRAUD",
    "RING_REVIEW_HIT",
    "MODEL_REVIEW_RECOMMENDED",
  ]);
  assert.equal(claim.evidence.length, 3);
  assert.equal(claim.investigation.investigationId, "INV-3");

  const tenantParams = pool.calls.map((call) => call.params).flat().filter((value) => value === "tenant_alpha");
  assert.equal(tenantParams.length >= 4, true);
});

test("desktop claim changes are bounded, stable, and retain operational reference identifiers", async () => {
  const pool = createPoolStub();
  const repository = createClaimsReadRepository(pool, {
    dataPlaneContext: context(),
    allowLegacyTenantContext: false,
  });

  const result = await repository.listDesktopClaimChanges({
    scopeStart: "2026-05-01T00:00:00.000Z",
    afterUpdatedAt: "2026-07-01T00:00:00.000Z",
    afterClaimId: "C-1",
    limit: 900,
  });

  assert.equal(result.changes.length, 1);
  assert.equal(result.changes[0].resource, "claim");
  assert.equal(result.changes[0].operation, "upsert");
  assert.equal(result.changes[0].record.claimId, "C-3");
  assert.equal(result.changes[0].record.memberId, "member-3");
  assert.equal(result.changes[0].record.providerId, "provider-3");
  const changeQuery = pool.calls.find(({ sql }) => /AS sync_updated_at/i.test(sql));
  assert.ok(changeQuery);
  assert.match(changeQuery.sql, /EXISTS\s*\(\s*SELECT 1 FROM investigations i_active/i);
  assert.match(changeQuery.sql, /SELECT MAX\(i_sync\.updated_at\)/i);
  assert.doesNotMatch(changeQuery.sql, /LEFT JOIN investigations i\s/i);
  assert.match(changeQuery.sql, /LIMIT 501/i);
});

test("claims overview aggregates every current claim instead of the visible page", async () => {
  const pool = {
    async execute(sql, params) {
      assert.deepEqual(params, ["tenant_alpha"]);
      assert.match(sql, /LEFT JOIN claim_detection_results/i);
      return [[
        {
          claim_id: "claim-scored",
          current_claim_version: 1,
          scheme_id: "scheme-a",
          member_id: "member-a",
          provider_id: "provider-a",
          amount: 100,
          created_at: "2026-08-01T05:00:00.000Z",
          updated_at: "2026-08-01T05:01:00.000Z",
          detection_strategy_id: 7,
          strategy_type: "approved_model",
          model_deployment_id: "model:1",
          source_job_id: "job-1",
          request_id: "request-1",
          analysis_mode: "PROSPECTIVE_CLAIM_SCREENING",
          ensemble_id: null,
          ensemble_version: null,
          feature_schema_version: "claims-v1",
          scored_at: "2026-08-01T05:01:00.000Z",
          prospective_fraud_probability: "0.8",
          prospective_threshold: "0.4",
          prospective_review_recommended: "true",
        },
        {
          claim_id: "claim-awaiting",
          current_claim_version: 1,
          scheme_id: "scheme-a",
          member_id: "member-b",
          provider_id: "provider-b",
          amount: 200,
          created_at: "2026-08-01T05:02:00.000Z",
          updated_at: "2026-08-01T05:02:00.000Z",
          detection_strategy_id: null,
        },
        {
          claim_id: "claim-linked-scored",
          current_claim_version: 1,
          scheme_id: "scheme-a",
          member_id: "member-c",
          provider_id: "provider-a",
          amount: 300,
          created_at: "2026-08-01T05:03:00.000Z",
          updated_at: "2026-08-01T05:04:00.000Z",
          detection_strategy_id: 7,
          strategy_type: "approved_model",
          model_deployment_id: "model:1",
          source_job_id: "job-2",
          request_id: "request-2",
          analysis_mode: "PROSPECTIVE_CLAIM_SCREENING",
          feature_schema_version: "claims-v1",
          scored_at: "2026-08-01T05:04:00.000Z",
          prospective_fraud_probability: "0.7",
          prospective_threshold: "0.4",
          prospective_review_recommended: "true",
          input_drift_status: "WATCH",
          input_drift_reliability: "CAUTION",
          input_drift_signal_count: "1",
        },
        {
          claim_id: "claim-network-scored",
          current_claim_version: 1,
          scheme_id: "scheme-a",
          member_id: "member-c",
          provider_id: "provider-c",
          amount: 250,
          created_at: "2026-08-01T05:05:00.000Z",
          updated_at: "2026-08-01T05:06:00.000Z",
          detection_strategy_id: 7,
          strategy_type: "approved_model",
          model_deployment_id: "model:1",
          source_job_id: "job-3",
          request_id: "request-3",
          analysis_mode: "PROSPECTIVE_CLAIM_SCREENING",
          feature_schema_version: "claims-v1",
          scored_at: "2026-08-01T05:06:00.000Z",
          prospective_fraud_probability: "0.6",
          prospective_threshold: "0.4",
          prospective_review_recommended: "true",
        },
      ]];
    },
  };
  const repository = createClaimsReadRepository(pool, {
    dataPlaneContext: context(),
  });

  const overview = await repository.getClaimsOverview();

  assert.equal(overview.summary.totalClaims, 4);
  assert.equal(overview.summary.scoredClaims, 3);
  assert.equal(overview.summary.unscoredClaims, 1);
  assert.equal(overview.summary.highRiskClaims, 3);
  assert.equal(overview.summary.averageRiskScore, 100);
  assert.deepEqual(overview.summary.riskDistribution, {
    critical: 3,
    high: 0,
    medium: 0,
    low: 0,
    unscored: 1,
  });
  assert.deepEqual(overview.summary.inputDrift, {
    inDistribution: 0,
    watch: 1,
    outOfDistribution: 0,
    profileUnavailable: 0,
    unassessed: 2,
  });
  assert.equal(overview.recentDetections[0].claimId, "claim-network-scored");
  assert.equal(overview.graph.nodes.length, 4);
  assert.equal(overview.graph.edges.length, 3);
  assert.equal(overview.graph.edges[0].review_recommended, true);
  assert.equal(overview.graph.summary.review_signal_count, 3);
  assert.equal(overview.graph.summary.active_cluster_count, 1);
  assert.equal(overview.graph.summary.isolated_review_claim_count, 0);
  assert.equal(overview.graph.summary.projection, "MULTI_CLAIM_REVIEW_NETWORKS");
  assert.deepEqual(overview.graph.summary.candidate_rule, {
    minimum_claim_count: 3,
    minimum_member_count: 2,
    minimum_provider_count: 2,
  });
});

test("claims overview excludes isolated review signals from fraud networks", async () => {
  const pool = {
    async execute() {
      return [[
        {
          claim_id: "claim-isolated",
          current_claim_version: 1,
          scheme_id: "scheme-a",
          member_id: "member-a",
          provider_id: "provider-a",
          amount: 100,
          created_at: "2026-08-01T05:00:00.000Z",
          updated_at: "2026-08-01T05:01:00.000Z",
          detection_strategy_id: 7,
          strategy_type: "approved_model",
          model_deployment_id: "model:1",
          analysis_mode: "PROSPECTIVE_CLAIM_SCREENING",
          scored_at: "2026-08-01T05:01:00.000Z",
          prospective_fraud_probability: "0.8",
          prospective_threshold: "0.4",
          prospective_review_recommended: "true",
        },
        {
          claim_id: "claim-same-provider",
          current_claim_version: 1,
          scheme_id: "scheme-a",
          member_id: "member-b",
          provider_id: "provider-a",
          amount: 120,
          created_at: "2026-08-01T05:02:00.000Z",
          updated_at: "2026-08-01T05:03:00.000Z",
          detection_strategy_id: 7,
          strategy_type: "approved_model",
          model_deployment_id: "model:1",
          analysis_mode: "PROSPECTIVE_CLAIM_SCREENING",
          scored_at: "2026-08-01T05:03:00.000Z",
          prospective_fraud_probability: "0.7",
          prospective_threshold: "0.4",
          prospective_review_recommended: "true",
        },
      ]];
    },
  };
  const repository = createClaimsReadRepository(pool, { dataPlaneContext: context() });

  const overview = await repository.getClaimsOverview();

  assert.equal(overview.summary.highRiskClaims, 2);
  assert.equal(overview.graph.nodes.length, 0);
  assert.equal(overview.graph.edges.length, 0);
  assert.equal(overview.graph.summary.review_signal_count, 2);
  assert.equal(overview.graph.summary.isolated_review_claim_count, 2);
  assert.equal(overview.graph.summary.active_cluster_count, 0);
});

test("claims read repository uses the report producer threshold-normalised risk formula", async () => {
  const result = approvedModelResult();
  const payload = JSON.parse(result.result_payload);
  payload.score = {
    baselineFraudProbability: 0.05,
    baselinePredictedClass: "LEGITIMATE",
    baselineThreshold: 0.1,
    ringProbability: 0.03,
    ringReviewHit: false,
    ringThreshold: 0.1,
    phantomProbability: 0.02,
    phantomReviewHit: false,
    phantomThreshold: 0.1,
    compositeReviewRecommended: false,
  };
  result.result_payload = JSON.stringify(payload);

  const pool = createPoolStub({
    detectionResults: [result],
    investigations: [],
  });
  const repository = createClaimsReadRepository(pool, {
    dataPlaneContext: context(),
    allowLegacyTenantContext: false,
  });

  const claim = await repository.getClaimById("C-3");

  assert.equal(claim.riskScore, 35);
  assert.equal(claim.riskLevel, "Low");
  assert.equal(claim.status, "SCORED");
});

test("claims read repository reports a queued current claim before scoring", async () => {
  const pool = createPoolStub({
    detectionResults: [],
    processingJobs: [pendingJob()],
    investigations: [],
  });
  const repository = createClaimsReadRepository(pool, {
    dataPlaneContext: context(),
    allowLegacyTenantContext: false,
  });

  const claim = await repository.getClaimById("C-3");

  assert.equal(claim.status, "AWAITING_SCORING");
  assert.equal(claim.processingStatus, "queued");
  assert.equal(claim.processing.jobId, "job-model-1");
  assert.equal(claim.riskScore, null);
  assert.equal(claim.detection, null);
  assert.deepEqual(claim.triggeredRules, []);
});

test("claims read repository exposes terminal processing failure without inventing a score", async () => {
  const pool = createPoolStub({
    detectionResults: [],
    processingJobs: [pendingJob({
      status: "dead_letter",
      attempt_count: 5,
      failure_code: "MODEL_SERVICE_UNAVAILABLE",
      last_error: "Managed model endpoint could not be reached.",
      completed_at: "2026-07-17T00:05:00.000Z",
    })],
    investigations: [],
  });
  const repository = createClaimsReadRepository(pool, {
    dataPlaneContext: context(),
    allowLegacyTenantContext: false,
  });

  const claim = await repository.getClaimById("C-3");

  assert.equal(claim.status, "PROCESSING_FAILED");
  assert.equal(claim.processingStatus, "failed");
  assert.equal(claim.processing.failureCode, "MODEL_SERVICE_UNAVAILABLE");
  assert.equal(claim.processing.attemptCount, 5);
  assert.equal(claim.riskScore, null);
});

test("claims read repository flags completed work with no result as an integrity failure", async () => {
  const pool = createPoolStub({
    detectionResults: [],
    processingJobs: [pendingJob({
      status: "completed",
      completed_at: "2026-07-17T00:05:00.000Z",
    })],
    investigations: [],
  });
  const repository = createClaimsReadRepository(pool, {
    dataPlaneContext: context(),
    allowLegacyTenantContext: false,
  });

  const claim = await repository.getClaimById("C-3");

  assert.equal(claim.processingStatus, "failed");
  assert.equal(claim.processing.failureCode, "DETECTION_RESULT_MISSING");
  assert.match(claim.processing.lastError, /without a persisted detection result/i);
});

test("claims read repository returns null for unknown or empty claim identifiers", async () => {
  const pool = createPoolStub();
  const repository = createClaimsReadRepository(pool, {
    dataPlaneContext: context(),
    allowLegacyTenantContext: false,
  });

  assert.equal(await repository.getClaimById("   "), null);
  assert.equal(await repository.getClaimById("C-404"), null);
});

test("claims read repository can resolve tenant from request context store when explicitly allowed", async () => {
  const pool = createPoolStub();
  const repository = createClaimsReadRepository(pool, {
    allowLegacyTenantContext: true,
  });

  const result = await runWithTenantContext({ tenant_id: "tenant_alpha" }, async () => repository.listClaims({}));

  assert.equal(result.claims.length, 1);
  assert.equal(result.claims[0].processingStatus, "scored");
});
