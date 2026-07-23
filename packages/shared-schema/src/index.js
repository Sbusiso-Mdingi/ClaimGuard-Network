import { z } from "zod";

export const backendServiceNameSchema = z.literal("api");

export const backendHealthSchema = z.object({
  status: z.literal("ok"),
  service: backendServiceNameSchema,
  phase: z.literal("3"),
  timestamp: z.string(),
});

export const backendInfoSchema = z.object({
  service: backendServiceNameSchema,
  phase: z.literal("3"),
  name: z.string(),
});

export const trpcPingResponseSchema = z.object({
  service: backendServiceNameSchema,
  message: z.string(),
});

export function createBackendHealth(service = "api") {
  return backendHealthSchema.parse({
    status: "ok",
    service,
    phase: "3",
    timestamp: new Date().toISOString(),
  });
}

export function createBackendInfo(name = "ClaimGuard API") {
  return backendInfoSchema.parse({
    service: "api",
    phase: "3",
    name,
  });
}

const finiteNumber = z.number().finite();
const nullableFiniteNumber = finiteNumber.nullable();
const identifier = (maximum) => z.string().trim().min(1).max(maximum);
const dateOnly = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Expected an ISO calendar date (YYYY-MM-DD).").refine((value) => {
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}, "Expected a valid calendar date.");

export const claimIngestionSourceSchema = z.string()
  .trim()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/, "Source must be a stable machine identifier.");

export const claimIngestionSchemeSchema = z.object({
  scheme_id: identifier(64),
  scheme_name: z.string().trim().min(1).max(255),
}).strict();

export const claimIngestionMemberSchema = z.object({
  member_id: identifier(128),
  scheme_id: identifier(64),
  first_name: z.string().trim().min(1).max(128),
  last_name: z.string().trim().min(1).max(128),
  date_of_birth: dateOnly,
  gender: z.string().trim().min(1).max(32),
  identity_number: z.string().trim().min(1).max(128),
  banking_detail: z.string().trim().min(1).max(255),
  home_region: z.string().trim().min(1).max(128),
  home_lat: z.number().finite().min(-90).max(90),
  home_lon: z.number().finite().min(-180).max(180),
  join_date: dateOnly,
}).strict();

export const claimIngestionProviderSchema = z.object({
  provider_id: identifier(128),
  scheme_id: identifier(64),
  practice_number: z.string().trim().min(1).max(64),
  specialty: z.string().trim().min(1).max(128),
  practice_name: z.string().trim().min(1).max(255),
  banking_detail: z.string().trim().min(1).max(255),
  practice_region: z.string().trim().min(1).max(128),
  practice_lat: z.number().finite().min(-90).max(90),
  practice_lon: z.number().finite().min(-180).max(180),
  provider_kind: z.string().trim().min(1).max(64),
  provider_category: z.string().trim().min(1).max(128),
}).strict();

export const claimIngestionClaimSchema = z.object({
  claim_id: identifier(128),
  scheme_id: identifier(64),
  member_id: identifier(128),
  provider_id: identifier(128),
  service_date: dateOnly,
  received_date: dateOnly,
  billing_code: z.string().trim().min(1).max(64),
  amount: z.number().finite().positive().max(9_999_999_999.99),
  quantity: z.number().finite().positive().max(999_999_999.999),
  benefit_option: z.string().trim().min(1).max(128),
  network_type: z.string().trim().min(1).max(64),
  line_type: z.string().trim().min(1).max(64),
  tariff_discipline: z.string().trim().min(1).max(128),
  diagnosis_code: z.string().trim().min(1).max(32),
  rendering_practitioner_id: identifier(128).nullable(),
  rendering_practitioner_category: z.string().trim().min(1).max(128),
  rendering_known_to_billing_provider: z.boolean(),
}).strict().superRefine((claim, context) => {
  if (claim.received_date < claim.service_date) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["received_date"],
      message: "received_date cannot precede service_date.",
    });
  }
  const noRenderingPractitioner = claim.rendering_practitioner_id === null;
  if (noRenderingPractitioner && (
    claim.rendering_practitioner_category !== "NONE"
    || claim.rendering_known_to_billing_provider
  )) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["rendering_practitioner_id"],
      message: "Missing rendering practitioners must use category NONE and known=false.",
    });
  }
  if (!noRenderingPractitioner && claim.rendering_practitioner_category === "NONE") {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["rendering_practitioner_category"],
      message: "A rendering practitioner cannot use category NONE.",
    });
  }
});

export function createClaimIngestionBatchSchema({ maxBatchSize = 500, maxReferenceRecords = 2_000 } = {}) {
  return z.object({
    source: claimIngestionSourceSchema.default("api"),
    schemes: z.array(claimIngestionSchemeSchema).max(maxReferenceRecords).default([]),
    members: z.array(claimIngestionMemberSchema).max(maxReferenceRecords).default([]),
    providers: z.array(claimIngestionProviderSchema).max(maxReferenceRecords).default([]),
    claims: z.array(claimIngestionClaimSchema).min(1).max(maxBatchSize),
  }).strict().superRefine((batch, context) => {
    const collections = [
      ["schemes", "scheme_id"],
      ["members", "member_id"],
      ["providers", "provider_id"],
      ["claims", "claim_id"],
    ];
    for (const [collectionName, idField] of collections) {
      const seen = new Set();
      batch[collectionName].forEach((record, index) => {
        if (seen.has(record[idField])) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: [collectionName, index, idField],
            message: `${idField} must be unique within an ingestion batch.`,
          });
        }
        seen.add(record[idField]);
      });
    }

    const members = new Map(batch.members.map((member) => [member.member_id, member]));
    const providers = new Map(batch.providers.map((provider) => [provider.provider_id, provider]));
    batch.claims.forEach((claim, index) => {
      const member = members.get(claim.member_id);
      const provider = providers.get(claim.provider_id);
      if (member && member.scheme_id !== claim.scheme_id) {
        context.addIssue({ code: z.ZodIssueCode.custom, path: ["claims", index, "member_id"], message: "Embedded member and claim must belong to the same scheme." });
      }
      if (provider && provider.scheme_id !== claim.scheme_id) {
        context.addIssue({ code: z.ZodIssueCode.custom, path: ["claims", index, "provider_id"], message: "Embedded provider and claim must belong to the same scheme." });
      }
    });
  });
}

export function parseClaimIngestionBatch(payload, options) {
  return createClaimIngestionBatchSchema(options).parse(payload);
}
const forbiddenReportFieldNames = new Set([
  "firstname",
  "lastname",
  "dateofbirth",
  "identitynumber",
  "bankingdetail",
  "syntheticidnumber",
  "syntheticbankingdetail",
  "bankaccount",
  "email",
  "phone",
  "address",
  "ipaddress",
  "deviceid",
]);

export const detectionReportContractVersion = "1.0";

const modelReviewSchema = z.object({
  baselineFraudProbability: finiteNumber.min(0).max(1),
  baselinePredictedClass: z.enum(["LEGITIMATE", "FRAUD"]),
  baselineThreshold: finiteNumber.min(0).max(1),
  ringProbability: finiteNumber.min(0).max(1),
  ringReviewHit: z.boolean(),
  ringThreshold: finiteNumber.min(0).max(1),
  phantomProbability: finiteNumber.min(0).max(1),
  phantomReviewHit: z.boolean(),
  phantomThreshold: finiteNumber.min(0).max(1),
  compositeReviewRecommended: z.boolean(),
}).strict().superRefine((review, context) => {
  const baselineHit = review.baselineFraudProbability >= review.baselineThreshold;
  const ringHit = review.ringProbability >= review.ringThreshold;
  const phantomHit = review.phantomProbability >= review.phantomThreshold;
  if (
    (review.baselinePredictedClass === "FRAUD") !== baselineHit
    || review.ringReviewHit !== ringHit
    || review.phantomReviewHit !== phantomHit
    || review.compositeReviewRecommended !== (baselineHit || ringHit || phantomHit)
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Model decisions must match the published thresholds.",
    });
  }
});

const canonicalClaimSchema = z.object({
  claimId: z.string().min(1),
  providerId: z.string().min(1),
  memberId: z.string().min(1),
  schemeId: z.string().min(1),
  serviceDate: z.string().min(1),
  amount: finiteNumber,
  riskScore: finiteNumber,
  severity: z.enum(["Low", "Medium", "High"]),
  reasons: z.array(z.string()),
  ruleHits: z.array(z.object({ ruleId: z.string(), title: z.string(), weight: finiteNumber })),
  evidenceReferences: z.array(z.unknown()),
  processingStatus: z.string().nullable(),
  modelReview: modelReviewSchema.optional(),
}).strict();

const graphNodeSchema = z.object({ entity_id: z.string().min(1) }).passthrough();
const graphEdgeSchema = z.object({
  source_entity_id: z.string().min(1),
  target_entity_id: z.string().min(1),
}).passthrough();

export const detectionReportSchema = z.object({
  contractVersion: z.literal(detectionReportContractVersion),
  metadata: z.object({
    reportId: z.string().regex(/^[a-f0-9]{64}$/),
    tenant: z.object({
      tenantId: z.string().min(1),
      tenantSlug: z.string().nullable(),
      displayName: z.string().nullable(),
    }).strict(),
    generatedAt: z.string().datetime({ offset: true }),
    snapshotCutoff: z.string().datetime({ offset: true }),
    source: z.object({
      type: z.string().min(1),
      watermark: z.string().min(1),
      historicalWindow: z.record(z.unknown()).nullable(),
    }).strict(),
    includedCounts: z.object({ claims: z.number().int().nonnegative(), providers: z.number().int().nonnegative(), members: z.number().int().nonnegative() }).strict(),
    includedDateRange: z.object({ from: z.string().nullable(), to: z.string().nullable() }).strict(),
    detectionEngineVersion: z.string().min(1),
    producerVersion: z.string().min(1),
    generationCorrelationId: z.string(),
    model: z.object({
      deploymentId: identifier(128),
      ensembleId: identifier(128),
      ensembleVersion: identifier(64),
      featureSchemaVersion: identifier(128),
      analysisMode: z.literal("RETROSPECTIVE_CLOSED_WINDOW_REVIEW"),
      requestId: identifier(128),
      riskScoreBasis: z.literal("THRESHOLD_NORMALIZED_MAX_COMPONENT"),
    }).strict().optional(),
  }).strict(),
  summary: z.object({
    totalClaims: z.number().int().nonnegative(),
    totalClaimedAmount: finiteNumber,
    highRiskClaims: z.number().int().nonnegative(),
    flaggedProviders: z.number().int().nonnegative(),
    flaggedMembers: z.number().int().nonnegative(),
    activeFraudPatterns: z.number().int().nonnegative(),
    averageRiskScore: nullableFiniteNumber,
    riskDistribution: z.object({ low: z.number().int().nonnegative(), medium: z.number().int().nonnegative(), high: z.number().int().nonnegative() }).strict(),
  }).strict(),
  claims: z.array(canonicalClaimSchema),
  providers: z.array(z.object({ providerId: z.string().min(1), riskScore: finiteNumber, severity: z.enum(["Low", "Medium", "High"]) }).passthrough()),
  members: z.array(z.object({ memberId: z.string().min(1), riskScore: finiteNumber, severity: z.enum(["Low", "Medium", "High"]) }).passthrough()),
  graph: z.object({
    nodes: z.array(graphNodeSchema),
    edges: z.array(graphEdgeSchema),
    summary: z.record(z.unknown()),
  }).strict(),
  risk: z.object({
    riskScore: nullableFiniteNumber,
    severity: z.enum(["Low", "Medium", "High"]).nullable(),
    reasons: z.array(z.string()),
    highRiskClaims: z.number().int().nonnegative(),
    activeFraudPatterns: z.number().int().nonnegative(),
  }).strict(),
  history: z.record(z.unknown()),
}).strict().superRefine((report, context) => {
  const counts = report.metadata.includedCounts;
  if (counts.claims !== report.claims.length || counts.providers !== report.providers.length || counts.members !== report.members.length || report.summary.totalClaims !== report.claims.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Report aggregate counts do not match entity arrays." });
  }
  const nodeIds = new Set(report.graph.nodes.map((node) => node.entity_id));
  if (report.graph.edges.some((edge) => !nodeIds.has(edge.source_entity_id) || !nodeIds.has(edge.target_entity_id))) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Report graph references an unknown node." });
  }
  const totalClaimedAmount = Math.round(report.claims.reduce((sum, claim) => sum + claim.amount, 0) * 100) / 100;
  if (report.summary.totalClaimedAmount !== totalClaimedAmount) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Report total claimed amount is inconsistent." });
  }
  if (report.summary.riskDistribution.low + report.summary.riskDistribution.medium + report.summary.riskDistribution.high !== report.claims.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Report risk distribution is inconsistent." });
  }
  if (report.metadata.model && report.claims.some((claim) => !claim.modelReview)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Model reports require modelReview on every claim." });
  }
  if (!report.metadata.model && report.claims.some((claim) => claim.modelReview)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Deterministic reports cannot contain modelReview results." });
  }
});

export function parseDetectionReport(report, expectedTenantId) {
  const parsed = detectionReportSchema.parse(report);
  const inspectScopeAndPrivacy = (value, path = "report") => {
    if (Array.isArray(value)) {
      value.forEach((item, index) => inspectScopeAndPrivacy(item, `${path}[${index}]`));
      return;
    }
    if (!value || typeof value !== "object") {
      return;
    }
    for (const [key, item] of Object.entries(value)) {
      const normalizedKey = key.toLowerCase().replace(/[^a-z0-9]/g, "");
      if (forbiddenReportFieldNames.has(normalizedKey)) {
        throw new Error(`${path}.${key} is not permitted in a shared report artifact.`);
      }
      if ((key === "tenantId" || key === "tenant_id") && item !== expectedTenantId) {
        throw new Error(`${path}.${key} is outside the authenticated tenant scope.`);
      }
      inspectScopeAndPrivacy(item, `${path}.${key}`);
    }
  };
  if (parsed.metadata.tenant.tenantId !== expectedTenantId) {
    throw new Error("Report tenant does not match the authenticated tenant.");
  }
  inspectScopeAndPrivacy(parsed);
  return parsed;
}
