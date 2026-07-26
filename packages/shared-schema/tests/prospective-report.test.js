import test from "node:test";
import assert from "node:assert/strict";

import { parseDetectionReport } from "../src/index.js";

function prospectiveReport() {
  return {
    contractVersion: "1.0",
    metadata: {
      reportId: "a".repeat(64),
      tenant: {
        tenantId: "tenant-1",
        tenantSlug: "ubuntu",
        displayName: "Ubuntu Medical Aid",
      },
      generatedAt: "2026-07-26T04:00:00+00:00",
      snapshotCutoff: "2026-07-26T04:00:00+00:00",
      source: {
        type: "mysql_prospective_claim_versions",
        watermark: "prospective:test",
        historicalWindow: {
          mode: "exact_gate_g_features",
          contextCutoffAt: "2026-07-26T04:00:00+00:00",
        },
        sourceJobIds: ["job-1"],
      },
      includedCounts: {
        claims: 1,
        providers: 1,
        members: 1,
      },
      includedDateRange: {
        from: "2026-07-20",
        to: "2026-07-20",
      },
      detectionEngineVersion: "prospective-baseline-consumer-1.0.0",
      producerVersion: "report-producer-0.5.0",
      generationCorrelationId: "correlation-1",
      detectionStrategy: {
        detectionStrategyId: 2,
        strategyType: "approved_model",
      },
      model: {
        deploymentId: "claimguard-claim-fraud-baseline:1.0.0",
        modelId: "claimguard-claim-fraud-baseline",
        modelVersion: "1.0.0",
        featureSchemaVersion: "claim-feature-schema-2026.2",
        analysisMode: "PROSPECTIVE_CLAIM_SCREENING",
        requestId: "screen-request-1",
        riskScoreBasis: "THRESHOLD_NORMALIZED_BASELINE",
      },
    },
    summary: {
      totalClaims: 1,
      totalClaimedAmount: 650,
      highRiskClaims: 1,
      flaggedProviders: 1,
      flaggedMembers: 1,
      activeFraudPatterns: 1,
      averageRiskScore: 100,
      riskDistribution: { low: 0, medium: 0, high: 1 },
    },
    claims: [
      {
        claimId: "C1",
        claimVersion: 1,
        providerId: "P1",
        memberId: "M1",
        schemeId: "U1",
        serviceDate: "2026-07-20",
        amount: 650,
        riskScore: 100,
        severity: "High",
        reasons: ["Prospective baseline model reached its review threshold"],
        ruleHits: [],
        evidenceReferences: [],
        processingStatus: "REVIEW_RECOMMENDED",
        modelReview: {
          fraudProbability: 0.9,
          predictedClass: "FRAUD",
          threshold: 0.08760971001434723,
          reviewRecommended: true,
        },
      },
    ],
    providers: [
      { providerId: "P1", riskScore: 100, severity: "High" },
    ],
    members: [
      { memberId: "M1", riskScore: 100, severity: "High" },
    ],
    graph: {
      nodes: [
        { entity_id: "claimant:M1" },
        { entity_id: "provider:P1" },
      ],
      edges: [
        {
          source_entity_id: "claimant:M1",
          target_entity_id: "provider:P1",
        },
      ],
      summary: {},
    },
    risk: {
      riskScore: 100,
      severity: "High",
      reasons: ["1 claim(s) require prospective baseline review"],
      highRiskClaims: 1,
      activeFraudPatterns: 1,
    },
    history: {},
  };
}

test("prospective ML report validates without retrospective component fields", () => {
  const report = prospectiveReport();
  const parsed = parseDetectionReport(report, "tenant-1");

  assert.equal(parsed.metadata.model.analysisMode, "PROSPECTIVE_CLAIM_SCREENING");
  assert.equal(parsed.claims[0].modelReview.fraudProbability, 0.9);
  assert.equal("ringProbability" in parsed.claims[0].modelReview, false);
});

test("prospective ML decision must match its fitted threshold", () => {
  const report = prospectiveReport();
  report.claims[0].modelReview.reviewRecommended = false;

  assert.throws(
    () => parseDetectionReport(report, "tenant-1"),
    /Prospective ML decisions must match the published threshold/,
  );
});
