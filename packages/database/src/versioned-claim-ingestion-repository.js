import {
  createAssessmentVersion,
  enqueueAssessmentProcessingJob,
} from "./assessment-context-repository.js";
import {
  createClaimIngestionRepository as createLegacyClaimIngestionRepository,
  ClaimVersionIntegrityError,
} from "./claim-ingestion-repository.js";

function integrityError(message) {
  return new ClaimVersionIntegrityError(message);
}

function parseJsonObject(value, field) {
  let parsed = value;
  if (Buffer.isBuffer(parsed)) parsed = parsed.toString("utf8");
  if (typeof parsed === "string") {
    try {
      parsed = JSON.parse(parsed);
    } catch {
      throw integrityError(`${field} contains invalid JSON.`);
    }
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw integrityError(`${field} must be a JSON object.`);
  }
  return parsed;
}

function normalizeLegacyTargets(payload) {
  const parsed = parseJsonObject(payload, "Legacy claim-processing payload");
  if (!Array.isArray(parsed.targets) || parsed.targets.length === 0) {
    throw integrityError("Legacy claim-processing payload has no claim-version targets.");
  }
  return parsed.targets.map((target, index) => {
    const claimId = typeof target?.claim_id === "string"
      ? target.claim_id.trim()
      : "";
    const claimVersion = Number(target?.claim_version);
    if (!claimId || !Number.isSafeInteger(claimVersion) || claimVersion <= 0) {
      throw integrityError(
        `Legacy claim-processing target ${index} is not a valid immutable claim version.`,
      );
    }
    return { claimId, claimVersion };
  });
}

function deferredConnection(rawConnection) {
  let commitRequested = false;
  let rolledBack = false;
  const connection = new Proxy(rawConnection, {
    get(target, property, receiver) {
      if (property === "commit") {
        return async () => {
          commitRequested = true;
        };
      }
      if (property === "rollback") {
        return async () => {
          rolledBack = true;
          return target.rollback();
        };
      }
      if (property === "release") return () => {};
      const value = Reflect.get(target, property, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return {
    connection,
    commitWasRequested: () => commitRequested,
    wasRolledBack: () => rolledBack,
  };
}

async function replaceLegacyOutboxJob(
  connection,
  {
    legacyJobId,
    source,
    createdBy,
    maxAttempts,
  },
) {
  const [rows] = await connection.execute(
    `SELECT
       id,
       assessment_id,
       tenant_id,
       correlation_id,
       payload,
       detection_strategy_id,
       strategy_type,
       model_deployment_id
     FROM claim_processing_outbox
     WHERE id = ?
     LIMIT 1
     FOR UPDATE`,
    [legacyJobId],
  );
  const legacyJob = rows?.[0] || null;
  if (!legacyJob) {
    throw integrityError("The provisional claim-processing job could not be reloaded.");
  }
  if (legacyJob.assessment_id !== null && legacyJob.assessment_id !== undefined) {
    throw integrityError("The provisional claim-processing job was unexpectedly assessment-addressed.");
  }

  const tenantId = String(legacyJob.tenant_id || "").trim();
  const correlationId = String(legacyJob.correlation_id || "").trim();
  const detectionStrategyId = Number(legacyJob.detection_strategy_id);
  const strategyType = String(legacyJob.strategy_type || "").trim();
  const modelDeploymentId = legacyJob.model_deployment_id ?? null;
  if (
    !tenantId
    || !correlationId
    || !Number.isSafeInteger(detectionStrategyId)
    || detectionStrategyId <= 0
    || !strategyType
  ) {
    throw integrityError("The provisional claim-processing job has invalid pinned strategy metadata.");
  }
  const strategy = {
    id: detectionStrategyId,
    strategyType,
    modelDeploymentId,
  };
  const targets = normalizeLegacyTargets(legacyJob.payload);

  const [deleteResult] = await connection.execute(
    `DELETE FROM claim_processing_outbox
     WHERE id = ?
       AND tenant_id = ?
       AND assessment_id IS NULL`,
    [legacyJob.id, tenantId],
  );
  if (Number(deleteResult?.affectedRows || 0) !== 1) {
    throw integrityError("The provisional unpinned claim-processing job could not be replaced safely.");
  }

  const assessmentJobs = [];
  for (const target of targets) {
    const assessment = await createAssessmentVersion(connection, {
      tenantId,
      claimId: target.claimId,
      claimVersion: target.claimVersion,
      strategy,
      assessmentReason: target.claimVersion === 1
        ? "INITIAL_CLAIM_VERSION"
        : "CLAIM_VERSION_CHANGED",
      createdBy,
    });
    const job = await enqueueAssessmentProcessingJob(connection, {
      tenantId,
      assessment,
      strategy,
      source,
      correlationId,
      maxAttempts,
    });
    assessmentJobs.push({ assessment, job });
  }
  return { tenantId, correlationId, assessmentJobs };
}

function assessmentProcessingResult(original, replacement) {
  const first = replacement.assessmentJobs[0];
  if (!first) {
    throw integrityError("Assessment pinning produced no processing jobs.");
  }
  const jobs = replacement.assessmentJobs.map(({ job }) => job);
  const assessments = replacement.assessmentJobs.map(({ assessment }) => assessment);
  return {
    ...original,
    status: ["pending", "processing", "retry"].includes(first.job.status)
      ? "queued"
      : first.job.status,
    asynchronous: true,
    jobId: first.job.id,
    jobIds: jobs.map((job) => job.id),
    assessmentId: first.assessment.assessmentId,
    assessmentIds: assessments.map((assessment) => assessment.assessmentId),
    correlationId: replacement.correlationId,
    reused: jobs.every((job) => !job.enqueued),
    skipped: false,
    reason: null,
  };
}

export function createClaimIngestionRepository(pool, options = {}) {
  if (!pool || typeof pool.getConnection !== "function") {
    return createLegacyClaimIngestionRepository(pool, options);
  }
  return {
    async ingestClaims(input) {
      const rawConnection = await pool.getConnection();
      const deferred = deferredConnection(rawConnection);
      const proxyPool = {
        async getConnection() {
          return deferred.connection;
        },
      };
      const legacy = createLegacyClaimIngestionRepository(proxyPool, options);
      try {
        const result = await legacy.ingestClaims(input);
        if (!deferred.commitWasRequested() || deferred.wasRolledBack()) {
          throw integrityError("Claim ingestion did not reach a committable transaction state.");
        }
        let resolved = result;
        if (!result.processing?.skipped) {
          const replacement = await replaceLegacyOutboxJob(rawConnection, {
            legacyJobId: result.processing.jobId,
            source: result.source,
            createdBy: "system:claim-ingestion",
            maxAttempts: options.maxOutboxAttempts
              || process.env.REPORT_WORKER_MAX_ATTEMPTS
              || process.env.CLAIM_OUTBOX_MAX_ATTEMPTS
              || 5,
          });
          resolved = {
            ...result,
            processing: assessmentProcessingResult(result.processing, replacement),
          };
          if (resolved.versioned !== replacement.assessmentJobs.length) {
            throw integrityError(
              "Assessment fan-out does not match the accepted claim-version count.",
            );
          }
        }
        await rawConnection.commit();
        return resolved;
      } catch (error) {
        if (!deferred.wasRolledBack()) {
          try {
            await rawConnection.rollback();
          } catch {
            // Preserve the original transactional failure.
          }
        }
        throw error;
      } finally {
        rawConnection.release();
      }
    },
  };
}
