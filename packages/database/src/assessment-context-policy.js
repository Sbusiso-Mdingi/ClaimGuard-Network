import crypto from "node:crypto";

export const CORRECTION_IMPACT_CLASS = Object.freeze({
  DISPLAY_ONLY: "DISPLAY_ONLY",
  IDENTITY_LINKAGE: "IDENTITY_LINKAGE",
  MODEL_AFFECTING: "MODEL_AFFECTING",
  ELIGIBILITY_AFFECTING: "ELIGIBILITY_AFFECTING",
  NOTICE_AFFECTING: "NOTICE_AFFECTING",
  SECURITY_SENSITIVE: "SECURITY_SENSITIVE",
});

export const ASSESSMENT_IMPACT = Object.freeze({
  NO_REASSESSMENT: "NO_REASSESSMENT",
  REASSESSMENT_REQUIRED: "REASSESSMENT_REQUIRED",
  IDENTITY_REVIEW_REQUIRED: "IDENTITY_REVIEW_REQUIRED",
  HUMAN_IMPACT_REVIEW_REQUIRED: "HUMAN_IMPACT_REVIEW_REQUIRED",
  SECURITY_REVIEW_REQUIRED: "SECURITY_REVIEW_REQUIRED",
});

const MEMBER_POLICY = Object.freeze({
  first_name: [CORRECTION_IMPACT_CLASS.IDENTITY_LINKAGE],
  last_name: [CORRECTION_IMPACT_CLASS.IDENTITY_LINKAGE],
  date_of_birth: [CORRECTION_IMPACT_CLASS.MODEL_AFFECTING],
  gender: [CORRECTION_IMPACT_CLASS.MODEL_AFFECTING],
  identity_number: [CORRECTION_IMPACT_CLASS.IDENTITY_LINKAGE, CORRECTION_IMPACT_CLASS.NOTICE_AFFECTING],
  banking_detail: [CORRECTION_IMPACT_CLASS.SECURITY_SENSITIVE],
  home_region: [CORRECTION_IMPACT_CLASS.MODEL_AFFECTING],
  home_lat: [CORRECTION_IMPACT_CLASS.MODEL_AFFECTING],
  home_lon: [CORRECTION_IMPACT_CLASS.MODEL_AFFECTING],
  join_date: [CORRECTION_IMPACT_CLASS.MODEL_AFFECTING, CORRECTION_IMPACT_CLASS.ELIGIBILITY_AFFECTING],
});

const PROVIDER_POLICY = Object.freeze({
  practice_number: [CORRECTION_IMPACT_CLASS.IDENTITY_LINKAGE, CORRECTION_IMPACT_CLASS.NOTICE_AFFECTING],
  specialty: [CORRECTION_IMPACT_CLASS.MODEL_AFFECTING],
  practice_name: [CORRECTION_IMPACT_CLASS.DISPLAY_ONLY],
  banking_detail: [CORRECTION_IMPACT_CLASS.SECURITY_SENSITIVE],
  practice_region: [CORRECTION_IMPACT_CLASS.MODEL_AFFECTING],
  practice_lat: [CORRECTION_IMPACT_CLASS.MODEL_AFFECTING],
  practice_lon: [CORRECTION_IMPACT_CLASS.MODEL_AFFECTING],
  provider_kind: [CORRECTION_IMPACT_CLASS.MODEL_AFFECTING],
  provider_category: [CORRECTION_IMPACT_CLASS.MODEL_AFFECTING],
});

const STABLE_IDENTITY_FIELDS = Object.freeze(new Set([
  "tenant_id", "scheme_id", "member_id", "provider_id",
]));

export class AssessmentContextPolicyError extends Error {
  constructor(code, message, details = null) {
    super(message);
    this.name = "AssessmentContextPolicyError";
    this.code = code;
    this.details = details;
  }
}

function canonicalValue(value) {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value && typeof value === "object" && !(value instanceof Date)) {
    return Object.fromEntries(
      Object.keys(value).sort().map((key) => [key, canonicalValue(value[key])]),
    );
  }
  if (value instanceof Date) return value.toISOString();
  return value;
}

export function canonicalJson(value) {
  return JSON.stringify(canonicalValue(value));
}

export function sha256CanonicalJson(value) {
  return crypto.createHash("sha256").update(canonicalJson(value)).digest("hex");
}

export function changedFields(previous, next, { ignoredFields = [] } = {}) {
  const ignored = new Set(ignoredFields);
  return [...new Set([...Object.keys(previous || {}), ...Object.keys(next || {})])]
    .filter((field) => !ignored.has(field))
    .filter((field) => canonicalJson(previous?.[field]) !== canonicalJson(next?.[field]))
    .sort();
}

export function classifyCorrectionFields(entityType, fields) {
  const type = String(entityType || "").trim().toUpperCase();
  const policy = type === "MEMBER" ? MEMBER_POLICY : type === "PROVIDER" ? PROVIDER_POLICY : null;
  if (!policy) {
    throw new AssessmentContextPolicyError(
      "CORRECTION_ENTITY_TYPE_INVALID",
      "Correction entity type must be MEMBER or PROVIDER.",
    );
  }

  const classifications = new Set();
  const unknownFields = [];
  const prohibitedFields = [];

  for (const field of [...new Set(fields || [])].sort()) {
    if (STABLE_IDENTITY_FIELDS.has(field)) {
      prohibitedFields.push(field);
      continue;
    }
    const assigned = policy[field];
    if (!assigned) {
      unknownFields.push(field);
      classifications.add(CORRECTION_IMPACT_CLASS.IDENTITY_LINKAGE);
      classifications.add(CORRECTION_IMPACT_CLASS.NOTICE_AFFECTING);
      continue;
    }
    assigned.forEach((value) => classifications.add(value));
  }

  if (prohibitedFields.length) {
    throw new AssessmentContextPolicyError(
      "CORRECTION_STABLE_IDENTITY_CHANGE_PROHIBITED",
      "Ordinary correction cannot change stable tenant, scheme or entity identity.",
      { fields: prohibitedFields },
    );
  }

  const values = [...classifications].sort();
  const requiresReplacementAssessment = values.some((value) => [
    CORRECTION_IMPACT_CLASS.MODEL_AFFECTING,
    CORRECTION_IMPACT_CLASS.ELIGIBILITY_AFFECTING,
    CORRECTION_IMPACT_CLASS.IDENTITY_LINKAGE,
  ].includes(value));
  const requiresHumanReview = unknownFields.length > 0 || values.some((value) => [
    CORRECTION_IMPACT_CLASS.IDENTITY_LINKAGE,
    CORRECTION_IMPACT_CLASS.ELIGIBILITY_AFFECTING,
    CORRECTION_IMPACT_CLASS.NOTICE_AFFECTING,
    CORRECTION_IMPACT_CLASS.SECURITY_SENSITIVE,
  ].includes(value));

  let assessmentImpact = ASSESSMENT_IMPACT.NO_REASSESSMENT;
  if (values.includes(CORRECTION_IMPACT_CLASS.SECURITY_SENSITIVE)) {
    assessmentImpact = ASSESSMENT_IMPACT.SECURITY_REVIEW_REQUIRED;
  } else if (values.includes(CORRECTION_IMPACT_CLASS.IDENTITY_LINKAGE)) {
    assessmentImpact = ASSESSMENT_IMPACT.IDENTITY_REVIEW_REQUIRED;
  } else if (values.includes(CORRECTION_IMPACT_CLASS.ELIGIBILITY_AFFECTING)
      || values.includes(CORRECTION_IMPACT_CLASS.NOTICE_AFFECTING)
      || unknownFields.length) {
    assessmentImpact = ASSESSMENT_IMPACT.HUMAN_IMPACT_REVIEW_REQUIRED;
  } else if (values.includes(CORRECTION_IMPACT_CLASS.MODEL_AFFECTING)) {
    assessmentImpact = ASSESSMENT_IMPACT.REASSESSMENT_REQUIRED;
  }

  return Object.freeze({
    classifications: Object.freeze(values),
    assessmentImpact,
    requiresReplacementAssessment,
    requiresHumanReview,
    unknownFields: Object.freeze(unknownFields.sort()),
  });
}

export function publicMemberAssessmentPayload(version) {
  return Object.freeze({
    member_id: version.member_id,
    member_version: Number(version.member_version),
    scheme_id: version.scheme_id,
    first_name: version.first_name,
    last_name: version.last_name,
    date_of_birth: version.date_of_birth,
    gender: version.gender,
    identity_number: version.identity_number,
    home_region: version.home_region,
    home_lat: version.home_lat,
    home_lon: version.home_lon,
    join_date: version.join_date,
  });
}

export function publicProviderAssessmentPayload(version) {
  return Object.freeze({
    provider_id: version.provider_id,
    provider_version: Number(version.provider_version),
    scheme_id: version.scheme_id,
    practice_number: version.practice_number,
    specialty: version.specialty,
    practice_name: version.practice_name,
    practice_region: version.practice_region,
    practice_lat: version.practice_lat,
    practice_lon: version.practice_lon,
    provider_kind: version.provider_kind,
    provider_category: version.provider_category,
  });
}
