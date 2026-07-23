import crypto from "node:crypto";

export const CLAIM_PROCESSING_JOB_TYPE = "claim_detection";
export const CLAIM_PROCESSING_AGGREGATE_TYPE = "claim_batch";

export const CLAIM_PROCESSING_PAYLOAD_SCHEMA_VERSION = 2;
export const CLAIM_PROCESSING_DATASET_SCOPE =
  "triggering_claim_versions";

export const CLAIM_PROCESSING_STATUS = Object.freeze({
  PENDING: "pending",
  PROCESSING: "processing",
  COMPLETED: "completed",
  RETRY: "retry",
  DEAD_LETTER: "dead_letter",
});

const SUPPORTED_STRATEGY_TYPES = new Set([
  "deterministic_rules",
  "approved_model",
]);

const DEPLOYMENT_ID_PATTERN =
  /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

const MAX_TARGETS_PER_JOB = 10_000;
const MAX_CLAIM_ID_LENGTH = 32;
const MAX_TENANT_ID_LENGTH = 64;
const MAX_CORRELATION_ID_LENGTH = 128;
const MAX_SOURCE_LENGTH = 128;
const MAX_WORKER_ID_LENGTH = 128;
const MAX_LEASE_LIMIT = 100;
const MAX_LEASE_SECONDS = 86_400;
const MAX_RETRY_SECONDS = 86_400;

const JOB_SELECT_COLUMNS = `
  id,
  tenant_id,
  job_type,
  aggregate_type,
  aggregate_id,
  correlation_id,
  idempotency_key,
  payload,
  status,
  attempt_count,
  max_attempts,
  available_at,
  leased_at,
  lease_expires_at,
  leased_by,
  last_error,
  failure_code,
  failed_watermark,
  covered_report_id,
  covered_watermark,
  covered_at,
  detection_strategy_id,
  strategy_type,
  model_deployment_id,
  created_at,
  updated_at,
  completed_at
`;

export class ClaimProcessingOutboxValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = "ClaimProcessingOutboxValidationError";
    this.code = "CLAIM_PROCESSING_OUTBOX_INVALID";
    this.status = 400;
  }
}

export class ClaimProcessingOutboxIntegrityError extends Error {
  constructor(message) {
    super(message);
    this.name = "ClaimProcessingOutboxIntegrityError";
    this.code = "CLAIM_PROCESSING_OUTBOX_INTEGRITY_ERROR";
    this.status = 500;
  }
}

function validationError(message) {
  return new ClaimProcessingOutboxValidationError(message);
}

function requireExecutor(executor) {
  if (!executor || typeof executor.execute !== "function") {
    throw validationError(
      "A database executor with an execute function is required.",
    );
  }

  return executor;
}

function requireText(
  value,
  field,
  {
    maxLength = null,
  } = {},
) {
  const normalized =
    typeof value === "string"
      ? value.trim()
      : "";

  if (!normalized) {
    throw validationError(`${field} is required.`);
  }

  if (
    maxLength !== null
    && normalized.length > maxLength
  ) {
    throw validationError(
      `${field} must not exceed ${maxLength} characters.`,
    );
  }

  return normalized;
}

function optionalText(
  value,
  field,
  {
    maxLength = null,
  } = {},
) {
  if (
    value === undefined
    || value === null
    || value === ""
  ) {
    return null;
  }

  return requireText(value, field, {
    maxLength,
  });
}

function requirePositiveInteger(
  value,
  field,
  {
    maximum = Number.MAX_SAFE_INTEGER,
  } = {},
) {
  if (typeof value === "boolean") {
    throw validationError(
      `${field} must be a positive integer.`,
    );
  }

  const parsed = Number(value);

  if (
    !Number.isSafeInteger(parsed)
    || parsed <= 0
    || parsed > maximum
  ) {
    throw validationError(
      `${field} must be a positive integer not exceeding ${maximum}.`,
    );
  }

  return parsed;
}

function boundedPositiveInteger(
  value,
  fallback,
  maximum,
) {
  const parsed = Number(value);

  if (
    !Number.isSafeInteger(parsed)
    || parsed <= 0
  ) {
    return fallback;
  }

  return Math.min(parsed, maximum);
}

function sortValue(value) {
  if (Array.isArray(value)) {
    return value.map(sortValue);
  }

  if (
    value
    && typeof value === "object"
    && !(value instanceof Date)
    && !Buffer.isBuffer(value)
  ) {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [
          key,
          sortValue(value[key]),
        ]),
    );
  }

  return value;
}

function stableStringify(value) {
  return JSON.stringify(
    sortValue(value),
  );
}

function parsePayload(value) {
  let resolved = value;

  if (Buffer.isBuffer(resolved)) {
    resolved = resolved.toString("utf8");
  }

  if (typeof resolved !== "string") {
    return resolved;
  }

  try {
    return JSON.parse(resolved);
  } catch {
    return resolved;
  }
}

function canonicalTimestamp(
  value,
  field,
) {
  if (value instanceof Date) {
    if (
      Number.isNaN(
        value.getTime(),
      )
    ) {
      throw validationError(
        `${field} must be a valid timestamp.`,
      );
    }

    return value.toISOString();
  }

  const rendered = String(
    value ?? "",
  ).trim();

  if (!rendered) {
    throw validationError(
      `${field} is required.`,
    );
  }

  let timestamp = rendered;

  /*
   * MySQL may return UTC_TIMESTAMP as:
   * 2026-07-23 12:30:45.123
   *
   * It has no explicit offset, but the query
   * is guaranteed to be UTC.
   */
  if (
    /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d{1,6})?$/.test(
      timestamp,
    )
  ) {
    timestamp =
      `${timestamp.replace(" ", "T")}Z`;
  }

  const parsed = new Date(timestamp);

  if (
    Number.isNaN(
      parsed.getTime(),
    )
  ) {
    throw validationError(
      `${field} must be a valid ISO timestamp.`,
    );
  }

  return parsed.toISOString();
}

async function resolveContextCutoffAt(
  executor,
  suppliedValue,
) {
  if (
    suppliedValue !== undefined
    && suppliedValue !== null
    && suppliedValue !== ""
  ) {
    return canonicalTimestamp(
      suppliedValue,
      "contextCutoffAt",
    );
  }

  const [rows] = await executor.execute(
    `
      SELECT
        UTC_TIMESTAMP(3) AS context_cutoff_at
    `,
  );

  const databaseTimestamp =
    rows?.[0]?.context_cutoff_at;

  if (!databaseTimestamp) {
    throw new ClaimProcessingOutboxIntegrityError(
      "The database did not return a context cutoff timestamp.",
    );
  }

  return canonicalTimestamp(
    databaseTimestamp,
    "contextCutoffAt",
  );
}

function normalizeStrategy({
  detectionStrategyId,
  strategyType,
  modelDeploymentId,
}) {
  const canonicalStrategyId =
    requirePositiveInteger(
      detectionStrategyId,
      "detectionStrategyId",
      {
        maximum: 2_147_483_647,
      },
    );

  const canonicalStrategyType =
    requireText(
      strategyType,
      "strategyType",
      {
        maxLength: 64,
      },
    );

  if (
    !SUPPORTED_STRATEGY_TYPES.has(
      canonicalStrategyType,
    )
  ) {
    throw validationError(
      "strategyType is unsupported.",
    );
  }

  const canonicalDeploymentId =
    optionalText(
      modelDeploymentId,
      "modelDeploymentId",
      {
        maxLength: 128,
      },
    );

  if (
    canonicalStrategyType
    === "approved_model"
  ) {
    if (
      !canonicalDeploymentId
      || !DEPLOYMENT_ID_PATTERN.test(
        canonicalDeploymentId,
      )
    ) {
      throw validationError(
        "approved_model requires a valid modelDeploymentId.",
      );
    }
  } else if (
    canonicalDeploymentId !== null
  ) {
    throw validationError(
      "deterministic_rules cannot specify a modelDeploymentId.",
    );
  }

  return {
    detectionStrategyId:
      canonicalStrategyId,
    strategyType:
      canonicalStrategyType,
    modelDeploymentId:
      canonicalDeploymentId,
  };
}

function normalizeTargets(targets) {
  if (
    !Array.isArray(targets)
    || targets.length === 0
  ) {
    throw validationError(
      "targets must be a non-empty array.",
    );
  }

  if (
    targets.length
    > MAX_TARGETS_PER_JOB
  ) {
    throw validationError(
      `targets must not contain more than ${MAX_TARGETS_PER_JOB} entries.`,
    );
  }

  const normalized = [];
  const seenReferences = new Set();
  const seenClaimIds = new Set();

  for (
    let index = 0;
    index < targets.length;
    index += 1
  ) {
    const target = targets[index];

    if (
      !target
      || typeof target !== "object"
      || Array.isArray(target)
    ) {
      throw validationError(
        `targets[${index}] must be an object.`,
      );
    }

    const claimId = requireText(
      target.claim_id,
      `targets[${index}].claim_id`,
      {
        maxLength:
          MAX_CLAIM_ID_LENGTH,
      },
    );

    const claimVersion =
      requirePositiveInteger(
        target.claim_version,
        `targets[${index}].claim_version`,
        {
          maximum: 2_147_483_647,
        },
      );

    const reference =
      `${claimId}\u0000${claimVersion}`;

    if (
      seenReferences.has(reference)
    ) {
      throw validationError(
        `targets contains duplicate claim version ${claimId}@${claimVersion}.`,
      );
    }

    /*
     * A single detection job must not contain
     * two versions of the same logical claim.
     */
    if (seenClaimIds.has(claimId)) {
      throw validationError(
        `targets contains multiple versions of claim ${claimId}.`,
      );
    }

    seenReferences.add(reference);
    seenClaimIds.add(claimId);

    normalized.push({
      claim_id: claimId,
      claim_version: claimVersion,
    });
  }

  normalized.sort(
    (left, right) =>
      left.claim_id.localeCompare(
        right.claim_id,
      )
      || left.claim_version
        - right.claim_version,
  );

  return normalized;
}

function buildIdempotencyDocument({
  tenantId,
  targets,
  detectionStrategyId,
  strategyType,
  modelDeploymentId,
}) {
  return {
    tenant_id: tenantId,
    job_type:
      CLAIM_PROCESSING_JOB_TYPE,
    detection_strategy_id:
      detectionStrategyId,
    strategy_type: strategyType,
    model_deployment_id:
      modelDeploymentId,
    targets,
  };
}

/*
 * Kept under the existing exported function name
 * to avoid an unnecessary public package break.
 *
 * The semantics are now prospective and based on
 * exact immutable claim-version references.
 */
export function createClaimBatchIdempotencyKey({
  tenantId,
  targets,
  detectionStrategyId,
  strategyType,
  modelDeploymentId = null,
} = {}) {
  const canonicalTenantId =
    requireText(
      tenantId,
      "tenantId",
      {
        maxLength:
          MAX_TENANT_ID_LENGTH,
      },
    );

  const normalizedTargets =
    normalizeTargets(targets);

  const strategy = normalizeStrategy({
    detectionStrategyId,
    strategyType,
    modelDeploymentId,
  });

  return crypto
    .createHash("sha256")
    .update(
      stableStringify(
        buildIdempotencyDocument({
          tenantId:
            canonicalTenantId,
          targets:
            normalizedTargets,
          ...strategy,
        }),
      ),
      "utf8",
    )
    .digest("hex");
}

function createAggregateId({
  tenantId,
  targets,
}) {
  return crypto
    .createHash("sha256")
    .update(
      stableStringify({
        tenant_id: tenantId,
        aggregate_type:
          CLAIM_PROCESSING_AGGREGATE_TYPE,
        targets,
      }),
      "utf8",
    )
    .digest("hex");
}

function mapJob(row) {
  if (!row) {
    return null;
  }

  const strategyId =
    row.detection_strategy_id === null
    || row.detection_strategy_id
      === undefined
      ? null
      : Number(
        row.detection_strategy_id,
      );

  return {
    id: row.id,
    tenantId: row.tenant_id,
    jobType: row.job_type,
    aggregateType:
      row.aggregate_type,
    aggregateId:
      row.aggregate_id,
    correlationId:
      row.correlation_id,
    idempotencyKey:
      row.idempotency_key,
    payload: parsePayload(
      row.payload,
    ),
    status: row.status,
    attemptCount: Number(
      row.attempt_count,
    ),
    maxAttempts: Number(
      row.max_attempts,
    ),
    availableAt:
      row.available_at ?? null,
    leasedAt:
      row.leased_at ?? null,
    leaseExpiresAt:
      row.lease_expires_at ?? null,
    leasedBy:
      row.leased_by ?? null,
    lastError:
      row.last_error ?? null,
    failureCode:
      row.failure_code ?? null,
    failedWatermark:
      row.failed_watermark ?? null,
    coveredReportId:
      row.covered_report_id ?? null,
    coveredWatermark:
      row.covered_watermark ?? null,
    coveredAt:
      row.covered_at ?? null,
    detectionStrategyId:
      strategyId,
    strategyType:
      row.strategy_type ?? null,
    modelDeploymentId:
      row.model_deployment_id
      ?? null,
    createdAt:
      row.created_at ?? null,
    updatedAt:
      row.updated_at ?? null,
    completedAt:
      row.completed_at ?? null,
  };
}

function assertEnqueuedJobIntegrity(
  job,
  {
    tenantId,
    targets,
    detectionStrategyId,
    strategyType,
    modelDeploymentId,
  },
) {
  if (!job) {
    throw new ClaimProcessingOutboxIntegrityError(
      "Outbox job could not be read after enqueue.",
    );
  }

  if (
    job.tenantId !== tenantId
    || job.jobType
      !== CLAIM_PROCESSING_JOB_TYPE
    || job.aggregateType
      !== CLAIM_PROCESSING_AGGREGATE_TYPE
    || job.detectionStrategyId
      !== detectionStrategyId
    || job.strategyType
      !== strategyType
    || job.modelDeploymentId
      !== modelDeploymentId
  ) {
    throw new ClaimProcessingOutboxIntegrityError(
      "The persisted outbox job differs from its pinned detection identity.",
    );
  }

  const payload = job.payload;

  if (
    !payload
    || typeof payload !== "object"
    || Array.isArray(payload)
    || payload.schema_version
      !== CLAIM_PROCESSING_PAYLOAD_SCHEMA_VERSION
    || payload.dataset_scope
      !== CLAIM_PROCESSING_DATASET_SCOPE
    || !Array.isArray(
      payload.targets,
    )
  ) {
    throw new ClaimProcessingOutboxIntegrityError(
      "The persisted outbox payload has an incompatible schema.",
    );
  }

  const persistedTargets =
    normalizeTargets(
      payload.targets,
    );

  if (
    stableStringify(
      persistedTargets,
    )
    !== stableStringify(targets)
  ) {
    throw new ClaimProcessingOutboxIntegrityError(
      "The persisted outbox job targets differ from the requested claim versions.",
    );
  }

  canonicalTimestamp(
    payload.context_cutoff_at,
    "payload.context_cutoff_at",
  );
}

export async function enqueueClaimProcessingJob(
  executor,
  {
    tenantId,
    targets,
    source = "api",
    correlationId =
      crypto.randomUUID(),
    contextCutoffAt = null,
    maxAttempts = 5,
    detectionStrategyId,
    strategyType,
    modelDeploymentId = null,
  } = {},
) {
  requireExecutor(executor);

  const canonicalTenantId =
    requireText(
      tenantId,
      "tenantId",
      {
        maxLength:
          MAX_TENANT_ID_LENGTH,
      },
    );

  const canonicalCorrelationId =
    requireText(
      correlationId,
      "correlationId",
      {
        maxLength:
          MAX_CORRELATION_ID_LENGTH,
      },
    );

  const canonicalSource =
    requireText(
      source,
      "source",
      {
        maxLength:
          MAX_SOURCE_LENGTH,
      },
    );

  const normalizedTargets =
    normalizeTargets(targets);

  const strategy = normalizeStrategy({
    detectionStrategyId,
    strategyType,
    modelDeploymentId,
  });

  const canonicalContextCutoffAt =
    await resolveContextCutoffAt(
      executor,
      contextCutoffAt,
    );

  const canonicalMaxAttempts =
    boundedPositiveInteger(
      maxAttempts,
      5,
      100,
    );

  const idempotencyKey =
    createClaimBatchIdempotencyKey({
      tenantId:
        canonicalTenantId,
      targets:
        normalizedTargets,
      ...strategy,
    });

  const aggregateId =
    createAggregateId({
      tenantId:
        canonicalTenantId,
      targets:
        normalizedTargets,
    });

  const jobId =
    crypto.randomUUID();

  const payload = {
    schema_version:
      CLAIM_PROCESSING_PAYLOAD_SCHEMA_VERSION,
    dataset_scope:
      CLAIM_PROCESSING_DATASET_SCOPE,
    source: canonicalSource,
    context_cutoff_at:
      canonicalContextCutoffAt,
    targets:
      normalizedTargets,
  };

  await executor.execute(
    `
      INSERT INTO claim_processing_outbox (
        id,
        tenant_id,
        job_type,
        aggregate_type,
        aggregate_id,
        correlation_id,
        idempotency_key,
        payload,
        status,
        max_attempts,
        detection_strategy_id,
        strategy_type,
        model_deployment_id
      )
      VALUES (
        ?,
        ?,
        ?,
        ?,
        ?,
        ?,
        ?,
        ?,
        'pending',
        ?,
        ?,
        ?,
        ?
      )
      ON DUPLICATE KEY UPDATE
        id = id
    `,
    [
      jobId,
      canonicalTenantId,
      CLAIM_PROCESSING_JOB_TYPE,
      CLAIM_PROCESSING_AGGREGATE_TYPE,
      aggregateId,
      canonicalCorrelationId,
      idempotencyKey,
      JSON.stringify(payload),
      canonicalMaxAttempts,
      strategy.detectionStrategyId,
      strategy.strategyType,
      strategy.modelDeploymentId,
    ],
  );

  const [rows] = await executor.execute(
    `
      SELECT
        ${JOB_SELECT_COLUMNS}
      FROM claim_processing_outbox
      WHERE tenant_id = ?
        AND idempotency_key = ?
      LIMIT 1
    `,
    [
      canonicalTenantId,
      idempotencyKey,
    ],
  );

  const job = mapJob(
    rows?.[0],
  );

  assertEnqueuedJobIntegrity(
    job,
    {
      tenantId:
        canonicalTenantId,
      targets:
        normalizedTargets,
      ...strategy,
    },
  );

  return {
    ...job,
    enqueued:
      job.id === jobId,
  };
}

async function recoverExpiredLeasesWithExecutor(
  executor,
  tenantId = null,
) {
  const params = [
    CLAIM_PROCESSING_JOB_TYPE,
  ];

  if (tenantId) {
    params.push(tenantId);
  }

  const [result] =
    await executor.execute(
      `
        UPDATE claim_processing_outbox
        SET
          status = CASE
            WHEN attempt_count >= max_attempts
              THEN 'dead_letter'
            ELSE 'retry'
          END,
          available_at =
            UTC_TIMESTAMP(3),
          leased_at = NULL,
          lease_expires_at = NULL,
          leased_by = NULL,
          last_error =
            'Worker lease expired before completion.',
          failure_code =
            'WORKER_LEASE_EXPIRED',
          completed_at = CASE
            WHEN attempt_count >= max_attempts
              THEN UTC_TIMESTAMP(3)
            ELSE NULL
          END
        WHERE job_type = ?
          ${
            tenantId
              ? "AND tenant_id = ?"
              : ""
          }
          AND status = 'processing'
          AND lease_expires_at IS NOT NULL
          AND lease_expires_at
            <= UTC_TIMESTAMP(3)
      `,
      params,
    );

  return Number(
    result?.affectedRows
    || 0,
  );
}

async function deadLetterExhaustedJobsWithExecutor(
  executor,
  tenantId = null,
) {
  const params = [
    CLAIM_PROCESSING_JOB_TYPE,
  ];

  if (tenantId) {
    params.push(tenantId);
  }

  const [result] =
    await executor.execute(
      `
        UPDATE claim_processing_outbox
        SET
          status = 'dead_letter',
          completed_at =
            COALESCE(
              completed_at,
              UTC_TIMESTAMP(3)
            ),
          leased_at = NULL,
          lease_expires_at = NULL,
          leased_by = NULL,
          last_error =
            COALESCE(
              last_error,
              'Maximum processing attempts exhausted.'
            ),
          failure_code =
            COALESCE(
              failure_code,
              'MAXIMUM_ATTEMPTS_EXHAUSTED'
            )
        WHERE job_type = ?
          ${
            tenantId
              ? "AND tenant_id = ?"
              : ""
          }
          AND status IN (
            'pending',
            'retry'
          )
          AND attempt_count >= max_attempts
      `,
      params,
    );

  return Number(
    result?.affectedRows
    || 0,
  );
}

function assertRepositoryTenant(
  pinnedTenantId,
  requestedTenantId,
) {
  const canonicalRequestedTenantId =
    requireText(
      requestedTenantId,
      "tenantId",
      {
        maxLength:
          MAX_TENANT_ID_LENGTH,
      },
    );

  if (
    pinnedTenantId
    && canonicalRequestedTenantId
      !== pinnedTenantId
  ) {
    throw validationError(
      "Outbox tenant does not match the verified data-plane context.",
    );
  }

  return (
    pinnedTenantId
    || canonicalRequestedTenantId
  );
}

export function createClaimProcessingOutboxRepository(
  pool,
  {
    dataPlaneContext = null,
  } = {},
) {
  if (
    !pool
    || typeof pool.execute
      !== "function"
    || typeof pool.getConnection
      !== "function"
  ) {
    throw validationError(
      "A MySQL-compatible pool is required.",
    );
  }

  const pinnedTenantId =
    dataPlaneContext
      ?.operationalTenantId
    || null;

  return {
    async enqueue(job = {}) {
      const tenantId =
        assertRepositoryTenant(
          pinnedTenantId,
          job.tenantId,
        );

      const connection =
        await pool.getConnection();

      try {
        await connection.beginTransaction();

        const result =
          await enqueueClaimProcessingJob(
            connection,
            {
              ...job,
              tenantId,
            },
          );

        await connection.commit();

        return result;
      } catch (error) {
        await connection.rollback();
        throw error;
      } finally {
        connection.release();
      }
    },

    async recoverExpiredLeases() {
      const connection =
        await pool.getConnection();

      try {
        const recovered =
          await recoverExpiredLeasesWithExecutor(
            connection,
            pinnedTenantId,
          );

        await deadLetterExhaustedJobsWithExecutor(
          connection,
          pinnedTenantId,
        );

        return recovered;
      } finally {
        connection.release();
      }
    },

    async leaseNextAvailableJobs({
      workerId,
      limit = 10,
      leaseSeconds = 300,
    } = {}) {
      const canonicalWorkerId =
        requireText(
          workerId,
          "workerId",
          {
            maxLength:
              MAX_WORKER_ID_LENGTH,
          },
        );

      const leaseLimit =
        boundedPositiveInteger(
          limit,
          10,
          MAX_LEASE_LIMIT,
        );

      const timeoutSeconds =
        boundedPositiveInteger(
          leaseSeconds,
          300,
          MAX_LEASE_SECONDS,
        );

      const connection =
        await pool.getConnection();

      try {
        await connection.beginTransaction();

        await recoverExpiredLeasesWithExecutor(
          connection,
          pinnedTenantId,
        );

        await deadLetterExhaustedJobsWithExecutor(
          connection,
          pinnedTenantId,
        );

        const candidateParams = [
          CLAIM_PROCESSING_JOB_TYPE,
        ];

        if (pinnedTenantId) {
          candidateParams.push(
            pinnedTenantId,
          );
        }

        const [candidateRows] =
          await connection.execute(
            `
              SELECT id
              FROM claim_processing_outbox
              WHERE job_type = ?
                ${
                  pinnedTenantId
                    ? "AND tenant_id = ?"
                    : ""
                }
                AND status IN (
                  'pending',
                  'retry'
                )
                AND attempt_count
                  < max_attempts
                AND available_at
                  <= UTC_TIMESTAMP(3)
              ORDER BY
                available_at ASC,
                created_at ASC,
                id ASC
              LIMIT ${leaseLimit}
              FOR UPDATE SKIP LOCKED
            `,
            candidateParams,
          );

        const ids = (
          candidateRows
          || []
        )
          .map((row) =>
            String(
              row.id || "",
            ).trim()
          )
          .filter(Boolean);

        if (ids.length === 0) {
          await connection.commit();
          return [];
        }

        const placeholders =
          ids
            .map(() => "?")
            .join(", ");

        await connection.execute(
          `
            UPDATE claim_processing_outbox
            SET
              status = 'processing',
              attempt_count =
                attempt_count + 1,
              leased_at =
                UTC_TIMESTAMP(3),
              lease_expires_at =
                DATE_ADD(
                  UTC_TIMESTAMP(3),
                  INTERVAL ? SECOND
                ),
              leased_by = ?,
              last_error = NULL,
              failure_code = NULL,
              failed_watermark = NULL
            WHERE id IN (
              ${placeholders}
            )
              AND job_type = ?
              AND status IN (
                'pending',
                'retry'
              )
          `,
          [
            timeoutSeconds,
            canonicalWorkerId,
            ...ids,
            CLAIM_PROCESSING_JOB_TYPE,
          ],
        );

        const [leasedRows] =
          await connection.execute(
            `
              SELECT
                ${JOB_SELECT_COLUMNS}
              FROM claim_processing_outbox
              WHERE id IN (
                ${placeholders}
              )
                AND job_type = ?
                AND leased_by = ?
                AND status = 'processing'
              ORDER BY
                available_at ASC,
                created_at ASC,
                id ASC
            `,
            [
              ...ids,
              CLAIM_PROCESSING_JOB_TYPE,
              canonicalWorkerId,
            ],
          );

        await connection.commit();

        return (
          leasedRows
          || []
        ).map(mapJob);
      } catch (error) {
        await connection.rollback();
        throw error;
      } finally {
        connection.release();
      }
    },

    async markCompleted({
      id,
      tenantId,
      workerId,
    }) {
      const canonicalTenantId =
        assertRepositoryTenant(
          pinnedTenantId,
          tenantId,
        );

      const [result] =
        await pool.execute(
          `
            UPDATE claim_processing_outbox
            SET
              status = 'completed',
              completed_at =
                UTC_TIMESTAMP(3),
              leased_at = NULL,
              lease_expires_at = NULL,
              leased_by = NULL,
              last_error = NULL,
              failure_code = NULL,
              failed_watermark = NULL
            WHERE id = ?
              AND tenant_id = ?
              AND job_type = ?
              AND status = 'processing'
              AND leased_by = ?
          `,
          [
            requireText(
              id,
              "id",
              {
                maxLength: 64,
              },
            ),
            canonicalTenantId,
            CLAIM_PROCESSING_JOB_TYPE,
            requireText(
              workerId,
              "workerId",
              {
                maxLength:
                  MAX_WORKER_ID_LENGTH,
              },
            ),
          ],
        );

      return (
        Number(
          result?.affectedRows
          || 0,
        ) === 1
      );
    },

    async markRetry({
      id,
      tenantId,
      workerId,
      delaySeconds,
      lastError,
      failureCode = null,
      failedWatermark = null,
    }) {
      const canonicalTenantId =
        assertRepositoryTenant(
          pinnedTenantId,
          tenantId,
        );

      const delay =
        boundedPositiveInteger(
          delaySeconds,
          1,
          MAX_RETRY_SECONDS,
        );

      const errorText =
        String(
          lastError
          || "Retryable producer failure.",
        ).slice(
          0,
          255,
        );

      const code =
        String(
          failureCode
          || "RETRYABLE_PRODUCER_FAILURE",
        ).slice(
          0,
          64,
        );

      const watermark =
        failedWatermark
          ? String(
            failedWatermark,
          ).slice(
            0,
            1024,
          )
          : null;

      const [result] =
        await pool.execute(
          `
            UPDATE claim_processing_outbox
            SET
              status = CASE
                WHEN attempt_count
                  >= max_attempts
                  THEN 'dead_letter'
                ELSE 'retry'
              END,
              available_at = CASE
                WHEN attempt_count
                  >= max_attempts
                  THEN available_at
                ELSE DATE_ADD(
                  UTC_TIMESTAMP(3),
                  INTERVAL ? SECOND
                )
              END,
              completed_at = CASE
                WHEN attempt_count
                  >= max_attempts
                  THEN UTC_TIMESTAMP(3)
                ELSE NULL
              END,
              leased_at = NULL,
              lease_expires_at = NULL,
              leased_by = NULL,
              last_error = ?,
              failure_code = CASE
                WHEN attempt_count
                  >= max_attempts
                  THEN
                    'MAXIMUM_ATTEMPTS_EXHAUSTED'
                ELSE ?
              END,
              failed_watermark = ?
            WHERE id = ?
              AND tenant_id = ?
              AND job_type = ?
              AND status = 'processing'
              AND leased_by = ?
          `,
          [
            delay,
            errorText,
            code,
            watermark,
            requireText(
              id,
              "id",
              {
                maxLength: 64,
              },
            ),
            canonicalTenantId,
            CLAIM_PROCESSING_JOB_TYPE,
            requireText(
              workerId,
              "workerId",
              {
                maxLength:
                  MAX_WORKER_ID_LENGTH,
              },
            ),
          ],
        );

      return (
        Number(
          result?.affectedRows
          || 0,
        ) === 1
      );
    },

    async markDeadLetter({
      id,
      tenantId,
      workerId,
      lastError,
      failureCode = null,
      failedWatermark = null,
    }) {
      const canonicalTenantId =
        assertRepositoryTenant(
          pinnedTenantId,
          tenantId,
        );

      const [result] =
        await pool.execute(
          `
            UPDATE claim_processing_outbox
            SET
              status = 'dead_letter',
              completed_at =
                UTC_TIMESTAMP(3),
              leased_at = NULL,
              lease_expires_at = NULL,
              leased_by = NULL,
              last_error = ?,
              failure_code = ?,
              failed_watermark = ?
            WHERE id = ?
              AND tenant_id = ?
              AND job_type = ?
              AND status = 'processing'
              AND leased_by = ?
          `,
          [
            String(
              lastError
              || "Terminal producer failure.",
            ).slice(
              0,
              255,
            ),
            String(
              failureCode
              || "TERMINAL_PRODUCER_FAILURE",
            ).slice(
              0,
              64,
            ),
            failedWatermark
              ? String(
                failedWatermark,
              ).slice(
                0,
                1024,
              )
              : null,
            requireText(
              id,
              "id",
              {
                maxLength: 64,
              },
            ),
            canonicalTenantId,
            CLAIM_PROCESSING_JOB_TYPE,
            requireText(
              workerId,
              "workerId",
              {
                maxLength:
                  MAX_WORKER_ID_LENGTH,
              },
            ),
          ],
        );

      return (
        Number(
          result?.affectedRows
          || 0,
        ) === 1
      );
    },

    async getJobStatus({
      id,
      tenantId,
    }) {
      const canonicalTenantId =
        assertRepositoryTenant(
          pinnedTenantId,
          tenantId,
        );

      const [rows] =
        await pool.execute(
          `
            SELECT
              ${JOB_SELECT_COLUMNS}
            FROM claim_processing_outbox
            WHERE id = ?
              AND tenant_id = ?
              AND job_type = ?
            LIMIT 1
          `,
          [
            requireText(
              id,
              "id",
              {
                maxLength: 64,
              },
            ),
            canonicalTenantId,
            CLAIM_PROCESSING_JOB_TYPE,
          ],
        );

      return mapJob(
        rows?.[0],
      );
    },

    async getLatestGenerationStatus({
      tenantId,
    }) {
      const canonicalTenantId =
        assertRepositoryTenant(
          pinnedTenantId,
          tenantId,
        );

      const [rows] =
        await pool.execute(
          `
            SELECT
              ${JOB_SELECT_COLUMNS}
            FROM claim_processing_outbox
            WHERE tenant_id = ?
              AND job_type = ?
            ORDER BY
              created_at DESC,
              id DESC
            LIMIT 1
          `,
          [
            canonicalTenantId,
            CLAIM_PROCESSING_JOB_TYPE,
          ],
        );

      return mapJob(
        rows?.[0],
      );
    },
  };
}
