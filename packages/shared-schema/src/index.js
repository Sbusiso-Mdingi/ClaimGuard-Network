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
const forbiddenReportFieldNames = new Set([
  "firstname",
  "lastname",
  "dateofbirth",
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
