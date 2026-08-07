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

async function correctionReviewRows(connection, {
  tenantId,
  correctionEventId,
  entityType,
  entityId,
  previousVersion,
  reviewReason,
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
    await connection.execute(
      `INSERT INTO correction_impact_reviews (
         review_id, tenant_id, correction_event_id,
         entity_type, entity_id, review_reason
       ) VALUES (?, ?, ?, ?, ?, ?)`,
      [crypto.randomUUID(), tenantId, correctionEventId, entityType, entityId, reviewReason],
    );
    return;
  }

  for (const row of affected) {
    await connection.execute(
      `INSERT INTO correction_impact_reviews (
         review_id, tenant_id, correction_event_id,
         entity_type, entity_id, affected_assessment_id,
         affected_signal_id, affected_case_id, review_reason
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        crypto.randomUUID(), tenantId, correctionEventId, entityType, entityId,
        row.assessment_id, row.signal_id ?? null, row.case_id ?? null, reviewReason,
      ],
    );
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
  const intentHash = sha256CanonicalJson({ entityType: "MEMBER", entityId: member.member_id, previousVersion, nextPayload, reasonCode });
  const idempotencyKey = sha256CanonicalJson({ tenantId, entityType: "MEMBER", entityId: member.member_id, previousVersion, intentHash });

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
  const intentHash = sha256CanonicalJson({ entityType: "PROVIDER", entityId: provider.provider_id, previousVersion, nextPayload, reasonCode });
  const idempotencyKey = sha256CanonicalJson({ tenantId, entityType: "PROVIDER", entityId: provider.provider_id, previousVersion, intentHash });

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
