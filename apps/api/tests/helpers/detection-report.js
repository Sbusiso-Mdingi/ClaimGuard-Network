export function createCanonicalDetectionReport({
  tenantId = "tenant_default",
  version = "test-v1",
  riskScore = null,
  severity = null,
  reasons = [],
  nodes = [],
  edges = [],
} = {}) {
  const reportId = Buffer.from(`${tenantId}:${version}`).toString("hex").padEnd(64, "0").slice(0, 64);
  return {
    contractVersion: "1.0",
    metadata: {
      reportId,
      tenant: { tenantId, tenantSlug: null, displayName: null },
      generatedAt: "2026-07-16T00:00:00.000Z",
      snapshotCutoff: "2026-07-16T00:00:00.000Z",
      source: { type: "test", watermark: version, historicalWindow: null },
      includedCounts: { claims: 0, providers: 0, members: 0 },
      includedDateRange: { from: null, to: null },
      detectionEngineVersion: "test",
      producerVersion: "test",
      generationCorrelationId: "test",
    },
    summary: {
      totalClaims: 0,
      totalClaimedAmount: 0,
      highRiskClaims: 0,
      flaggedProviders: 0,
      flaggedMembers: 0,
      activeFraudPatterns: 0,
      averageRiskScore: riskScore,
      riskDistribution: { low: 0, medium: 0, high: 0 },
    },
    claims: [],
    providers: [],
    members: [],
    graph: {
      nodes,
      edges,
      summary: { entity_count: nodes.length, relationship_count: edges.length },
    },
    risk: { riskScore, severity, reasons, highRiskClaims: 0, activeFraudPatterns: 0 },
    history: {},
  };
}

export function createCanonicalModelDetectionReport({
  tenantId = "tenant_default",
  watermark = "model-window-1",
  deploymentId = "claim-fraud-ensemble-1.1.0",
} = {}) {
  const report = createCanonicalDetectionReport({
    tenantId,
    version: watermark,
    riskScore: 100,
    severity: "High",
    reasons: ["1 claim(s) require learned-model review"],
    nodes: [
      { entity_id: "claimant:M-1", entity_type: "claimant" },
      { entity_id: "provider:P-1", entity_type: "provider" },
    ],
    edges: [{
      source_entity_id: "claimant:M-1",
      target_entity_id: "provider:P-1",
      relationship_type: "submitted_to",
      claim_id: "C-1",
    }],
  });
  report.metadata.model = {
    deploymentId,
    ensembleId: "claimguard-claim-fraud-ensemble",
    ensembleVersion: "1.1.0",
    featureSchemaVersion: "claim-feature-schema-2026.2",
    analysisMode: "RETROSPECTIVE_CLOSED_WINDOW_REVIEW",
    requestId: "review-request-1",
    riskScoreBasis: "THRESHOLD_NORMALIZED_MAX_COMPONENT",
  };
  report.metadata.includedCounts = { claims: 1, providers: 1, members: 1 };
  report.metadata.includedDateRange = { from: "2026-07-20", to: "2026-07-20" };
  report.claims = [{
    claimId: "C-1",
    providerId: "P-1",
    memberId: "M-1",
    schemeId: "scheme_a",
    serviceDate: "2026-07-20",
    amount: 650,
    riskScore: 100,
    severity: "High",
    reasons: ["Baseline learned detector reached its review threshold"],
    ruleHits: [],
    evidenceReferences: [],
    processingStatus: "REVIEW_RECOMMENDED",
    modelReview: {
      baselineFraudProbability: 0.9,
      baselinePredictedClass: "FRAUD",
      baselineThreshold: 0.08760971001434723,
      ringProbability: 0.01,
      ringReviewHit: false,
      ringThreshold: 0.148,
      phantomProbability: 0.1,
      phantomReviewHit: false,
      phantomThreshold: 0.8138303120761656,
      compositeReviewRecommended: true,
    },
  }];
  report.providers = [{
    providerId: "P-1",
    riskScore: 100,
    severity: "High",
  }];
  report.members = [{
    memberId: "M-1",
    riskScore: 100,
    severity: "High",
  }];
  report.summary = {
    totalClaims: 1,
    totalClaimedAmount: 650,
    highRiskClaims: 1,
    flaggedProviders: 1,
    flaggedMembers: 1,
    activeFraudPatterns: 1,
    averageRiskScore: 100,
    riskDistribution: { low: 0, medium: 0, high: 1 },
  };
  report.risk.highRiskClaims = 1;
  report.risk.activeFraudPatterns = 1;
  report.history = {
    ruleExecution: {
      triggeredRules: [],
      triggeredRuleCount: 0,
      notExecuted: true,
    },
    modelExecution: {
      deploymentId,
      windowWatermark: watermark,
    },
  };
  return report;
}
