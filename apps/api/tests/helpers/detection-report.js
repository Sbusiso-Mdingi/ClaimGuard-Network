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
