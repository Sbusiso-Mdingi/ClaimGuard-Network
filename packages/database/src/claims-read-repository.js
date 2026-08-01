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

function prospectiveRiskIndex(score) {
  const fraudProbability = probability(score?.fraudProbability);
  const threshold = probability(score?.threshold);
  if (fraudProbability === null || threshold === null) return null;
  if (threshold === 0) return 100;
  return Math.round(Math.min(100, 70 * fraudProbability / threshold) * 1_000) / 1_000;
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

function detectionEvidence(strategyType, score, triggeredRules, analysisMode, inputDrift) {
  if (strategyType === "deterministic_rules") {
    return triggeredRules.map((rule) => `Rule hit: ${rule}`);
  }

  if (strategyType !== "approved_model") return [];

  const evidence = [];
  if (analysisMode === "PROSPECTIVE_CLAIM_SCREENING") {
    const fraudProbability = percentage(score?.fraudProbability);
    const reviewThreshold = percentage(score?.threshold);
    if (fraudProbability !== null) {
      evidence.push(
        `The model estimated ${fraudProbability.toFixed(2)}% fraud risk${reviewThreshold === null ? "" : ` against a ${reviewThreshold.toFixed(2)}% review threshold`}. This is a screening signal, not a fraud finding.`,
      );
    }
    if (inputDrift?.status === "WATCH" || inputDrift?.status === "OUT_OF_DISTRIBUTION") {
      evidence.push(inputDrift.message || "Unfamiliar model inputs were detected; interpret the score with caution.");
    }
    return evidence;
  }

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
  const analysisMode = row.analysis_mode || payload?.analysisMode || null;
  const inputDrift = parseJsonObject(payload?.inputDrift);

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
    if (analysisMode === "PROSPECTIVE_CLAIM_SCREENING") {
      riskScore = prospectiveRiskIndex(score);
      riskScoreBasis = "THRESHOLD_NORMALIZED_BASELINE";
      reviewRecommended = score.reviewRecommended === true;
      triggeredRules = reviewRecommended
        ? ["PROSPECTIVE_ML_REVIEW_RECOMMENDED"]
        : [];
    } else {
      riskScore = approvedModelRiskIndex(score);
      riskScoreBasis = "THRESHOLD_NORMALIZED_MAX_COMPONENT";
      reviewRecommended = score.compositeReviewRecommended === true;
      triggeredRules = modelTriggeredRules(score);
    }
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
    evidence: detectionEvidence(strategyType, score, triggeredRules, analysisMode, inputDrift),
    analysisMode,
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
    inputDrift,
  };
}

function booleanValue(value) {
  return value === true || value === 1 || String(value || "").toLowerCase() === "true";
}

function mapOverviewDetectionRow(row) {
  if (row.detection_strategy_id === null || row.detection_strategy_id === undefined) {
    return null;
  }
  const strategyType = row.strategy_type || null;
  const analysisMode = row.analysis_mode || null;
  let riskScore = null;
  let reviewRecommended = false;

  if (strategyType === "deterministic_rules") {
    riskScore = percentage(row.deterministic_risk_score);
    reviewRecommended = booleanValue(row.deterministic_review_recommended);
  } else if (strategyType === "approved_model" && analysisMode === "PROSPECTIVE_CLAIM_SCREENING") {
    riskScore = prospectiveRiskIndex({
      fraudProbability: row.prospective_fraud_probability,
      threshold: row.prospective_threshold,
    });
    reviewRecommended = booleanValue(row.prospective_review_recommended);
  } else if (strategyType === "approved_model") {
    riskScore = approvedModelRiskIndex({
      baselineFraudProbability: row.baseline_fraud_probability,
      baselineThreshold: row.baseline_threshold,
      ringProbability: row.ring_probability,
      ringThreshold: row.ring_threshold,
      phantomProbability: row.phantom_probability,
      phantomThreshold: row.phantom_threshold,
    });
    reviewRecommended = booleanValue(row.composite_review_recommended);
  }

  return {
    scoredAt: row.scored_at || null,
    riskScore,
    riskLevel: riskLevelFromScore(riskScore),
    reviewRecommended,
    analysisMode,
    strategyType,
    modelDeploymentId: row.model_deployment_id || null,
    inputDrift: row.input_drift_status
      ? {
          status: row.input_drift_status,
          decisionReliability: row.input_drift_reliability || null,
          signalCount: Number(row.input_drift_signal_count || 0),
        }
      : null,
  };
}

function isReviewSignal(record) {
  return record?.detection?.reviewRecommended === true
    || (Number.isFinite(record?.riskScore) && record.riskScore >= 75);
}

function buildFraudNetworkProjection(records, maximumClaims = 500) {
  const graphableRecords = records.filter((record) => record.memberId && record.providerId);
  const reviewRecords = graphableRecords
    .filter(isReviewSignal)
    .slice()
    .sort((left, right) => {
      const riskDifference = (right.riskScore ?? -1) - (left.riskScore ?? -1);
      if (riskDifference !== 0) return riskDifference;
      return String(right.updatedAt || "").localeCompare(String(left.updatedAt || ""));
    });
  const entitiesForRecord = reviewRecords.map((record) => [
    `member:${record.memberId}`,
    `provider:${record.providerId}`,
  ]);
  const recordsByEntity = new Map();
  entitiesForRecord.forEach((entityIds, recordIndex) => {
    entityIds.forEach((entityId) => {
      if (!recordsByEntity.has(entityId)) recordsByEntity.set(entityId, []);
      recordsByEntity.get(entityId).push(recordIndex);
    });
  });

  const visited = new Set();
  const components = [];
  for (let start = 0; start < reviewRecords.length; start += 1) {
    if (visited.has(start)) continue;
    const pending = [start];
    const recordIndexes = [];
    const entityIds = new Set();
    while (pending.length > 0) {
      const current = pending.pop();
      if (visited.has(current)) continue;
      visited.add(current);
      recordIndexes.push(current);
      for (const entityId of entitiesForRecord[current]) {
        entityIds.add(entityId);
        for (const neighbour of recordsByEntity.get(entityId) || []) {
          if (!visited.has(neighbour)) pending.push(neighbour);
        }
      }
    }
    const memberCount = Array.from(entityIds).filter((entityId) => entityId.startsWith("member:")).length;
    const providerCount = Array.from(entityIds).filter((entityId) => entityId.startsWith("provider:")).length;
    if (recordIndexes.length >= 3 && memberCount >= 2 && providerCount >= 2) {
      components.push({
        recordIndexes,
        entityIds,
        memberCount,
        providerCount,
        maximumRiskScore: Math.max(...recordIndexes.map((index) => reviewRecords[index].riskScore ?? -1)),
        newestAt: recordIndexes.reduce(
          (latest, index) => String(reviewRecords[index].updatedAt || "") > latest
            ? String(reviewRecords[index].updatedAt || "")
            : latest,
          "",
        ),
      });
    }
  }
  components.sort((left, right) => (
    right.maximumRiskScore - left.maximumRiskScore
    || right.newestAt.localeCompare(left.newestAt)
  ));

  const projected = [];
  let qualifyingClaimCount = 0;
  for (const component of components) {
    qualifyingClaimCount += component.recordIndexes.length;
    if (projected.length >= maximumClaims) continue;
    const stableEntity = Array.from(component.entityIds).sort()[0];
    const clusterId = `network:${stableEntity}`;
    for (const index of component.recordIndexes) {
      if (projected.length >= maximumClaims) break;
      projected.push({ record: reviewRecords[index], clusterId });
    }
  }

  const networkNodes = new Map();
  const upsertNetworkNode = (entityId, entityType, value, record, clusterId) => {
    const current = networkNodes.get(entityId) || {
      entity_id: entityId,
      entity_type: entityType,
      value,
      claim_count: 0,
      flagged_claim_count: 0,
      max_risk_score: null,
      cluster_ids: [],
    };
    current.claim_count += 1;
    current.flagged_claim_count += 1;
    if (!current.cluster_ids.includes(clusterId)) current.cluster_ids.push(clusterId);
    if (Number.isFinite(record.riskScore)) {
      current.max_risk_score = current.max_risk_score === null
        ? record.riskScore
        : Math.max(current.max_risk_score, record.riskScore);
    }
    networkNodes.set(entityId, current);
  };
  const networkEdges = projected.map(({ record, clusterId }) => {
    const memberEntityId = `member:${record.memberId}`;
    const providerEntityId = `provider:${record.providerId}`;
    upsertNetworkNode(memberEntityId, "member", record.memberId, record, clusterId);
    upsertNetworkNode(providerEntityId, "provider", record.providerId, record, clusterId);
    return {
      relationship_type: "flagged_claim",
      source_entity_id: memberEntityId,
      target_entity_id: providerEntityId,
      claim_id: record.claimId,
      cluster_id: clusterId,
      risk_score: record.riskScore,
      risk_level: record.riskLevel,
      review_recommended: record.detection?.reviewRecommended === true,
      billed_amount: record.billedAmount,
    };
  });

  return {
    nodes: Array.from(networkNodes.values()),
    edges: networkEdges,
    summary: {
      entity_count: networkNodes.size,
      relationship_count: networkEdges.length,
      member_count: Array.from(networkNodes.values()).filter((node) => node.entity_type === "member").length,
      provider_count: Array.from(networkNodes.values()).filter((node) => node.entity_type === "provider").length,
      represented_claim_count: networkEdges.length,
      eligible_claim_count: reviewRecords.length,
      total_graphable_claim_count: graphableRecords.length,
      review_signal_count: reviewRecords.length,
      isolated_review_claim_count: reviewRecords.length - qualifyingClaimCount,
      active_cluster_count: components.length,
      refresh_interval_seconds: 15,
      projection: "MULTI_CLAIM_REVIEW_NETWORKS",
      candidate_rule: {
        minimum_claim_count: 3,
        minimum_member_count: 2,
        minimum_provider_count: 2,
      },
      truncated: qualifyingClaimCount > networkEdges.length,
    },
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
    async getClaimsOverview() {
      const tenantId = canonicalTenantId();
      const [rows] = await pool.execute(
        `
          SELECT
            c.claim_id,
            c.current_claim_version,
            c.scheme_id,
            c.member_id,
            c.provider_id,
            c.amount,
            c.created_at,
            c.updated_at,
            d.detection_strategy_id,
            d.strategy_type,
            d.model_deployment_id,
            d.source_job_id,
            d.request_id,
            d.analysis_mode,
            d.ensemble_id,
            d.ensemble_version,
            d.feature_schema_version,
            d.scored_at,
            JSON_UNQUOTE(JSON_EXTRACT(d.result_payload, '$.score.riskScore')) AS deterministic_risk_score,
            JSON_UNQUOTE(JSON_EXTRACT(d.result_payload, '$.score.reviewRecommended')) AS deterministic_review_recommended,
            JSON_UNQUOTE(JSON_EXTRACT(d.result_payload, '$.score.fraudProbability')) AS prospective_fraud_probability,
            JSON_UNQUOTE(JSON_EXTRACT(d.result_payload, '$.score.threshold')) AS prospective_threshold,
            JSON_UNQUOTE(JSON_EXTRACT(d.result_payload, '$.score.reviewRecommended')) AS prospective_review_recommended,
            JSON_UNQUOTE(JSON_EXTRACT(d.result_payload, '$.score.baselineFraudProbability')) AS baseline_fraud_probability,
            JSON_UNQUOTE(JSON_EXTRACT(d.result_payload, '$.score.baselineThreshold')) AS baseline_threshold,
            JSON_UNQUOTE(JSON_EXTRACT(d.result_payload, '$.score.ringProbability')) AS ring_probability,
            JSON_UNQUOTE(JSON_EXTRACT(d.result_payload, '$.score.ringThreshold')) AS ring_threshold,
            JSON_UNQUOTE(JSON_EXTRACT(d.result_payload, '$.score.phantomProbability')) AS phantom_probability,
            JSON_UNQUOTE(JSON_EXTRACT(d.result_payload, '$.score.phantomThreshold')) AS phantom_threshold,
            JSON_UNQUOTE(JSON_EXTRACT(d.result_payload, '$.score.compositeReviewRecommended')) AS composite_review_recommended,
            JSON_UNQUOTE(JSON_EXTRACT(d.result_payload, '$.inputDrift.status')) AS input_drift_status,
            JSON_UNQUOTE(JSON_EXTRACT(d.result_payload, '$.inputDrift.decisionReliability')) AS input_drift_reliability,
            JSON_UNQUOTE(JSON_EXTRACT(d.result_payload, '$.inputDrift.signalCount')) AS input_drift_signal_count
          FROM claims c
          LEFT JOIN claim_detection_results d
            ON d.tenant_id = c.tenant_id
           AND d.claim_id = c.claim_id
           AND d.claim_version = c.current_claim_version
          WHERE c.tenant_id = ?
        `,
        [tenantId],
      );

      const records = (rows || []).map((row) => {
        const detection = mapOverviewDetectionRow(row);
        return {
          claimId: row.claim_id,
          schemeId: row.scheme_id,
          memberId: row.member_id,
          providerId: row.provider_id,
          billedAmount: Number(row.amount),
          submittedAt: row.created_at,
          updatedAt: row.updated_at,
          status: detection?.reviewRecommended ? "FLAGGED" : detection ? "SCORED" : "AWAITING_SCORING",
          processingStatus: detection ? "scored" : "not_scored",
          riskScore: detection?.riskScore ?? null,
          riskLevel: detection?.riskLevel ?? null,
          severity: detection?.riskLevel ?? null,
          detectionDate: detection?.scoredAt || null,
          detection,
        };
      });
      const scoredRecords = records.filter((record) => record.detection);
      const scoredRiskRecords = scoredRecords.filter((record) => Number.isFinite(record.riskScore));
      const totalRisk = scoredRiskRecords.reduce((sum, record) => sum + record.riskScore, 0);
      const flaggedRecords = scoredRecords.filter((record) => (
        record.detection?.reviewRecommended === true
        || (Number.isFinite(record.riskScore) && record.riskScore >= 75)
      ));
      const riskDistribution = {
        critical: 0,
        high: 0,
        medium: 0,
        low: 0,
        unscored: records.length - scoredRiskRecords.length,
      };
      for (const record of scoredRiskRecords) {
        if (record.riskScore >= 90) riskDistribution.critical += 1;
        else if (record.riskScore >= 75) riskDistribution.high += 1;
        else if (record.riskScore >= 40) riskDistribution.medium += 1;
        else riskDistribution.low += 1;
      }
      const inputDrift = {
        inDistribution: scoredRecords.filter((record) => record.detection?.inputDrift?.status === "IN_DISTRIBUTION").length,
        watch: scoredRecords.filter((record) => record.detection?.inputDrift?.status === "WATCH").length,
        outOfDistribution: scoredRecords.filter((record) => record.detection?.inputDrift?.status === "OUT_OF_DISTRIBUTION").length,
        profileUnavailable: scoredRecords.filter((record) => record.detection?.inputDrift?.status === "PROFILE_UNAVAILABLE").length,
        unassessed: scoredRecords.filter((record) => !record.detection?.inputDrift?.status).length,
      };
      const graph = buildFraudNetworkProjection(records);

      return {
        generatedAt: new Date().toISOString(),
        summary: {
          totalClaims: records.length,
          scoredClaims: scoredRecords.length,
          unscoredClaims: records.length - scoredRecords.length,
          highRiskClaims: flaggedRecords.length,
          averageRiskScore: scoredRiskRecords.length > 0
            ? Math.round((totalRisk / scoredRiskRecords.length) * 1_000) / 1_000
            : null,
          riskDistribution,
          inputDrift,
        },
        recentDetections: scoredRecords
          .slice()
          .sort((left, right) => {
            const riskDifference = (right.riskScore ?? -1) - (left.riskScore ?? -1);
            if (riskDifference !== 0) return riskDifference;
            return String(right.detectionDate || "").localeCompare(String(left.detectionDate || ""));
          })
          .slice(0, 8),
        graph,
      };
    },

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
