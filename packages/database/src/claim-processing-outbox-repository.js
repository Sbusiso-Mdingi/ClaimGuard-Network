import crypto from "node:crypto";

export const CLAIM_PROCESSING_JOB_TYPE = "report_production";
export const CLAIM_PROCESSING_AGGREGATE_TYPE = "claim_batch";

export const CLAIM_PROCESSING_STATUS = Object.freeze({
  PENDING: "pending",
  PROCESSING: "processing",
  COMPLETED: "completed",
  RETRY: "retry",
  DEAD_LETTER: "dead_letter",
});

function sortValue(value) {
  if (Array.isArray(value)) {
    return value.map(sortValue);
  }

  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, sortValue(value[key])]),
    );
  }

  return value;
}

function stableStringify(value) {
  return JSON.stringify(sortValue(value));
}

function requireText(value, field) {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!normalized) {
    throw new Error(`${field} is required`);
  }
  return normalized;
}

function positiveInteger(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function parsePayload(value) {
  if (typeof value !== "string") {
    return value;
  }

  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function mapJob(row) {
  if (!row) {
    return null;
  }

  return {
    id: row.id,
    tenantId: row.tenant_id,
    jobType: row.job_type,
    aggregateType: row.aggregate_type,
    aggregateId: row.aggregate_id,
    correlationId: row.correlation_id,
    idempotencyKey: row.idempotency_key,
    payload: parsePayload(row.payload),
    status: row.status,
    attemptCount: Number(row.attempt_count),
    maxAttempts: Number(row.max_attempts),
    availableAt: row.available_at,
    leasedAt: row.leased_at,
    leaseExpiresAt: row.lease_expires_at,
    leasedBy: row.leased_by,
    lastError: row.last_error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at,
  };
}

// Logical retries share SHA-256(canonical tenant + job type + normalized, claim-id-sorted batch).
// Correlation ID and source are deliberately excluded so transport retries reuse the same job.
export function createClaimBatchIdempotencyKey({ tenantId, claims }) {
  const canonicalTenantId = requireText(tenantId, "tenantId");
  if (!Array.isArray(claims) || claims.length === 0) {
    throw new Error("claims must be a non-empty array");
  }

  const normalizedClaims = claims
    .map((claim) => sortValue(claim))
    .sort((left, right) =>
      String(left.claim_id).localeCompare(String(right.claim_id)) ||
      stableStringify(left).localeCompare(stableStringify(right)),
    );
  const digest = crypto.createHash("sha256");
  digest.update(stableStringify({
    tenant_id: canonicalTenantId,
    job_type: CLAIM_PROCESSING_JOB_TYPE,
    claims: normalizedClaims,
  }));
  return digest.digest("hex");
}

export async function enqueueClaimProcessingJob(executor, {
  tenantId,
  claims,
  source = "api",
  correlationId = crypto.randomUUID(),
  maxAttempts = 5,
} = {}) {
  const canonicalTenantId = requireText(tenantId, "tenantId");
  const canonicalCorrelationId = requireText(correlationId, "correlationId");
  if (!Array.isArray(claims) || claims.length === 0) {
    throw new Error("claims must be a non-empty array");
  }
  const normalizedClaims = claims.map((claim) => sortValue(claim));
  const idempotencyKey = createClaimBatchIdempotencyKey({
    tenantId: canonicalTenantId,
    claims: normalizedClaims,
  });
  const aggregateId = crypto
    .createHash("sha256")
    .update(stableStringify(normalizedClaims.map((claim) => claim.claim_id).sort()))
    .digest("hex");
  const jobId = crypto.randomUUID();
  const payload = {
    schema_version: 1,
    dataset_scope: "triggering_claim_batch",
    source,
    claims: normalizedClaims,
  };

  await executor.execute(
    `
      INSERT INTO claim_processing_outbox (
        id, tenant_id, job_type, aggregate_type, aggregate_id,
        correlation_id, idempotency_key, payload, status, max_attempts
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)
      ON DUPLICATE KEY UPDATE id = id
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
      positiveInteger(maxAttempts, 5),
    ],
  );

  const [rows] = await executor.execute(
    `
      SELECT *
      FROM claim_processing_outbox
      WHERE tenant_id = ? AND idempotency_key = ?
      LIMIT 1
    `,
    [canonicalTenantId, idempotencyKey],
  );
  const job = mapJob(rows?.[0]);
  if (!job) {
    throw new Error("Outbox job could not be read after enqueue.");
  }

  return {
    ...job,
    enqueued: job.id === jobId,
  };
}

async function recoverExpiredLeasesWithExecutor(executor) {
  const [result] = await executor.execute(
    `
      UPDATE claim_processing_outbox
      SET
        status = CASE
          WHEN attempt_count >= max_attempts THEN 'dead_letter'
          ELSE 'retry'
        END,
        available_at = UTC_TIMESTAMP(3),
        leased_at = NULL,
        lease_expires_at = NULL,
        leased_by = NULL,
        last_error = 'Worker lease expired before completion.',
        completed_at = CASE
          WHEN attempt_count >= max_attempts THEN UTC_TIMESTAMP(3)
          ELSE NULL
        END
      WHERE status = 'processing'
        AND lease_expires_at IS NOT NULL
        AND lease_expires_at <= UTC_TIMESTAMP(3)
    `,
  );
  return Number(result?.affectedRows || 0);
}

export function createClaimProcessingOutboxRepository(pool) {
  return {
    async enqueue(job) {
      const connection = await pool.getConnection();
      try {
        await connection.beginTransaction();
        const result = await enqueueClaimProcessingJob(connection, job);
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
      const connection = await pool.getConnection();
      try {
        return await recoverExpiredLeasesWithExecutor(connection);
      } finally {
        connection.release();
      }
    },

    async leaseNextAvailableJobs({ workerId, limit = 10, leaseSeconds = 300 } = {}) {
      const canonicalWorkerId = requireText(workerId, "workerId");
      const leaseLimit = Math.min(positiveInteger(limit, 10), 100);
      const timeoutSeconds = Math.min(positiveInteger(leaseSeconds, 300), 86400);
      const connection = await pool.getConnection();

      try {
        await connection.beginTransaction();
        await recoverExpiredLeasesWithExecutor(connection);
        const [candidateRows] = await connection.execute(
          `
            SELECT id
            FROM claim_processing_outbox
            WHERE status IN ('pending', 'retry')
              AND available_at <= UTC_TIMESTAMP(3)
            ORDER BY available_at ASC, created_at ASC
            LIMIT ${leaseLimit}
            FOR UPDATE SKIP LOCKED
          `,
        );
        const ids = (candidateRows || []).map((row) => row.id);

        if (ids.length === 0) {
          await connection.commit();
          return [];
        }

        const placeholders = ids.map(() => "?").join(", ");
        await connection.execute(
          `
            UPDATE claim_processing_outbox
            SET
              status = 'processing',
              attempt_count = attempt_count + 1,
              leased_at = UTC_TIMESTAMP(3),
              lease_expires_at = DATE_ADD(UTC_TIMESTAMP(3), INTERVAL ? SECOND),
              leased_by = ?,
              last_error = NULL
            WHERE id IN (${placeholders})
          `,
          [timeoutSeconds, canonicalWorkerId, ...ids],
        );
        const [leasedRows] = await connection.execute(
          `
            SELECT *
            FROM claim_processing_outbox
            WHERE id IN (${placeholders}) AND leased_by = ? AND status = 'processing'
            ORDER BY available_at ASC, created_at ASC
          `,
          [...ids, canonicalWorkerId],
        );
        await connection.commit();
        return (leasedRows || []).map(mapJob);
      } catch (error) {
        await connection.rollback();
        throw error;
      } finally {
        connection.release();
      }
    },

    async markCompleted({ id, tenantId, workerId }) {
      const [result] = await pool.execute(
        `
          UPDATE claim_processing_outbox
          SET
            status = 'completed',
            completed_at = UTC_TIMESTAMP(3),
            leased_at = NULL,
            lease_expires_at = NULL,
            leased_by = NULL,
            last_error = NULL
          WHERE id = ? AND tenant_id = ? AND status = 'processing' AND leased_by = ?
        `,
        [requireText(id, "id"), requireText(tenantId, "tenantId"), requireText(workerId, "workerId")],
      );
      return Number(result?.affectedRows || 0) === 1;
    },

    async markRetry({ id, tenantId, workerId, delaySeconds, lastError }) {
      const [result] = await pool.execute(
        `
          UPDATE claim_processing_outbox
          SET
            status = 'retry',
            available_at = DATE_ADD(UTC_TIMESTAMP(3), INTERVAL ? SECOND),
            leased_at = NULL,
            lease_expires_at = NULL,
            leased_by = NULL,
            last_error = ?
          WHERE id = ? AND tenant_id = ? AND status = 'processing' AND leased_by = ?
        `,
        [
          Math.min(positiveInteger(delaySeconds, 1), 86400),
          String(lastError || "Retryable producer failure.").slice(0, 255),
          requireText(id, "id"),
          requireText(tenantId, "tenantId"),
          requireText(workerId, "workerId"),
        ],
      );
      return Number(result?.affectedRows || 0) === 1;
    },

    async markDeadLetter({ id, tenantId, workerId, lastError }) {
      const [result] = await pool.execute(
        `
          UPDATE claim_processing_outbox
          SET
            status = 'dead_letter',
            completed_at = UTC_TIMESTAMP(3),
            leased_at = NULL,
            lease_expires_at = NULL,
            leased_by = NULL,
            last_error = ?
          WHERE id = ? AND tenant_id = ? AND status = 'processing' AND leased_by = ?
        `,
        [
          String(lastError || "Terminal producer failure.").slice(0, 255),
          requireText(id, "id"),
          requireText(tenantId, "tenantId"),
          requireText(workerId, "workerId"),
        ],
      );
      return Number(result?.affectedRows || 0) === 1;
    },

    async getJobStatus({ id, tenantId }) {
      const [rows] = await pool.execute(
        `
          SELECT *
          FROM claim_processing_outbox
          WHERE id = ? AND tenant_id = ?
          LIMIT 1
        `,
        [requireText(id, "id"), requireText(tenantId, "tenantId")],
      );
      return mapJob(rows?.[0]);
    },
  };
}
