import { repositoryTenantId } from "./repository-context.js";

function parsePositiveInteger(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function normalizeListParams({ page = 1, pageSize = 25, maxPageSize = 100 } = {}) {
  const normalizedPage = parsePositiveInteger(page, 1);
  const requestedPageSize = parsePositiveInteger(pageSize, 25);
  const normalizedMaxPageSize = parsePositiveInteger(maxPageSize, 100);
  const normalizedPageSize = Math.min(requestedPageSize, normalizedMaxPageSize);
  return {
    page: normalizedPage,
    pageSize: normalizedPageSize,
    requestedPageSize,
    maxPageSize: normalizedMaxPageSize,
    offset: (normalizedPage - 1) * normalizedPageSize,
  };
}

function placeholders(count) {
  return Array.from({ length: count }, () => "?").join(", ");
}

function tuplePlaceholders(count) {
  return Array.from({ length: count }, () => "(?, ?)").join(", ");
}

function referenceKey(claimId, claimVersion) {
  return `${claimId}\u0000${claimVersion}`;
}

function parseJsonObject(value) {
  let resolved = value;
  if (Buffer.isBuffer(resolved)) resolved = resolved.toString("utf8");
  if (typeof resolved === "string") {
    try {
      resolved = JSON.parse(resolved);
    } catch {
      return null;
    }
  }
  return resolved && typeof resolved === "object" && !Array.isArray(resolved)
    ? resolved
    : null;
}

function probability(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return null;
  if (parsed >= 0 && parsed <= 1) return parsed;
  if (parsed > 1 && parsed <= 100) return parsed / 100;
  return null;
}

function percentage(value) {
  const parsed = probability(value);
  return parsed === null ? null : Math.round(parsed * 10_000) / 100;
}

function componentRiskIndex(probabilityValue, thresholdValue) {
  const probabilityScore = probability(probabilityValue);
  const threshold = probability(thresholdValue);
  if (probabilityScore === null || threshold === null) return null;
  if (threshold === 0) return 100;
  return Math.min(100, 70 * probabilityScore / threshold);
}

function approvedModelRiskIndex(score) {
  const components = [
    componentRiskIndex(score?.baselineFraudProbability, score?.baselineThreshold),
    componentRiskIndex(score?.ringProbability, score?.ringThreshold),
    componentRiskIndex(score?.phantomProbability, score?.phantomThreshold),
  ].filter((value) => value !== null);
  if (components.length === 0) return null;
  return Math.round(Math.max(...components) * 1_000) / 1_000;
}

function riskLevelFromScore(score) {
  if (!Number.isFinite(score)) return null;
  if (score >= 70) return "High";
  if (score >= 40) return "Medium";
  return "Low";
}

function uniqueStrings(values) {
  return [...new Set((values || []).filter((value) => typeof value === "string" && value.trim()).map((value) => value.trim()))];
}

function modelTriggeredRules(score) {
  return uniqueStrings([
    score?.baselinePredictedClass === "FRAUD" ? "BASELINE_FRAUD" : null,
    score?.ringReviewHit === true ? "RING_REVIEW_HIT" : null,
    score?.phantomReviewHit === true ? "PHANTOM_REVIEW_HIT" : null,
    score?.compositeReviewRecommended === true ? "MODEL_REVIEW_RECOMMENDED" : null,
  ]);
}

function detectionEvidence(strategyType, score, triggeredRules) {
  if (strategyType === "deterministic_rules") {
    return triggeredRules.map((rule) => `Rule hit: ${rule}`);
  }

  if (strategyType !== "approved_model") return [];

  const evidence = [];
  const baseline = percentage(score?.baselineFraudProbability);
  const baselineThreshold = percentage(score?.baselineThreshold);
  if (baseline !== null) {
    evidence.push(
      `Baseline model classified the claim as ${score?.baselinePredictedClass || "UNKNOWN"} at ${baseline.toFixed(2)}%${baselineThreshold === null ? "" : ` against a ${baselineThreshold.toFixed(2)}% threshold`}.`,
    );
  }

  const ring = percentage(score?.ringProbability);
  const ringThreshold = percentage(score?.ringThreshold);
  if (ring !== null) {
    evidence.push(
      `Ring model probability ${ring.toFixed(2)}%${ringThreshold === null ? "" : ` against a ${ringThreshold.toFixed(2)}% threshold`}${score?.ringReviewHit === true ? "; review threshold met" : ""}.`,
    );
  }

  const phantom = percentage(score?.phantomProbability);
  const phantomThreshold = percentage(score?.phantomThreshold);
  if (phantom !== null) {
    evidence.push(
      `Phantom-billing probability ${phantom.toFixed(2)}%${phantomThreshold === null ? "" : ` against a ${phantomThreshold.toFixed(2)}% threshold`}${score?.phantomReviewHit === true ? "; review threshold met" : ""}.`,
    );
  }

  return evidence;
}

function mapDetectionRow(row) {
  if (!row) return null;

  const payload = parseJsonObject(row.result_payload);
  const score = payload?.score && typeof payload.score === "object" && !Array.isArray(payload.score)
    ? payload.score
    : {};
  const strategyType = row.strategy_type || payload?.strategy?.strategyType || null;

  let riskScore = null;
  let riskScoreBasis = null;
  let reviewRecommended = false;
  let triggeredRules = [];

  if (strategyType === "deterministic_rules") {
    riskScore = percentage(score.riskScore);
    riskScoreBasis = "DETERMINISTIC_RULE_SCORE";
    reviewRecommended = score.reviewRecommended === true;
    triggeredRules = uniqueStrings(Array.isArray(score.ruleHits) ? score.ruleHits : []);
  } else if (strategyType === "approved_model") {
    riskScore = approvedModelRiskIndex(score);
    riskScoreBasis = "THRESHOLD_NORMALIZED_MAX_COMPONENT";
    reviewRecommended = score.compositeReviewRecommended === true;
    triggeredRules = modelTriggeredRules(score);
  }

  return {
    status: "scored",
    claimVersion: Number(row.claim_version),
    scoredAt: row.scored_at || null,
    riskScore,
    riskScoreBasis,
    riskLevel: riskLevelFromScore(riskScore),
    reviewRecommended,
    triggeredRules,
    evidence: detectionEvidence(strategyType, score, triggeredRules),
    analysisMode: row.analysis_mode || payload?.analysisMode || null,
    detectionStrategyId: Number(row.detection_strategy_id),
    strategyType,
    modelDeploymentId: row.model_deployment_id || payload?.strategy?.modelDeploymentId || null,
    sourceJobId: row.source_job_id || payload?.sourceJobId || null,
    requestId: row.request_id || payload?.requestId || null,
    ensembleId: row.ensemble_id || payload?.model?.ensembleId || null,
    ensembleVersion: row.ensemble_version || payload?.model?.ensembleVersion || null,
    featureSchemaVersion: row.feature_schema_version || payload?.model?.featureSchemaVersion || null,
    resultSchemaVersion: payload?.schemaVersion || null,
    score: Object.keys(score).length > 0 ? score : null,
  };
}

function processingStatus(job, detection) {
  if (detection) return "scored";
  if (!job) return "not_scored";
  if (job.status === "pending") return "queued";
  if (job.status === "processing") return "processing";
  if (job.status === "retry") return "retrying";
  if (job.status === "dead_letter") return "failed";
  if (job.status === "completed") return "failed";
  return "not_scored";
}

function mapProcessingRow(job, detection) {
  const status = processingStatus(job, detection);
  return {
    status,
    jobId: job?.id || detection?.sourceJobId || null,
    attemptCount: Number.isFinite(Number(job?.attempt_count)) ? Number(job.attempt_count) : 0,
    maxAttempts: Number.isFinite(Number(job?.max_attempts)) ? Number(job.max_attempts) : null,
    availableAt: job?.available_at || null,
    leasedAt: job?.leased_at || null,
    leaseExpiresAt: job?.lease_expires_at || null,
    failureCode: job?.failure_code || (job?.status === "completed" && !detection ? "DETECTION_RESULT_MISSING" : null),
    lastError: job?.last_error || (job?.status === "completed" && !detection ? "Processing completed without a persisted detection result." : null),
    updatedAt: job?.updated_at || detection?.scoredAt || null,
    completedAt: job?.completed_at || null,
  };
}

function claimStatus(investigationStatus, processing, detection) {
  if (investigationStatus) return investigationStatus;
  if (processing.status === "failed") return "PROCESSING_FAILED";
  if (detection?.reviewRecommended) return "FLAGGED";
  if (processing.status === "scored") return "SCORED";
  if (["queued", "processing", "retrying"].includes(processing.status)) return "AWAITING_SCORING";
  return "SUBMITTED";
}

function mapClaimRow(row) {
  if (!row) return null;

  const detection = mapDetectionRow(row.detection_result);
  const processing = mapProcessingRow(row.processing_job, detection);
  const investigation = row.investigation_id
    ? {
        investigationId: row.investigation_id,
        status: row.investigation_status,
        priority: row.investigation_priority,
        updatedAt: row.investigation_updated_at,
      }
    : null;

  return {
    claimId: row.claim_id,
    currentClaimVersion: Number(row.current_claim_version),
    schemeId: row.scheme_id,
    memberId: row.member_id,
    providerId: row.provider_id,
    serviceDate: row.service_date,
    billedAmount: Number(row.amount),
    billingCode: row.billing_code,
    submittedAt: row.created_at,
    updatedAt: row.updated_at,
    status: claimStatus(row.investigation_status, processing, detection),
    processingStatus: processing.status,
    processing,
    riskScore: detection?.riskScore ?? null,
    riskLevel: detection?.riskLevel ?? null,
    triggeredRules: detection?.triggeredRules || [],
    evidence: detection?.evidence || [],
    detection,
    investigation,
  };
}

function attachLatestInvestigation(claimRows, investigationRows) {
  const byClaimId = new Map();
  for (const row of investigationRows || []) {
    if (!row?.claim_id || byClaimId.has(row.claim_id)) continue;
    byClaimId.set(row.claim_id, row);
  }

  return (claimRows || []).map((row) => {
    const investigation = byClaimId.get(row.claim_id) || null;
    return {
      ...row,
      investigation_id: investigation?.investigation_id || null,
      investigation_status: investigation?.status || null,
      investigation_priority: investigation?.priority || null,
      investigation_updated_at: investigation?.updated_at || null,
    };
  });
}

function attachDetectionResults(claimRows, detectionRows) {
  const byReference = new Map(
    (detectionRows || []).map((row) => [referenceKey(row.claim_id, row.claim_version), row]),
  );
  return (claimRows || []).map((row) => ({
    ...row,
    detection_result: byReference.get(referenceKey(row.claim_id, row.current_claim_version)) || null,
  }));
}

function attachLatestProcessingJobs(claimRows, jobRows) {
  const byReference = new Map();
  for (const row of jobRows || []) {
    const key = referenceKey(row.claim_id, row.claim_version);
    if (!byReference.has(key)) byReference.set(key, row);
  }
  return (claimRows || []).map((row) => ({
    ...row,
    processing_job: byReference.get(referenceKey(row.claim_id, row.current_claim_version)) || null,
  }));
}

async function enrichClaimRows(pool, tenantId, claimRows) {
  if (!claimRows?.length) return [];

  const references = claimRows.map((row) => [row.claim_id, Number(row.current_claim_version)]);
  const claimIds = claimRows.map((row) => row.claim_id);
  const referenceParams = references.flatMap(([claimId, claimVersion]) => [claimId, claimVersion]);

  const [detectionResult, processingResult, investigationResult] = await Promise.all([
    pool.execute(
      `
        SELECT
          tenant_id,
          claim_id,
          claim_version,
          detection_strategy_id,
          strategy_type,
          model_deployment_id,
          source_job_id,
          request_id,
          analysis_mode,
          ensemble_id,
          ensemble_version,
          feature_schema_version,
          scored_at,
          result_payload
        FROM claim_detection_results
        WHERE tenant_id = ?
          AND (claim_id, claim_version) IN (${tuplePlaceholders(references.length)})
      `,
      [tenantId, ...referenceParams],
    ),
    pool.execute(
      `
        SELECT
          targets.claim_id,
          targets.claim_version,
          o.id,
          o.status,
          o.attempt_count,
          o.max_attempts,
          o.available_at,
          o.leased_at,
          o.lease_expires_at,
          o.failure_code,
          o.last_error,
          o.updated_at,
          o.completed_at,
          o.created_at
        FROM claim_processing_outbox o
        JOIN JSON_TABLE(
          o.payload,
          '$.targets[*]' COLUMNS (
            claim_id VARCHAR(128) PATH '$.claim_id',
            claim_version INT PATH '$.claim_version'
          )
        ) AS targets ON TRUE
        WHERE o.tenant_id = ?
          AND o.job_type = 'claim_detection'
          AND (targets.claim_id, targets.claim_version) IN (${tuplePlaceholders(references.length)})
        ORDER BY targets.claim_id ASC, targets.claim_version ASC, o.created_at DESC, o.id DESC
      `,
      [tenantId, ...referenceParams],
    ),
    pool.execute(
      `
        SELECT i.claim_id, i.investigation_id, i.status, i.priority, i.updated_at
        FROM investigations i
        INNER JOIN (
          SELECT claim_id, MAX(updated_at) AS latest_updated_at
          FROM investigations
          WHERE tenant_id = ? AND claim_id IN (${placeholders(claimIds.length)})
          GROUP BY claim_id
        ) latest
          ON latest.claim_id = i.claim_id
         AND latest.latest_updated_at = i.updated_at
        WHERE i.tenant_id = ? AND i.claim_id IN (${placeholders(claimIds.length)})
        ORDER BY i.updated_at DESC
      `,
      [tenantId, ...claimIds, tenantId, ...claimIds],
    ),
  ]);

  return attachLatestInvestigation(
    attachLatestProcessingJobs(
      attachDetectionResults(claimRows, detectionResult[0]),
      processingResult[0],
    ),
    investigationResult[0],
  );
}

export function createClaimsReadRepository(pool, {
  dataPlaneContext = null,
  allowLegacyTenantContext = false,
  maxPageSize = 100,
} = {}) {
  if (!pool || typeof pool.execute !== "function") {
    throw new Error("A mysql2 pool with execute support is required for claims read repository.");
  }

  const canonicalTenantId = () => repositoryTenantId(dataPlaneContext, { allowLegacyTenantContext });

  return Object.freeze({
    async listClaims({ page = 1, pageSize = 25 } = {}) {
      const tenantId = canonicalTenantId();
      const paging = normalizeListParams({ page, pageSize, maxPageSize });

      const [countRows] = await pool.execute(
        "SELECT COUNT(*) AS total FROM claims WHERE tenant_id = ?",
        [tenantId],
      );
      const total = Number(countRows?.[0]?.total || 0);

      const [claimRows] = await pool.execute(
        `
          SELECT
            c.claim_id,
            c.current_claim_version,
            c.scheme_id,
            c.member_id,
            c.provider_id,
            c.service_date,
            c.amount,
            c.billing_code,
            c.created_at,
            c.updated_at
          FROM claims c
          WHERE c.tenant_id = ?
          ORDER BY c.updated_at DESC, c.claim_id ASC
          LIMIT ${paging.pageSize} OFFSET ${paging.offset}
        `,
        [tenantId],
      );

      const enrichedRows = await enrichClaimRows(pool, tenantId, claimRows);
      const claims = enrichedRows.map(mapClaimRow);
      return {
        claims,
        pagination: {
          page: paging.page,
          pageSize: paging.pageSize,
          requestedPageSize: paging.requestedPageSize,
          maxPageSize: paging.maxPageSize,
          total,
          totalPages: Math.max(1, Math.ceil(total / paging.pageSize)),
          hasNextPage: paging.offset + claims.length < total,
        },
      };
    },

    async getClaimById(claimId) {
      if (typeof claimId !== "string" || !claimId.trim()) return null;
      const tenantId = canonicalTenantId();
      const normalizedClaimId = claimId.trim();

      const [claimRows] = await pool.execute(
        `
          SELECT
            c.claim_id,
            c.current_claim_version,
            c.scheme_id,
            c.member_id,
            c.provider_id,
            c.service_date,
            c.amount,
            c.billing_code,
            c.created_at,
            c.updated_at
          FROM claims c
          WHERE c.tenant_id = ? AND c.claim_id = ?
          LIMIT 1
        `,
        [tenantId, normalizedClaimId],
      );

      const baseClaim = claimRows?.[0] || null;
      if (!baseClaim) return null;

      const enrichedRows = await enrichClaimRows(pool, tenantId, [baseClaim]);
      return mapClaimRow(enrichedRows?.[0] || null);
    },
  });
}
