const demoReport = {
  schemes: [
    {
      scheme_id: "A",
      provider_count: 12,
      claim_count: 24,
      member_count: 18,
      summary: {
        provider_score_median: 71,
        member_score_median: 48,
      },
      provider_findings: [
        {
          entity_id: "provider:P-102",
          score: 94,
          metrics: {
            claim_count: 9,
            total_amount: 184200,
            average_amount: 20466,
          },
          reasons: ["Shared bank account with another flagged provider", "High-frequency same-day billing"],
        },
      ],
      member_findings: [
        {
          entity_id: "claimant:Alex Morgan",
          score: 87,
          metrics: {
            claim_count: 4,
            total_amount: 64200,
            average_amount: 16050,
          },
          reasons: ["Repeat claimant pattern across linked providers"],
        },
      ],
    },
    {
      scheme_id: "B",
      provider_count: 10,
      claim_count: 20,
      member_count: 16,
      summary: {
        provider_score_median: 63,
        member_score_median: 45,
      },
      provider_findings: [],
      member_findings: [],
    },
    {
      scheme_id: "C",
      provider_count: 8,
      claim_count: 14,
      member_count: 11,
      summary: {
        provider_score_median: 58,
        member_score_median: 39,
      },
      provider_findings: [],
      member_findings: [],
    },
  ],
  detection: {
    relationships: [
      {
        source_entity_id: "claimant:Alex Morgan",
        target_entity_id: "provider:P-102",
        relationship_type: "submitted_to",
        claim_id: "CLM-001",
      },
      {
        source_entity_id: "provider:P-102",
        target_entity_id: "bank:ACC-7421",
        relationship_type: "payout_to",
        claim_id: "CLM-001",
      },
      {
        source_entity_id: "claimant:Blair Ndlovu",
        target_entity_id: "provider:P-102",
        relationship_type: "submitted_to",
        claim_id: "CLM-002",
      },
      {
        source_entity_id: "provider:P-301",
        target_entity_id: "bank:ACC-7421",
        relationship_type: "payout_to",
        claim_id: "CLM-003",
      },
      {
        source_entity_id: "claimant:Casey Taylor",
        target_entity_id: "provider:P-301",
        relationship_type: "submitted_to",
        claim_id: "CLM-003",
      },
      {
        source_entity_id: "claimant:Drew Khan",
        target_entity_id: "provider:P-450",
        relationship_type: "submitted_to",
        claim_id: "CLM-004",
      },
    ],
    triggered_rules: [
      {
        rule_id: "R-01",
        title: "Shared bank account across providers",
        weight: 11,
        evidence: ["bank:ACC-7421", "provider:P-102", "provider:P-301"],
      },
      {
        rule_id: "R-02",
        title: "High-frequency repeat billing",
        weight: 9,
        evidence: ["claimant:Alex Morgan", "claimant:Blair Ndlovu"],
      },
      {
        rule_id: "R-03",
        title: "Cross-scheme provider reuse",
        weight: 8,
        evidence: ["provider:P-102", "scheme:A", "scheme:B"],
      },
    ],
    evidence: [
      "provider:P-102 and provider:P-301 resolve to the same bank account",
      "CLM-001 and CLM-002 show repeated billing against the same provider",
      "The fraud ring spans two scheme partitions and one shared payout destination",
    ],
    risk_score: {
      riskScore: 82,
      severity: "High",
      highRiskClaims: 3,
      activeFraudSchemes: 2,
    },
    ledger_reference: {
      available: true,
      entry: {
        entryType: "INVESTIGATOR_CONFIRMED_FRAUD",
      },
    },
  },
};

const demoGraph = {
  entities: [
    { entity_id: "claimant:Alex Morgan", entity_type: "claimant", value: "Alex Morgan" },
    { entity_id: "provider:P-102", entity_type: "provider", value: "Northbridge Clinic" },
    { entity_id: "bank:ACC-7421", entity_type: "bank_account", value: "ACC-7421" },
    { entity_id: "claimant:Blair Ndlovu", entity_type: "claimant", value: "Blair Ndlovu" },
    { entity_id: "provider:P-301", entity_type: "provider", value: "Harbor Family Care" },
    { entity_id: "claimant:Casey Taylor", entity_type: "claimant", value: "Casey Taylor" },
    { entity_id: "claimant:Drew Khan", entity_type: "claimant", value: "Drew Khan" },
    { entity_id: "provider:P-450", entity_type: "provider", value: "Crescent Wellness" },
  ],
  relationships: demoReport.detection.relationships,
  summary: {
    providerNodes: 3,
    claimantNodes: 4,
    linkCount: demoReport.detection.relationships.length,
  },
};

const demoRisk = {
  riskScore: 82,
  severity: "High",
  highRiskClaims: 3,
  reasons: [
    "Shared bank account links the highest-risk provider nodes across schemes.",
    "The submitted claims repeat in a pattern that matches the duplicate billing rule.",
    "Cross-scheme reuse indicates an organized evasion pattern rather than isolated fraud.",
  ],
};

const demoClaims = [
  {
    claimId: "CLM-001",
    riskScore: 96,
    severity: "High",
    status: "CONFIRMED_FRAUD",
    policyHolder: "Alex Morgan",
    detectionDate: "2026-07-12T09:30:00.000Z",
    triggeredRules: ["Shared bank account across providers", "High-frequency repeat billing"],
    evidence: demoReport.detection.evidence,
  },
  {
    claimId: "CLM-002",
    riskScore: 88,
    severity: "High",
    status: "UNDER_INVESTIGATION",
    policyHolder: "Blair Ndlovu",
    detectionDate: "2026-07-12T09:30:00.000Z",
    triggeredRules: ["High-frequency repeat billing", "Cross-scheme provider reuse"],
    evidence: demoReport.detection.evidence,
  },
  {
    claimId: "CLM-003",
    riskScore: 75,
    severity: "Medium",
    status: "UNDER_INVESTIGATION",
    policyHolder: "Casey Taylor",
    detectionDate: "2026-07-12T09:30:00.000Z",
    triggeredRules: ["Shared bank account across providers"],
    evidence: demoReport.detection.evidence,
  },
  {
    claimId: "CLM-004",
    riskScore: 41,
    severity: "Low",
    status: "DISMISSED",
    policyHolder: "Drew Khan",
    detectionDate: "2026-07-12T09:30:00.000Z",
    triggeredRules: ["Baseline screening only"],
    evidence: ["No corroborating evidence was found during review."],
  },
];

const demoSnapshots = [
  {
    id: "demo-2026-07-12T09:30:00.000Z-4",
    timestamp: "2026-07-12T09:30:00.000Z",
    totalClaims: demoClaims.length,
    highRiskClaims: 3,
    avgRisk: 82,
    schemes: demoReport.schemes.length,
    risk: demoRisk,
    graphSummary: demoGraph.summary,
  },
];

export const demoInvestigatorArtifacts = {
  report: demoReport,
  graph: demoGraph,
  risk: demoRisk,
  claims: demoClaims,
  snapshots: demoSnapshots,
};