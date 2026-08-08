import crypto from "node:crypto";

import {
  changedFields,
  classifyCorrectionFields,
  publicMemberAssessmentPayload,
  publicProviderAssessmentPayload,
  sha256CanonicalJson,
} from "./assessment-context-policy.js";

const DETERMINISTIC_RULE_VERSION = "claimguard.deterministic-request.v1";
const ASSESSMENT_SNAPSHOT_SCHEMA = "sequrin.assessment-input.v1";
const OUTBOX_PAYLOAD_SCHEMA_VERSION = 3;
const EXPLICIT_REASSESSMENT_OPERATION = "EXPLICIT_REASSESSMENT";
const MEMBER_CORRECTION_OPERATION = "MEMBER_CORRECTION";
const PROVIDER_CORRECTION_OPERATION = "PROVIDER_CORRECTION";
const CORRECTION_REVIEW_STATUS = new Set(["PENDING", "IN_REVIEW", "COMPLETED"]);

export class AssessmentContextRepositoryError extends Error {
  constructor(code, message, status = 409, details = null) {
    super(message);
    this.name = "AssessmentContextRepositoryError";
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

function requireExecutor(connection) {
  if (!connection || typeof connection.execute !== "function") {
    throw new TypeError("A MySQL-compatible transaction executor is required.");
  }
  return connection;
}

function normalizedDate(value) {
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value ?? "").slice(0, 10);
}

function normalizedDecimal(value) {
  return Number(value);
}

function memberPayload(value) {
  return {
    scheme_id: String(value.scheme_id),
    first_name: String(value.first_name),
    last_name: String(value.last_name),
    date_of_birth: normalizedDate(value.date_of_birth),
    gender: String(value.gender),
    identity_number: String(value.identity_number),
    banking_detail: String(value.banking_detail),
    home_region: String(value.home_region),
    home_lat: normalizedDecimal(value.home_lat),
    home_lon: normalizedDecimal(value.home_lon),
    join_date: normalizedDate(value.join_date),
  };
}

function providerPayload(value) {
  return {
    scheme_id: String(value.scheme_id),
    practice_number: String(value.practice_number),
    specialty: String(value.specialty),
    practice_name: String(value.practice_name),
    banking_detail: String(value.banking_detail),
    practice_region: String(value.practice_region),
    practice_lat: normalizedDecimal(value.practice_lat),
    practice_lon: normalizedDecimal(value.practice_lon),
    provider_kind: String(value.provider_kind),
    provider_category: String(value.provider_category),
  };
}

async function appendCorrectionReviewEvent(connection, {
  tenantId,
  reviewId,
  eventType,
  statusBefore = null,
  statusAfter,
  stateVersionBefore = null,
  stateVersionAfter,
  actorId,
  correlationId,
  payload = {},
}) {
  await connection.execute(
    `INSERT INTO correction_impact_review_events (
       review_event_id, tenant_id, review_id, event_type,
       review_status_before, review_status_after,
       state_version_before, state_version_after,
       actor_id, correlation_id, event_payload
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      crypto.randomUUID(), tenantId, reviewId, eventType,
      statusBefore, statusAfter, stateVersionBefore, stateVersionAfter,
      actorId, correlationId || crypto.randomUUID(), JSON.stringify(payload),
    ],
  );
}

async function correctionReviewRows(connection, {
  tenantId,
  correctionEventId,
  entityType,
  entityId,
  previousVersion,
  reviewReason,
  actorId,
  correlationId,
}) {
  const versionPredicate = entityType === "MEMBER"
    ? "a.member_id = ? AND a.member_version = ?"
    : "a.provider_id = ? AND a.provider_version = ?";

  const [affected] = await connection.execute(
    `SELECT
       a.assessment_id,
       s.signal_id,
       c.case_id
     FROM assessment_versions a
     LEFT JOIN detection_signals s
       ON s.tenant_id = a.tenant_id
      AND s.assessment_id = a.assessment_id
     LEFT JOIN investigation_cases c
       ON c.tenant_id = s.tenant_id
      AND c.signal_id = s.signal_id
     WHERE a.tenant_id = ?
       AND ${versionPredicate}
     ORDER BY a.created_at ASC, a.assessment_id ASC`,
    [tenantId, entityId, previousVersion],
  );

  if (!affected.length) {
    const reviewId = crypto.randomUUID();
    await connection.execute(
      `INSERT INTO correction_impact_reviews (
         review_id, tenant_id, correction_event_id,
         entity_type, entity_id, review_reason
       ) VALUES (?, ?, ?, ?, ?, ?)`,
      [reviewId, tenantId, correctionEventId, entityType, entityId, reviewReason],
    );
    await appendCorrectionReviewEvent(connection, {
      tenantId,
      reviewId,
      eventType: "CREATED",
      statusAfter: "PENDING",
      stateVersionAfter: 1,
      actorId,
      correlationId,
      payload: { correctionEventId, entityType, entityId },
    });
    return;
  }

  for (const row of affected) {
    const reviewId = crypto.randomUUID();
    await connection.execute(
      `INSERT INTO correction_impact_reviews (
         review_id, tenant_id, correction_event_id,
         entity_type, entity_id, affected_assessment_id,
         affected_signal_id, affected_case_id, review_reason
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        reviewId, tenantId, correctionEventId, entityType, entityId,
        row.assessment_id, row.signal_id ?? null, row.case_id ?? null, reviewReason,
      ],
    );
    await appendCorrectionReviewEvent(connection, {
      tenantId,
      reviewId,
      eventType: "CREATED",
      statusAfter: "PENDING",
      stateVersionAfter: 1,
      actorId,
      correlationId,
      payload: {
        correctionEventId,
        entityType,
        entityId,
        affectedAssessmentId: row.assessment_id,
        affectedSignalId: row.signal_id ?? null,
        affectedCaseId: row.case_id ?? null,
      },
    });
  }
}

async function appendCorrectionEvent(connection, {
  tenantId,
  entityType,
  entityId,
  previousVersion,
  newVersion,
  fields,
  classification,
  reasonCode,
  reasonSummary,
  sourceReference,
  actorId,
  correlationId,
  idempotencyKey,
  intentHash,
}) {
  const correctionEventId = crypto.randomUUID();
  await connection.execute(
    `INSERT INTO correction_events (
       correction_event_id, tenant_id, entity_type, entity_id,
       previous_version, new_version, changed_fields, impact_classification,
       assessment_impact, reason_code, reason_summary, source_reference,
       actor_id, correlation_id, idempotency_key, intent_hash
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      correctionEventId,
      tenantId,
      entityType,
      entityId,
      previousVersion,
      newVersion,
      JSON.stringify(fields),
      JSON.stringify(classification.classifications),
      classification.assessmentImpact,
      reasonCode,
      reasonSummary,
      sourceReference ?? null,
      actorId,
      correlationId,
      idempotencyKey,
      intentHash,
    ],
  );

  if (classification.requiresHumanReview) {
    await correctionReviewRows(connection, {
      tenantId,
      correctionEventId,
      entityType,
      entityId,
      previousVersion,
      reviewReason: `${reasonCode}: ${reasonSummary}`,
      actorId,
      correlationId,
    });
  }

  return correctionEventId;
}

export async function persistMemberVersion(connection, {
  tenantId,
  member,
  actorId = "system:reference-ingestion",
  reasonCode = "REFERENCE_DATA_UPDATE",
  reasonSummary = "Member reference data changed during claim ingestion.",
  sourceReference = null,
  correlationId = crypto.randomUUID(),
  expectedVersion = null,
  correctionIdempotencyKey = null,
  correctionIntentHash = null,
}) {
  requireExecutor(connection);
  const nextPayload = memberPayload(member);
  const nextHash = sha256CanonicalJson(nextPayload);
  const [rows] = await connection.execute(
    `SELECT
       tenant_id, member_id, current_member_version, scheme_id,
       first_name, last_name, date_of_birth, gender, identity_number,
       banking_detail, home_region, home_lat, home_lon, join_date
     FROM members
     WHERE member_id = ?
     LIMIT 1
     FOR UPDATE`,
    [member.member_id],
  );
  const current = rows?.[0] ?? null;

  if (expectedVersion !== null && !current) {
    throw new AssessmentContextRepositoryError(
      "MEMBER_NOT_FOUND",
      `Member ${member.member_id} was not found for correction.`,
      404,
    );
  }

  if (!current) {
    await connection.execute(
      `INSERT INTO members (
         member_id, scheme_id, first_name, last_name, date_of_birth, gender,
         identity_number, banking_detail, home_region, home_lat, home_lon,
         join_date, tenant_id, current_member_version
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
      [
        member.member_id, member.scheme_id, member.first_name, member.last_name,
        member.date_of_birth, member.gender, member.identity_number,
        member.banking_detail, member.home_region, member.home_lat,
        member.home_lon, member.join_date, tenantId,
      ],
    );
    await connection.execute(
      `INSERT INTO member_versions (
         tenant_id, member_id, member_version, scheme_id,
         first_name, last_name, date_of_birth, gender, identity_number,
         banking_detail, home_region, home_lat, home_lon, join_date,
         version_reason, source_reference, created_by, payload_hash
       ) VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        tenantId, member.member_id, member.scheme_id,
        member.first_name, member.last_name, member.date_of_birth, member.gender,
        member.identity_number, member.banking_detail, member.home_region,
        member.home_lat, member.home_lon, member.join_date,
        "initial_reference", sourceReference, actorId, nextHash,
      ],
    );
    return { disposition: "inserted", changed: true, version: 1, correctionEventId: null, classification: null };
  }

  if (current.tenant_id !== tenantId) {
    throw new AssessmentContextRepositoryError(
      "REFERENCE_OWNERSHIP_CONFLICT",
      `Member identifier ${member.member_id} is already owned by another tenant.`,
    );
  }
  if (String(current.scheme_id) !== String(member.scheme_id)) {
    throw new AssessmentContextRepositoryError(
      "CORRECTION_STABLE_IDENTITY_CHANGE_PROHIBITED",
      "Ordinary member correction cannot move a stable member identity between schemes.",
      409,
    );
  }

  if (expectedVersion !== null && Number(current.current_member_version) !== Number(expectedVersion)) {
    throw new AssessmentContextRepositoryError(
      "MEMBER_STALE_VERSION",
      `Member ${member.member_id} is at version ${current.current_member_version}; expected version ${expectedVersion}.`,
      409,
      { expectedVersion: Number(expectedVersion), currentVersion: Number(current.current_member_version) },
    );
  }

  const previousPayload = memberPayload(current);
  const fields = changedFields(previousPayload, nextPayload);
  if (!fields.length) {
    return {
      disposition: "updated",
      changed: false,
      version: Number(current.current_member_version),
      correctionEventId: null,
      classification: null,
    };
  }
  const classification = classifyCorrectionFields("MEMBER", fields);
  const previousVersion = Number(current.current_member_version);
  const newVersion = previousVersion + 1;
  const intentHash = correctionIntentHash
    ?? sha256CanonicalJson({ entityType: "MEMBER", entityId: member.member_id, previousVersion, nextPayload, reasonCode });
  const idempotencyKey = correctionIdempotencyKey
    ?? sha256CanonicalJson({ tenantId, entityType: "MEMBER", entityId: member.member_id, previousVersion, intentHash });

  await connection.execute(
    `INSERT INTO member_versions (
       tenant_id, member_id, member_version, scheme_id,
       first_name, last_name, date_of_birth, gender, identity_number,
       banking_detail, home_region, home_lat, home_lon, join_date,
       version_reason, source_reference, created_by, payload_hash
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      tenantId, member.member_id, newVersion, member.scheme_id,
      member.first_name, member.last_name, member.date_of_birth, member.gender,
      member.identity_number, member.banking_detail, member.home_region,
      member.home_lat, member.home_lon, member.join_date,
      reasonCode, sourceReference, actorId, nextHash,
    ],
  );
  const [updated] = await connection.execute(
    `UPDATE members
     SET first_name = ?, last_name = ?, date_of_birth = ?, gender = ?,
         identity_number = ?, banking_detail = ?, home_region = ?,
         home_lat = ?, home_lon = ?, join_date = ?, current_member_version = ?
     WHERE tenant_id = ? AND member_id = ? AND current_member_version = ?`,
    [
      member.first_name, member.last_name, member.date_of_birth, member.gender,
      member.identity_number, member.banking_detail, member.home_region,
      member.home_lat, member.home_lon, member.join_date, newVersion,
      tenantId, member.member_id, previousVersion,
    ],
  );
  if (Number(updated?.affectedRows ?? 0) !== 1) {
    throw new AssessmentContextRepositoryError(
      "MEMBER_VERSION_CONFLICT",
      "Member changed while the correction was being committed.",
    );
  }
  const correctionEventId = await appendCorrectionEvent(connection, {
    tenantId, entityType: "MEMBER", entityId: member.member_id,
    previousVersion, newVersion, fields, classification,
    reasonCode, reasonSummary, sourceReference, actorId, correlationId,
    idempotencyKey, intentHash,
  });
  return { disposition: "updated", changed: true, version: newVersion, correctionEventId, classification };
}

export async function persistProviderVersion(connection, {
  tenantId,
  provider,
  actorId = "system:reference-ingestion",
  reasonCode = "REFERENCE_DATA_UPDATE",
  reasonSummary = "Provider reference data changed during claim ingestion.",
  sourceReference = null,
  correlationId = crypto.randomUUID(),
  expectedVersion = null,
  correctionIdempotencyKey = null,
  correctionIntentHash = null,
}) {
  requireExecutor(connection);
  const nextPayload = providerPayload(provider);
  const nextHash = sha256CanonicalJson(nextPayload);
  const [rows] = await connection.execute(
    `SELECT
       tenant_id, provider_id, current_provider_version, scheme_id,
       practice_number, specialty, practice_name, banking_detail,
       practice_region, practice_lat, practice_lon, provider_kind,
       provider_category
     FROM providers
     WHERE provider_id = ?
     LIMIT 1
     FOR UPDATE`,
    [provider.provider_id],
  );
  const current = rows?.[0] ?? null;

  if (expectedVersion !== null && !current) {
    throw new AssessmentContextRepositoryError(
      "PROVIDER_NOT_FOUND",
      `Provider ${provider.provider_id} was not found for correction.`,
      404,
    );
  }

  if (!current) {
    await connection.execute(
      `INSERT INTO providers (
         provider_id, scheme_id, practice_number, specialty, practice_name,
         banking_detail, practice_region, practice_lat, practice_lon,
         provider_kind, provider_category, tenant_id, current_provider_version
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
      [
        provider.provider_id, provider.scheme_id, provider.practice_number,
        provider.specialty, provider.practice_name, provider.banking_detail,
        provider.practice_region, provider.practice_lat, provider.practice_lon,
        provider.provider_kind, provider.provider_category, tenantId,
      ],
    );
    await connection.execute(
      `INSERT INTO provider_versions (
         tenant_id, provider_id, provider_version, scheme_id,
         practice_number, specialty, practice_name, banking_detail,
         practice_region, practice_lat, practice_lon, provider_kind,
         provider_category, version_reason, source_reference, created_by,
         payload_hash
       ) VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        tenantId, provider.provider_id, provider.scheme_id,
        provider.practice_number, provider.specialty, provider.practice_name,
        provider.banking_detail, provider.practice_region, provider.practice_lat,
        provider.practice_lon, provider.provider_kind, provider.provider_category,
        "initial_reference", sourceReference, actorId, nextHash,
      ],
    );
    return { disposition: "inserted", changed: true, version: 1, correctionEventId: null, classification: null };
  }

  if (current.tenant_id !== tenantId) {
    throw new AssessmentContextRepositoryError(
      "REFERENCE_OWNERSHIP_CONFLICT",
      `Provider identifier ${provider.provider_id} is already owned by another tenant.`,
    );
  }
  if (String(current.scheme_id) !== String(provider.scheme_id)) {
    throw new AssessmentContextRepositoryError(
      "CORRECTION_STABLE_IDENTITY_CHANGE_PROHIBITED",
      "Ordinary provider correction cannot move a stable provider identity between schemes.",
    );
  }

  if (expectedVersion !== null && Number(current.current_provider_version) !== Number(expectedVersion)) {
    throw new AssessmentContextRepositoryError(
      "PROVIDER_STALE_VERSION",
      `Provider ${provider.provider_id} is at version ${current.current_provider_version}; expected version ${expectedVersion}.`,
      409,
      { expectedVersion: Number(expectedVersion), currentVersion: Number(current.current_provider_version) },
    );
  }

  const previousPayload = providerPayload(current);
  const fields = changedFields(previousPayload, nextPayload);
  if (!fields.length) {
    return {
      disposition: "updated", changed: false,
      version: Number(current.current_provider_version),
      correctionEventId: null, classification: null,
    };
  }
  const classification = classifyCorrectionFields("PROVIDER", fields);
  const previousVersion = Number(current.current_provider_version);
  const newVersion = previousVersion + 1;
  const intentHash = correctionIntentHash
    ?? sha256CanonicalJson({ entityType: "PROVIDER", entityId: provider.provider_id, previousVersion, nextPayload, reasonCode });
  const idempotencyKey = correctionIdempotencyKey
    ?? sha256CanonicalJson({ tenantId, entityType: "PROVIDER", entityId: provider.provider_id, previousVersion, intentHash });

  await connection.execute(
    `INSERT INTO provider_versions (
       tenant_id, provider_id, provider_version, scheme_id,
       practice_number, specialty, practice_name, banking_detail,
       practice_region, practice_lat, practice_lon, provider_kind,
       provider_category, version_reason, source_reference, created_by,
       payload_hash
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      tenantId, provider.provider_id, newVersion, provider.scheme_id,
      provider.practice_number, provider.specialty, provider.practice_name,
      provider.banking_detail, provider.practice_region, provider.practice_lat,
      provider.practice_lon, provider.provider_kind, provider.provider_category,
      reasonCode, sourceReference, actorId, nextHash,
    ],
  );
  const [updated] = await connection.execute(
    `UPDATE providers
     SET practice_number = ?, specialty = ?, practice_name = ?,
         banking_detail = ?, practice_region = ?, practice_lat = ?,
         practice_lon = ?, provider_kind = ?, provider_category = ?,
         current_provider_version = ?
     WHERE tenant_id = ? AND provider_id = ? AND current_provider_version = ?`,
    [
      provider.practice_number, provider.specialty, provider.practice_name,
      provider.banking_detail, provider.practice_region, provider.practice_lat,
      provider.practice_lon, provider.provider_kind, provider.provider_category,
      newVersion, tenantId, provider.provider_id, previousVersion,
    ],
  );
  if (Number(updated?.affectedRows ?? 0) !== 1) {
    throw new AssessmentContextRepositoryError(
      "PROVIDER_VERSION_CONFLICT",
      "Provider changed while the correction was being committed.",
    );
  }
  const correctionEventId = await appendCorrectionEvent(connection, {
    tenantId, entityType: "PROVIDER", entityId: provider.provider_id,
    previousVersion, newVersion, fields, classification,
    reasonCode, reasonSummary, sourceReference, actorId, correlationId,
    idempotencyKey, intentHash,
  });
  return { disposition: "updated", changed: true, version: newVersion, correctionEventId, classification };
}

function parseJsonObject(value, label) {
  let parsed = value;
  if (Buffer.isBuffer(parsed)) parsed = parsed.toString("utf8");
  if (typeof parsed === "string") parsed = JSON.parse(parsed);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new AssessmentContextRepositoryError(
      "ASSESSMENT_PROVENANCE_INVALID",
      `${label} must be a JSON object.`,
      500,
    );
  }
  return parsed;
}

async function loadVersionedAssessmentParts(connection, {
  tenantId,
  claimId,
  claimVersion,
  memberVersion = null,
  providerVersion = null,
}) {
  const [claimRows] = await connection.execute(
    `SELECT claim_id, claim_version, member_id, provider_id, claim_payload
     FROM claim_versions
     WHERE tenant_id = ? AND claim_id = ? AND claim_version = ?
     LIMIT 1`,
    [tenantId, claimId, claimVersion],
  );
  const claim = claimRows?.[0];
  if (!claim) throw new AssessmentContextRepositoryError("ASSESSMENT_CLAIM_VERSION_NOT_FOUND", "Claim version was not found.", 404);

  const [memberRows] = await connection.execute(
    `SELECT mv.*
     FROM member_versions mv
     JOIN members m
       ON m.tenant_id = mv.tenant_id AND m.member_id = mv.member_id
     WHERE mv.tenant_id = ? AND mv.member_id = ?
       AND mv.member_version = COALESCE(?, m.current_member_version)
     LIMIT 1`,
    [tenantId, claim.member_id, memberVersion],
  );
  const [providerRows] = await connection.execute(
    `SELECT pv.*
     FROM provider_versions pv
     JOIN providers p
       ON p.tenant_id = pv.tenant_id AND p.provider_id = pv.provider_id
     WHERE pv.tenant_id = ? AND pv.provider_id = ?
       AND pv.provider_version = COALESCE(?, p.current_provider_version)
     LIMIT 1`,
    [tenantId, claim.provider_id, providerVersion],
  );
  if (!memberRows?.[0] || !providerRows?.[0]) {
    throw new AssessmentContextRepositoryError(
      "ASSESSMENT_REFERENCE_VERSION_NOT_FOUND",
      "Pinned member/provider version could not be resolved.",
      409,
    );
  }
  return { claim, member: memberRows[0], provider: providerRows[0] };
}

function assessmentMetadata(strategy) {
  const modelOrRuleVersion = strategy.strategyType === "approved_model"
    ? `deployment:${strategy.modelDeploymentId}`
    : DETERMINISTIC_RULE_VERSION;
  const featureSchemaVersion = `sha256:${sha256CanonicalJson({
    schema: ASSESSMENT_SNAPSHOT_SCHEMA,
    claim: ["claim_id", "claim_version", "claim_payload"],
    member: Object.keys(publicMemberAssessmentPayload({
      member_id: "", member_version: 1, scheme_id: "", first_name: "", last_name: "",
      date_of_birth: "", gender: "", identity_number: "", home_region: "",
      home_lat: 0, home_lon: 0, join_date: "",
    })).sort(),
    provider: Object.keys(publicProviderAssessmentPayload({
      provider_id: "", provider_version: 1, scheme_id: "", practice_number: "",
      specialty: "", practice_name: "", practice_region: "", practice_lat: 0,
      practice_lon: 0, provider_kind: "", provider_category: "",
    })).sort(),
  })}`;
  const referenceDataVersion = `sha256:${sha256CanonicalJson({
    detection_strategy_id: Number(strategy.id ?? strategy.detectionStrategyId),
    strategy_type: strategy.strategyType,
    model_deployment_id: strategy.modelDeploymentId ?? null,
    model_or_rule_version: modelOrRuleVersion,
    feature_schema_version: featureSchemaVersion,
  })}`;
  return { modelOrRuleVersion, featureSchemaVersion, referenceDataVersion };
}

export async function createAssessmentVersion(connection, {
  tenantId,
  claimId,
  claimVersion,
  strategy,
  assessmentReason,
  createdBy,
  memberVersion = null,
  providerVersion = null,
  supersedesAssessmentId = null,
  sourceCorrectionEventId = null,
}) {
  requireExecutor(connection);
  const parts = await loadVersionedAssessmentParts(connection, {
    tenantId, claimId, claimVersion, memberVersion, providerVersion,
  });
  const metadata = assessmentMetadata(strategy);
  const snapshot = {
    schema: ASSESSMENT_SNAPSHOT_SCHEMA,
    tenant_id: tenantId,
    claim: {
      claim_id: parts.claim.claim_id,
      claim_version: Number(parts.claim.claim_version),
      payload: parseJsonObject(parts.claim.claim_payload, "claim_payload"),
    },
    member: publicMemberAssessmentPayload(parts.member),
    provider: publicProviderAssessmentPayload(parts.provider),
    strategy: {
      detection_strategy_id: Number(strategy.id ?? strategy.detectionStrategyId),
      strategy_type: strategy.strategyType,
      model_deployment_id: strategy.modelDeploymentId ?? null,
      model_or_rule_version: metadata.modelOrRuleVersion,
      feature_schema_version: metadata.featureSchemaVersion,
      reference_data_version: metadata.referenceDataVersion,
    },
  };
  const inputHash = sha256CanonicalJson(snapshot);
  const assessmentId = crypto.randomUUID();
  await connection.execute(
    `INSERT INTO assessment_versions (
       assessment_id, tenant_id, claim_id, claim_version,
       member_id, member_version, provider_id, provider_version,
       detection_strategy_id, strategy_type, model_deployment_id,
       model_or_rule_version, feature_schema_version, reference_data_version,
       input_snapshot, input_hash, assessment_reason,
       supersedes_assessment_id, source_correction_event_id,
       provenance_status, created_by
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'COMPLETE', ?)`,
    [
      assessmentId, tenantId, parts.claim.claim_id, Number(parts.claim.claim_version),
      parts.member.member_id, Number(parts.member.member_version),
      parts.provider.provider_id, Number(parts.provider.provider_version),
      Number(strategy.id ?? strategy.detectionStrategyId), strategy.strategyType,
      strategy.modelDeploymentId ?? null, metadata.modelOrRuleVersion,
      metadata.featureSchemaVersion, metadata.referenceDataVersion,
      JSON.stringify(snapshot), inputHash, assessmentReason,
      supersedesAssessmentId, sourceCorrectionEventId, createdBy,
    ],
  );
  return {
    assessmentId,
    claimId: parts.claim.claim_id,
    claimVersion: Number(parts.claim.claim_version),
    memberVersion: Number(parts.member.member_version),
    providerVersion: Number(parts.provider.provider_version),
    inputHash,
    ...metadata,
  };
}

export async function enqueueAssessmentProcessingJob(connection, {
  tenantId,
  assessment,
  strategy,
  source,
  correlationId,
  maxAttempts = 5,
}) {
  requireExecutor(connection);
  const idempotencyKey = sha256CanonicalJson({
    tenantId,
    jobType: "claim_detection",
    assessmentId: assessment.assessmentId,
  });
  const aggregateId = sha256CanonicalJson({ tenantId, assessmentId: assessment.assessmentId });
  const jobId = crypto.randomUUID();
  const payload = {
    schema_version: OUTBOX_PAYLOAD_SCHEMA_VERSION,
    dataset_scope: "assessment_version",
    assessment_id: assessment.assessmentId,
    source,
    targets: [{ claim_id: assessment.claimId, claim_version: assessment.claimVersion }],
  };
  await connection.execute(
    `INSERT INTO claim_processing_outbox (
       id, assessment_id, tenant_id, job_type, aggregate_type, aggregate_id,
       correlation_id, idempotency_key, payload, status, max_attempts,
       detection_strategy_id, strategy_type, model_deployment_id
     ) VALUES (?, ?, ?, 'claim_detection', 'claim_batch', ?, ?, ?, ?, 'pending', ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE id = id`,
    [
      jobId, assessment.assessmentId, tenantId, aggregateId,
      correlationId, idempotencyKey, JSON.stringify(payload),
      Math.max(1, Math.min(Number(maxAttempts) || 5, 100)),
      Number(strategy.id ?? strategy.detectionStrategyId), strategy.strategyType,
      strategy.modelDeploymentId ?? null,
    ],
  );
  const [rows] = await connection.execute(
    `SELECT id, assessment_id, correlation_id, status
     FROM claim_processing_outbox
     WHERE tenant_id = ? AND idempotency_key = ?
     LIMIT 1`,
    [tenantId, idempotencyKey],
  );
  const row = rows?.[0];
  if (!row || row.assessment_id !== assessment.assessmentId) {
    throw new AssessmentContextRepositoryError(
      "ASSESSMENT_OUTBOX_INTEGRITY_ERROR",
      "Persisted assessment job does not match its immutable assessment.",
      500,
    );
  }
  return {
    id: row.id,
    assessmentId: row.assessment_id,
    correlationId: row.correlation_id,
    status: row.status,
    enqueued: row.id === jobId,
  };
}

export async function createReplacementAssessmentsForCorrection(connection, {
  tenantId,
  entityType,
  entityId,
  previousVersion,
  newVersion,
  correctionEventId,
  classification,
  createdBy,
  source,
  correlationId,
  maxAttempts = 5,
}) {
  if (!classification?.requiresReplacementAssessment) return [];
  const predicate = entityType === "MEMBER"
    ? "a.member_id = ? AND a.member_version = ?"
    : "a.provider_id = ? AND a.provider_version = ?";
  const [rows] = await connection.execute(
    `SELECT a.*
     FROM assessment_versions a
     WHERE a.tenant_id = ?
       AND ${predicate}
       AND a.provenance_status = 'COMPLETE'
       AND NOT EXISTS (
         SELECT 1 FROM assessment_versions replacement
         WHERE replacement.tenant_id = a.tenant_id
           AND replacement.supersedes_assessment_id = a.assessment_id
       )
     ORDER BY a.created_at ASC, a.assessment_id ASC`,
    [tenantId, entityId, previousVersion],
  );
  const results = [];
  for (const row of rows) {
    const strategy = {
      id: Number(row.detection_strategy_id),
      strategyType: row.strategy_type,
      modelDeploymentId: row.model_deployment_id ?? null,
    };
    const assessment = await createAssessmentVersion(connection, {
      tenantId,
      claimId: row.claim_id,
      claimVersion: Number(row.claim_version),
      strategy,
      assessmentReason: "REFERENCE_CORRECTION_REPLACEMENT",
      createdBy,
      memberVersion: entityType === "MEMBER" ? newVersion : Number(row.member_version),
      providerVersion: entityType === "PROVIDER" ? newVersion : Number(row.provider_version),
      supersedesAssessmentId: row.assessment_id,
      sourceCorrectionEventId: correctionEventId,
    });
    const job = await enqueueAssessmentProcessingJob(connection, {
      tenantId, assessment, strategy, source, correlationId, maxAttempts,
    });
    results.push({ assessment, job });
  }
  return results;
}

function normalizeCorrectionIdempotencyKey(value) {
  if (typeof value !== "string" || !value.trim()) {
    throw new AssessmentContextRepositoryError(
      "MISSING_IDEMPOTENCY_KEY",
      "Idempotency-Key is required for a correction request.",
      400,
    );
  }
  const normalized = value.trim();
  if (normalized.length > 128) {
    throw new AssessmentContextRepositoryError(
      "INVALID_IDEMPOTENCY_KEY",
      "Idempotency-Key must be at most 128 characters.",
      400,
    );
  }
  return normalized;
}

function normalizeExpectedVersion(value, label = "expected version") {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new AssessmentContextRepositoryError(
      "CORRECTION_EXPECTED_VERSION_INVALID",
      `${label} must be a positive integer.`,
      422,
    );
  }
  return parsed;
}

function correctionIdempotencyMismatch() {
  return new AssessmentContextRepositoryError(
    "CORRECTION_IDEMPOTENCY_MISMATCH",
    "Idempotency-Key has already been used for a different correction intent.",
    409,
  );
}

async function lockCorrectionEntity(connection, { tenantId, entityType, entityId }) {
  const table = entityType === "MEMBER" ? "members" : "providers";
  const identifier = entityType === "MEMBER" ? "member_id" : "provider_id";
  await connection.execute(
    `SELECT ${identifier}
       FROM ${table}
      WHERE tenant_id = ? AND ${identifier} = ?
      LIMIT 1
      FOR UPDATE`,
    [tenantId, entityId],
  );
}

function persistedCorrectionResult(value) {
  let parsed;
  try {
    parsed = parseJsonObject(value, "correction result_payload");
  } catch (error) {
    if (error instanceof AssessmentContextRepositoryError) {
      throw new AssessmentContextRepositoryError(
        "CORRECTION_OPERATION_INVALID",
        "Persisted correction operation result is invalid.",
        500,
      );
    }
    throw error;
  }
  if (
    typeof parsed.entityId !== "string"
    || !parsed.entityId
    || !Number.isSafeInteger(Number(parsed.version))
    || !Array.isArray(parsed.replacementAssessments)
  ) {
    throw new AssessmentContextRepositoryError(
      "CORRECTION_OPERATION_INVALID",
      "Persisted correction operation result is incomplete.",
      500,
    );
  }
  return {
    entityId: parsed.entityId,
    disposition: parsed.disposition,
    changed: parsed.changed === true,
    version: Number(parsed.version),
    correctionEventId: parsed.correctionEventId ?? null,
    assessmentImpact: parsed.assessmentImpact ?? null,
    replacementAssessments: parsed.replacementAssessments.map((entry) => ({
      assessmentId: String(entry.assessmentId),
      jobId: String(entry.jobId),
    })),
  };
}

async function executeCorrectionOperation(connection, {
  tenantId,
  entityType,
  entityId,
  entity,
  expectedVersion,
  idempotencyKey,
  actorId,
  reasonCode,
  reasonSummary,
  sourceReference,
  source,
  correlationId,
  maxAttempts = 5,
}) {
  requireExecutor(connection);
  const normalizedIdempotencyKey = normalizeCorrectionIdempotencyKey(idempotencyKey);
  const normalizedExpectedVersion = normalizeExpectedVersion(expectedVersion);
  const operation = entityType === "MEMBER" ? MEMBER_CORRECTION_OPERATION : PROVIDER_CORRECTION_OPERATION;
  const nextPayload = entityType === "MEMBER" ? memberPayload(entity) : providerPayload(entity);
  const intentHash = sha256CanonicalJson({
    tenantId,
    operation,
    entityId,
    expectedVersion: normalizedExpectedVersion,
    nextPayload,
    reasonCode,
    reasonSummary,
    sourceReference: sourceReference ?? null,
  });
  await lockCorrectionEntity(connection, { tenantId, entityType, entityId });
  const [operationRows] = await connection.execute(
    `SELECT operation_id, intent_hash, entity_type, entity_id,
            expected_version, correction_event_id, result_payload
       FROM correction_operations
      WHERE tenant_id = ? AND idempotency_key = ?
      LIMIT 1`,
    [tenantId, normalizedIdempotencyKey],
  );
  const existing = operationRows?.[0] ?? null;
  if (existing) {
    if (
      existing.entity_type !== entityType
      || String(existing.entity_id) !== String(entityId)
      || Number(existing.expected_version) !== normalizedExpectedVersion
      || String(existing.intent_hash) !== intentHash
    ) {
      throw correctionIdempotencyMismatch();
    }
    const persisted = persistedCorrectionResult(existing.result_payload);
    if (persisted.entityId !== String(entityId)) {
      throw new AssessmentContextRepositoryError(
        "CORRECTION_OPERATION_INVALID",
        "Persisted correction operation does not match its entity.",
        500,
      );
    }
    return { operationId: existing.operation_id, ...persisted, replayed: true };
  }

  const correctionEventKey = sha256CanonicalJson({
    tenantId,
    operation: "CORRECTION_EVENT",
    idempotencyKey: normalizedIdempotencyKey,
  });
  const persisted = entityType === "MEMBER"
    ? await persistMemberVersion(connection, {
        tenantId,
        member: entity,
        actorId,
        reasonCode,
        reasonSummary,
        sourceReference,
        correlationId,
        expectedVersion: normalizedExpectedVersion,
        correctionIdempotencyKey: correctionEventKey,
        correctionIntentHash: intentHash,
      })
    : await persistProviderVersion(connection, {
        tenantId,
        provider: entity,
        actorId,
        reasonCode,
        reasonSummary,
        sourceReference,
        correlationId,
        expectedVersion: normalizedExpectedVersion,
        correctionIdempotencyKey: correctionEventKey,
        correctionIntentHash: intentHash,
      });
  const replacements = persisted.correctionEventId
    ? await createReplacementAssessmentsForCorrection(connection, {
        tenantId,
        entityType,
        entityId,
        previousVersion: normalizedExpectedVersion,
        newVersion: persisted.version,
        correctionEventId: persisted.correctionEventId,
        classification: persisted.classification,
        createdBy: actorId,
        source,
        correlationId,
        maxAttempts,
      })
    : [];
  const resultPayload = {
    entityId: String(entityId),
    disposition: persisted.disposition,
    changed: persisted.changed === true,
    version: Number(persisted.version),
    correctionEventId: persisted.correctionEventId ?? null,
    assessmentImpact: persisted.classification?.assessmentImpact ?? null,
    replacementAssessments: replacements.map(({ assessment, job }) => ({
      assessmentId: assessment.assessmentId,
      jobId: job.id,
    })),
  };
  const operationId = sha256CanonicalJson({
    tenantId,
    operation,
    idempotencyKey: normalizedIdempotencyKey,
  });
  try {
    await connection.execute(
      `INSERT INTO correction_operations (
         operation_id, tenant_id, idempotency_key, intent_hash,
         entity_type, entity_id, expected_version,
         correction_event_id, result_payload
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        operationId,
        tenantId,
        normalizedIdempotencyKey,
        intentHash,
        entityType,
        entityId,
        normalizedExpectedVersion,
        persisted.correctionEventId ?? null,
        JSON.stringify(resultPayload),
      ],
    );
  } catch (error) {
    if (error?.code === "ER_DUP_ENTRY") throw correctionIdempotencyMismatch();
    throw error;
  }
  return { operationId, ...resultPayload, replayed: false };
}

export async function executeMemberCorrection(connection, values) {
  const memberId = String(values?.member?.member_id ?? "");
  return executeCorrectionOperation(connection, {
    ...values,
    entityType: "MEMBER",
    entityId: memberId,
    entity: values.member,
  });
}

export async function executeProviderCorrection(connection, values) {
  const providerId = String(values?.provider?.provider_id ?? "");
  return executeCorrectionOperation(connection, {
    ...values,
    entityType: "PROVIDER",
    entityId: providerId,
    entity: values.provider,
  });
}

function timestampValue(value) {
  if (value === null || value === undefined) return null;
  return value instanceof Date ? value.toISOString() : String(value);
}

export async function listMemberVersions(connection, { tenantId, memberId }) {
  requireExecutor(connection);
  const [rows] = await connection.execute(
    `SELECT mv.member_id, mv.member_version, mv.scheme_id,
            mv.first_name, mv.last_name, mv.date_of_birth, mv.gender,
            mv.identity_number, mv.home_region, mv.home_lat, mv.home_lon,
            mv.join_date, mv.effective_from, mv.effective_to,
            mv.version_reason, mv.source_reference, mv.created_by,
            mv.created_at, mv.payload_hash, m.current_member_version
       FROM member_versions mv
       JOIN members m
         ON m.tenant_id = mv.tenant_id AND m.member_id = mv.member_id
      WHERE mv.tenant_id = ? AND mv.member_id = ?
      ORDER BY mv.member_version DESC`,
    [tenantId, memberId],
  );
  return (rows || []).map((row) => ({
    memberId: row.member_id,
    version: Number(row.member_version),
    currentVersion: Number(row.current_member_version),
    isCurrent: Number(row.member_version) === Number(row.current_member_version),
    schemeId: row.scheme_id,
    firstName: row.first_name,
    lastName: row.last_name,
    dateOfBirth: normalizedDate(row.date_of_birth),
    gender: row.gender,
    identityNumber: row.identity_number,
    homeRegion: row.home_region,
    homeLat: Number(row.home_lat),
    homeLon: Number(row.home_lon),
    joinDate: normalizedDate(row.join_date),
    effectiveFrom: timestampValue(row.effective_from),
    effectiveTo: timestampValue(row.effective_to),
    versionReason: row.version_reason,
    sourceReference: row.source_reference ?? null,
    createdBy: row.created_by,
    createdAt: timestampValue(row.created_at),
    payloadHash: row.payload_hash,
  }));
}

export async function listProviderVersions(connection, { tenantId, providerId }) {
  requireExecutor(connection);
  const [rows] = await connection.execute(
    `SELECT pv.provider_id, pv.provider_version, pv.scheme_id,
            pv.practice_number, pv.specialty, pv.practice_name,
            pv.practice_region, pv.practice_lat, pv.practice_lon,
            pv.provider_kind, pv.provider_category, pv.effective_from,
            pv.effective_to, pv.version_reason, pv.source_reference,
            pv.created_by, pv.created_at, pv.payload_hash,
            p.current_provider_version
       FROM provider_versions pv
       JOIN providers p
         ON p.tenant_id = pv.tenant_id AND p.provider_id = pv.provider_id
      WHERE pv.tenant_id = ? AND pv.provider_id = ?
      ORDER BY pv.provider_version DESC`,
    [tenantId, providerId],
  );
  return (rows || []).map((row) => ({
    providerId: row.provider_id,
    version: Number(row.provider_version),
    currentVersion: Number(row.current_provider_version),
    isCurrent: Number(row.provider_version) === Number(row.current_provider_version),
    schemeId: row.scheme_id,
    practiceNumber: row.practice_number,
    specialty: row.specialty,
    practiceName: row.practice_name,
    practiceRegion: row.practice_region,
    practiceLat: Number(row.practice_lat),
    practiceLon: Number(row.practice_lon),
    providerKind: row.provider_kind,
    providerCategory: row.provider_category,
    effectiveFrom: timestampValue(row.effective_from),
    effectiveTo: timestampValue(row.effective_to),
    versionReason: row.version_reason,
    sourceReference: row.source_reference ?? null,
    createdBy: row.created_by,
    createdAt: timestampValue(row.created_at),
    payloadHash: row.payload_hash,
  }));
}

function parseJsonValue(value) {
  if (value === null || value === undefined) return null;
  if (Buffer.isBuffer(value)) return JSON.parse(value.toString("utf8"));
  if (typeof value === "string") return JSON.parse(value);
  return value;
}

function correctionReview(row) {
  return {
    reviewId: row.review_id,
    correctionEventId: row.correction_event_id,
    entityType: row.entity_type,
    entityId: row.entity_id,
    affectedAssessmentId: row.affected_assessment_id ?? null,
    affectedSignalId: row.affected_signal_id ?? null,
    affectedCaseId: row.affected_case_id ?? null,
    reviewReason: row.review_reason,
    status: row.review_status,
    stateVersion: Number(row.state_version),
    assignedTo: row.assigned_to ?? null,
    createdAt: timestampValue(row.created_at),
    reviewedAt: timestampValue(row.reviewed_at),
    reviewedBy: row.reviewed_by ?? null,
    reviewResult: parseJsonValue(row.review_result),
    previousVersion: Number(row.previous_version),
    newVersion: Number(row.new_version),
    changedFields: parseJsonValue(row.changed_fields) ?? [],
    assessmentImpact: row.assessment_impact,
    correctionActorId: row.correction_actor_id,
  };
}

const CORRECTION_REVIEW_SELECT = `SELECT
  r.review_id, r.correction_event_id, r.entity_type, r.entity_id,
  r.affected_assessment_id, r.affected_signal_id, r.affected_case_id,
  r.review_reason, r.review_status, r.state_version, r.assigned_to,
  r.created_at, r.reviewed_at, r.reviewed_by, r.review_result,
  e.previous_version, e.new_version, e.changed_fields, e.assessment_impact,
  e.actor_id AS correction_actor_id
FROM correction_impact_reviews r
JOIN correction_events e
  ON e.tenant_id = r.tenant_id AND e.correction_event_id = r.correction_event_id`;

export async function listCorrectionImpactReviews(connection, {
  tenantId,
  status = null,
  limit = 100,
}) {
  requireExecutor(connection);
  const normalizedStatus = status === null ? null : String(status).trim().toUpperCase();
  if (normalizedStatus !== null && !CORRECTION_REVIEW_STATUS.has(normalizedStatus)) {
    throw new AssessmentContextRepositoryError(
      "CORRECTION_REVIEW_STATUS_INVALID",
      "Correction review status must be PENDING, IN_REVIEW, or COMPLETED.",
      422,
    );
  }
  const normalizedLimit = Math.max(1, Math.min(Number(limit) || 100, 200));
  const [rows] = await connection.execute(
    `${CORRECTION_REVIEW_SELECT}
     WHERE r.tenant_id = ?
       AND (? IS NULL OR r.review_status = ?)
     ORDER BY r.created_at ASC, r.review_id ASC
     LIMIT ${normalizedLimit}`,
    [tenantId, normalizedStatus, normalizedStatus],
  );
  return (rows || []).map(correctionReview);
}

async function loadCorrectionImpactReview(connection, { tenantId, reviewId, forUpdate = false }) {
  const [rows] = await connection.execute(
    `${CORRECTION_REVIEW_SELECT}
     WHERE r.tenant_id = ? AND r.review_id = ?
     LIMIT 1${forUpdate ? " FOR UPDATE" : ""}`,
    [tenantId, reviewId],
  );
  const row = rows?.[0] ?? null;
  if (!row) {
    throw new AssessmentContextRepositoryError(
      "CORRECTION_REVIEW_NOT_FOUND",
      `Correction impact review ${reviewId} was not found.`,
      404,
    );
  }
  return correctionReview(row);
}

export async function listCorrectionImpactReviewEvents(connection, {
  tenantId,
  reviewId,
}) {
  requireExecutor(connection);
  const [rows] = await connection.execute(
    `SELECT review_event_id, review_id, event_type,
            review_status_before, review_status_after,
            state_version_before, state_version_after,
            actor_id, correlation_id, event_payload, created_at
       FROM correction_impact_review_events
      WHERE tenant_id = ? AND review_id = ?
      ORDER BY state_version_after ASC, review_event_id ASC`,
    [tenantId, reviewId],
  );
  return (rows || []).map((row) => ({
    reviewEventId: row.review_event_id,
    reviewId: row.review_id,
    eventType: row.event_type,
    statusBefore: row.review_status_before ?? null,
    statusAfter: row.review_status_after,
    stateVersionBefore: row.state_version_before === null
      ? null
      : Number(row.state_version_before),
    stateVersionAfter: Number(row.state_version_after),
    actorId: row.actor_id,
    correlationId: row.correlation_id,
    payload: parseJsonValue(row.event_payload) ?? {},
    createdAt: timestampValue(row.created_at),
  }));
}

export async function getCorrectionImpactReview(connection, values) {
  requireExecutor(connection);
  const review = await loadCorrectionImpactReview(connection, values);
  const events = await listCorrectionImpactReviewEvents(connection, values);
  return { ...review, events };
}

export async function claimCorrectionImpactReview(connection, {
  tenantId,
  reviewId,
  expectedStateVersion,
  actorId,
  correlationId = crypto.randomUUID(),
}) {
  requireExecutor(connection);
  const expected = normalizeExpectedVersion(expectedStateVersion, "expected state version");
  const review = await loadCorrectionImpactReview(connection, { tenantId, reviewId, forUpdate: true });
  if (review.stateVersion !== expected) {
    throw new AssessmentContextRepositoryError(
      "CORRECTION_REVIEW_VERSION_CONFLICT",
      `Correction impact review is at state version ${review.stateVersion}; expected ${expected}.`,
      409,
    );
  }
  if (review.status !== "PENDING") {
    throw new AssessmentContextRepositoryError(
      "CORRECTION_REVIEW_STATE_CONFLICT",
      "Only a PENDING correction impact review can be claimed.",
      409,
    );
  }
  if (review.correctionActorId === actorId) {
    throw new AssessmentContextRepositoryError(
      "CORRECTION_REVIEWER_NOT_INDEPENDENT",
      "The correction submitter cannot review the impact of their own correction.",
      403,
    );
  }
  const [updated] = await connection.execute(
    `UPDATE correction_impact_reviews
        SET review_status = 'IN_REVIEW', assigned_to = ?, state_version = state_version + 1
      WHERE tenant_id = ? AND review_id = ?
        AND review_status = 'PENDING' AND state_version = ?`,
    [actorId, tenantId, reviewId, expected],
  );
  if (Number(updated?.affectedRows ?? 0) !== 1) {
    throw new AssessmentContextRepositoryError(
      "CORRECTION_REVIEW_VERSION_CONFLICT",
      "Correction impact review changed while it was being claimed.",
      409,
    );
  }
  await appendCorrectionReviewEvent(connection, {
    tenantId,
    reviewId,
    eventType: "CLAIMED",
    statusBefore: "PENDING",
    statusAfter: "IN_REVIEW",
    stateVersionBefore: expected,
    stateVersionAfter: expected + 1,
    actorId,
    correlationId,
    payload: { assignedTo: actorId },
  });
  return getCorrectionImpactReview(connection, { tenantId, reviewId });
}

function normalizedReviewResult(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new AssessmentContextRepositoryError(
      "CORRECTION_REVIEW_RESULT_INVALID",
      "review_result must be an object.",
      422,
    );
  }
  const dispositions = new Set([
    "NO_FURTHER_ACTION",
    "FOLLOW_UP_REQUIRED",
    "ESCALATE_IDENTITY_REVIEW",
    "ESCALATE_SECURITY_REVIEW",
  ]);
  const disposition = String(value.disposition ?? "").trim().toUpperCase();
  const summary = String(value.summary ?? "").trim();
  const evidenceReferences = value.evidence_references ?? value.evidenceReferences ?? [];
  if (!dispositions.has(disposition)) {
    throw new AssessmentContextRepositoryError(
      "CORRECTION_REVIEW_RESULT_INVALID",
      "review_result.disposition is invalid.",
      422,
    );
  }
  if (!summary || summary.length > 1024) {
    throw new AssessmentContextRepositoryError(
      "CORRECTION_REVIEW_RESULT_INVALID",
      "review_result.summary is required and must be at most 1024 characters.",
      422,
    );
  }
  if (
    !Array.isArray(evidenceReferences)
    || evidenceReferences.length > 20
    || evidenceReferences.some((entry) => typeof entry !== "string" || !entry.trim() || entry.trim().length > 255)
  ) {
    throw new AssessmentContextRepositoryError(
      "CORRECTION_REVIEW_RESULT_INVALID",
      "review_result.evidence_references must contain at most 20 bounded strings.",
      422,
    );
  }
  return {
    disposition,
    summary,
    evidenceReferences: evidenceReferences.map((entry) => entry.trim()),
  };
}

export async function completeCorrectionImpactReview(connection, {
  tenantId,
  reviewId,
  expectedStateVersion,
  actorId,
  reviewResult,
  correlationId = crypto.randomUUID(),
}) {
  requireExecutor(connection);
  const expected = normalizeExpectedVersion(expectedStateVersion, "expected state version");
  const normalizedResult = normalizedReviewResult(reviewResult);
  const review = await loadCorrectionImpactReview(connection, { tenantId, reviewId, forUpdate: true });
  if (review.stateVersion !== expected) {
    throw new AssessmentContextRepositoryError(
      "CORRECTION_REVIEW_VERSION_CONFLICT",
      `Correction impact review is at state version ${review.stateVersion}; expected ${expected}.`,
      409,
    );
  }
  if (review.status !== "IN_REVIEW" || review.assignedTo !== actorId) {
    throw new AssessmentContextRepositoryError(
      "CORRECTION_REVIEW_STATE_CONFLICT",
      "Only the assigned reviewer can complete an IN_REVIEW correction impact review.",
      409,
    );
  }
  if (review.correctionActorId === actorId) {
    throw new AssessmentContextRepositoryError(
      "CORRECTION_REVIEWER_NOT_INDEPENDENT",
      "The correction submitter cannot review the impact of their own correction.",
      403,
    );
  }
  const [updated] = await connection.execute(
    `UPDATE correction_impact_reviews
        SET review_status = 'COMPLETED', state_version = state_version + 1,
            reviewed_at = UTC_TIMESTAMP(3), reviewed_by = ?, review_result = ?
      WHERE tenant_id = ? AND review_id = ?
        AND review_status = 'IN_REVIEW' AND assigned_to = ? AND state_version = ?`,
    [actorId, JSON.stringify(normalizedResult), tenantId, reviewId, actorId, expected],
  );
  if (Number(updated?.affectedRows ?? 0) !== 1) {
    throw new AssessmentContextRepositoryError(
      "CORRECTION_REVIEW_VERSION_CONFLICT",
      "Correction impact review changed while it was being completed.",
      409,
    );
  }
  await appendCorrectionReviewEvent(connection, {
    tenantId,
    reviewId,
    eventType: "COMPLETED",
    statusBefore: "IN_REVIEW",
    statusAfter: "COMPLETED",
    stateVersionBefore: expected,
    stateVersionAfter: expected + 1,
    actorId,
    correlationId,
    payload: { reviewResult: normalizedResult },
  });
  return getCorrectionImpactReview(connection, { tenantId, reviewId });
}

function normalizeReassessmentIdempotencyKey(value) {
  if (typeof value !== "string" || !value.trim()) {
    throw new AssessmentContextRepositoryError(
      "MISSING_IDEMPOTENCY_KEY",
      "Idempotency-Key is required for an assessment reassessment request.",
      400,
    );
  }
  const normalized = value.trim();
  if (normalized.length > 128) {
    throw new AssessmentContextRepositoryError(
      "INVALID_IDEMPOTENCY_KEY",
      "Idempotency-Key must be at most 128 characters.",
      400,
    );
  }
  return normalized;
}

function reassessmentIdempotencyMismatch() {
  return new AssessmentContextRepositoryError(
    "ASSESSMENT_REASSESSMENT_IDEMPOTENCY_MISMATCH",
    "Idempotency-Key has already been used for a different reassessment intent.",
    409,
  );
}

function persistedReassessmentResult(value) {
  let parsed;
  try {
    parsed = parseJsonObject(value, "reassessment result_payload");
  } catch (error) {
    if (error instanceof AssessmentContextRepositoryError) {
      throw new AssessmentContextRepositoryError(
        "ASSESSMENT_REASSESSMENT_OPERATION_INVALID",
        "Persisted reassessment operation result is invalid.",
        500,
      );
    }
    throw error;
  }
  for (const field of ["sourceAssessmentId", "assessmentId", "jobId"]) {
    if (typeof parsed[field] !== "string" || !parsed[field]) {
      throw new AssessmentContextRepositoryError(
        "ASSESSMENT_REASSESSMENT_OPERATION_INVALID",
        "Persisted reassessment operation result is incomplete.",
        500,
      );
    }
  }
  return {
    sourceAssessmentId: parsed.sourceAssessmentId,
    assessmentId: parsed.assessmentId,
    jobId: parsed.jobId,
    status: typeof parsed.status === "string" && parsed.status ? parsed.status : "pending",
  };
}

export async function requestAssessmentReassessment(connection, {
  tenantId,
  sourceAssessmentId,
  idempotencyKey,
  createdBy,
  source,
  correlationId,
  maxAttempts = 5,
}) {
  requireExecutor(connection);
  const normalizedIdempotencyKey = normalizeReassessmentIdempotencyKey(idempotencyKey);

  const [sourceRows] = await connection.execute(
    `SELECT
       assessment_id, tenant_id, claim_id, claim_version,
       member_id, member_version, provider_id, provider_version,
       detection_strategy_id, strategy_type, model_deployment_id,
       provenance_status
     FROM assessment_versions
     WHERE tenant_id = ? AND assessment_id = ?
     LIMIT 1
     FOR UPDATE`,
    [tenantId, sourceAssessmentId],
  );
  const sourceAssessment = sourceRows?.[0] ?? null;
  if (!sourceAssessment) {
    throw new AssessmentContextRepositoryError(
      "ASSESSMENT_NOT_FOUND",
      `Assessment ${sourceAssessmentId} was not found.`,
      404,
    );
  }
  if (sourceAssessment.provenance_status !== "COMPLETE") {
    throw new AssessmentContextRepositoryError(
      "ASSESSMENT_REASSESSMENT_PROVENANCE_INCOMPLETE",
      "Explicit reassessment requires a COMPLETE immutable source assessment.",
      409,
    );
  }

  const intentHash = sha256CanonicalJson({
    tenantId,
    operation: EXPLICIT_REASSESSMENT_OPERATION,
    sourceAssessmentId: sourceAssessment.assessment_id,
  });
  const [operationRows] = await connection.execute(
    `SELECT operation_id, intent_hash, assessment_id, result_payload
     FROM reassessment_operations
     WHERE tenant_id = ? AND idempotency_key = ?
     LIMIT 1
     FOR UPDATE`,
    [tenantId, normalizedIdempotencyKey],
  );
  const existingOperation = operationRows?.[0] ?? null;
  if (existingOperation) {
    if (
      String(existingOperation.assessment_id) !== String(sourceAssessment.assessment_id)
      || String(existingOperation.intent_hash) !== intentHash
    ) {
      throw reassessmentIdempotencyMismatch();
    }
    const persisted = persistedReassessmentResult(existingOperation.result_payload);
    if (persisted.sourceAssessmentId !== sourceAssessment.assessment_id) {
      throw new AssessmentContextRepositoryError(
        "ASSESSMENT_REASSESSMENT_OPERATION_INVALID",
        "Persisted reassessment operation does not match its immutable source assessment.",
        500,
      );
    }
    return {
      operationId: existingOperation.operation_id,
      ...persisted,
      replayed: true,
    };
  }

  const strategy = {
    id: Number(sourceAssessment.detection_strategy_id),
    strategyType: sourceAssessment.strategy_type,
    modelDeploymentId: sourceAssessment.model_deployment_id ?? null,
  };
  const assessment = await createAssessmentVersion(connection, {
    tenantId,
    claimId: sourceAssessment.claim_id,
    claimVersion: Number(sourceAssessment.claim_version),
    strategy,
    assessmentReason: EXPLICIT_REASSESSMENT_OPERATION,
    createdBy,
    memberVersion: Number(sourceAssessment.member_version),
    providerVersion: Number(sourceAssessment.provider_version),
    supersedesAssessmentId: sourceAssessment.assessment_id,
    sourceCorrectionEventId: null,
  });
  const job = await enqueueAssessmentProcessingJob(connection, {
    tenantId,
    assessment,
    strategy,
    source,
    correlationId,
    maxAttempts,
  });
  const resultPayload = {
    sourceAssessmentId: sourceAssessment.assessment_id,
    assessmentId: assessment.assessmentId,
    jobId: job.id,
    status: job.status,
  };
  const operationId = sha256CanonicalJson({
    tenantId,
    operation: EXPLICIT_REASSESSMENT_OPERATION,
    idempotencyKey: normalizedIdempotencyKey,
  });

  try {
    await connection.execute(
      `INSERT INTO reassessment_operations (
         operation_id, tenant_id, idempotency_key, intent_hash,
         assessment_id, result_payload
       ) VALUES (?, ?, ?, ?, ?, ?)`,
      [
        operationId,
        tenantId,
        normalizedIdempotencyKey,
        intentHash,
        sourceAssessment.assessment_id,
        JSON.stringify(resultPayload),
      ],
    );
  } catch (error) {
    if (error?.code === "ER_DUP_ENTRY") {
      throw reassessmentIdempotencyMismatch();
    }
    throw error;
  }

  return {
    operationId,
    ...resultPayload,
    replayed: false,
  };
}
