import { z } from "zod";

export const CASE_ACTION_VALUES = Object.freeze([
  "begin-triage",
  "dismiss",
  "begin-monitoring",
  "open-investigation",
  "record-notice",
  "record-response-pending",
  "begin-evidence-review",
  "complete-investigation-report",
  "submit-outcome-review",
  "approve-outcome",
  "close-unsubstantiated",
  "open-appeal-or-review",
  "return-for-further-evidence",
]);

export const caseActionSchema = z.enum(CASE_ACTION_VALUES);

export const PROHIBITED_CASE_REQUEST_FIELDS = Object.freeze([
  "tenantId",
  "tenant_id",
  "organisationId",
  "organizationId",
  "environment",
  "dataPlaneRoute",
  "actorId",
  "actor_id",
  "actorRole",
  "role",
  "roles",
  "permission",
  "permissions",
  "capability",
  "capabilities",
  "toState",
  "to_state",
  "currentState",
  "targetState",
  "target_state",
  "status",
  "networkNoticeStatus",
  "registryPublicationRequired",
  "paymentAction",
  "paymentStatus",
  "adjudicationAction",
  "adjudicationStatus",
]);

export const PROHIBITED_CASE_OUTCOME_CODES = Object.freeze([
  "CONFIRMED_FRAUD",
  "RED",
  "VERIFIED",
  "BLACKLISTED",
  "NETWORK_NOTICE_ACTIVE",
]);

const positiveStateVersion = z.number().int().min(1).max(2_147_483_647);
const stableCode = (maximum = 128) => z.string()
  .trim()
  .min(1)
  .max(maximum)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/, "Expected a stable machine-readable code.");
const boundedText = (maximum) => z.string().trim().min(1).max(maximum);
const reference = boundedText(255);
const references = z.array(reference).max(100).default([]);

const baseCaseActionRequestSchema = z.object({
  expectedStateVersion: positiveStateVersion,
  reasonCode: stableCode(128),
  reasonSummary: boundedText(1024),
}).strict();

const evidenceAwareFields = {
  evidenceReferences: references.optional(),
  processCheckReferences: references.optional(),
};

const simpleCaseActionRequestSchema = baseCaseActionRequestSchema.extend(evidenceAwareFields).strict();

const openInvestigationRequestSchema = simpleCaseActionRequestSchema.extend({
  assignedInvestigatorId: reference.optional(),
}).strict();

const completeInvestigationReportRequestSchema = baseCaseActionRequestSchema.extend({
  evidenceReferences: references.optional(),
  processCheckReferences: references.optional(),
  reportReference: reference.optional(),
  reportDigest: boundedText(255).optional(),
  noEvidenceReason: boundedText(1024).optional(),
  completionReason: stableCode(128),
}).strict().superRefine((request, context) => {
  if (!request.reportReference && !request.reportDigest) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "A report reference or immutable report digest is required.",
      path: ["reportReference"],
    });
  }
  if (!(request.evidenceReferences?.length > 0) && !request.noEvidenceReason) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Evidence references or an explicit no-evidence reason are required.",
      path: ["evidenceReferences"],
    });
  }
});

const submitOutcomeReviewRequestSchema = baseCaseActionRequestSchema.extend({
  evidenceReferences: references.optional(),
  processCheckReferences: z.array(reference).min(1).max(100),
}).strict();

const identityMatchReviewResultSchema = z.object({
  reviewed: z.literal(true),
  resultCode: stableCode(64),
  reviewReference: reference,
  summary: boundedText(1024).optional(),
}).strict();

const approveOutcomeRequestSchema = baseCaseActionRequestSchema.extend({
  outcomeCode: stableCode(64).refine(
    (value) => !PROHIBITED_CASE_OUTCOME_CODES.includes(value.toUpperCase()),
    "Legacy verdict and network-notice codes are not valid Sequrin outcome codes.",
  ),
  recordedReasons: z.array(boundedText(1024)).min(1).max(20),
  identityMatchReviewResult: identityMatchReviewResultSchema,
  supportingReportReference: reference,
  evidenceSetReference: reference,
  processCheckReferences: z.array(reference).min(1).max(100),
  processCheckComplete: z.literal(true),
}).strict();

export const caseActionRequestSchemas = Object.freeze({
  "begin-triage": simpleCaseActionRequestSchema,
  dismiss: simpleCaseActionRequestSchema,
  "begin-monitoring": simpleCaseActionRequestSchema,
  "open-investigation": openInvestigationRequestSchema,
  "record-notice": simpleCaseActionRequestSchema,
  "record-response-pending": simpleCaseActionRequestSchema,
  "begin-evidence-review": simpleCaseActionRequestSchema,
  "complete-investigation-report": completeInvestigationReportRequestSchema,
  "submit-outcome-review": submitOutcomeReviewRequestSchema,
  "approve-outcome": approveOutcomeRequestSchema,
  "close-unsubstantiated": simpleCaseActionRequestSchema,
  "open-appeal-or-review": simpleCaseActionRequestSchema,
  "return-for-further-evidence": simpleCaseActionRequestSchema,
});

export function getCaseActionRequestSchema(action) {
  return caseActionRequestSchemas[action] || null;
}

export function parseCaseActionRequest(action, payload) {
  const schema = getCaseActionRequestSchema(action);
  if (!schema) return null;
  return schema.parse(payload);
}

export const caseActionSuccessResponseSchema = z.object({
  caseId: reference,
  state: stableCode(64),
  stateVersion: positiveStateVersion,
  transitionEventId: reference,
  operationId: boundedText(64),
  correlationId: boundedText(128),
  replayed: z.boolean(),
}).strict();

export const caseActionErrorResponseSchema = z.object({
  available: z.literal(false),
  code: stableCode(128),
  message: boundedText(1024),
  correlationId: boundedText(128),
}).strict();
