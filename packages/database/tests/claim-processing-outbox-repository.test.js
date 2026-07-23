import assert from "node:assert/strict";
import test from "node:test";

import {
  createClaimBatchIdempotencyKey,
  createClaimProcessingOutboxRepository,
} from "../src/index.js";


const FIXED_TIMESTAMP =
  "2026-07-23 12:30:45.123";

const TARGETS = Object.freeze([
  Object.freeze({
    claim_id: "C-2",
    claim_version: 3,
  }),
  Object.freeze({
    claim_id: "C-1",
    claim_version: 1,
  }),
]);


function prospectivePayload({
  source = "api",
  targets = TARGETS,
} = {}) {
  return {
    schema_version: 2,
    dataset_scope:
      "triggering_claim_versions",
    source,
    context_cutoff_at:
      "2026-07-23T12:30:45.123Z",
    targets,
  };
}


function row(overrides = {}) {
  return {
    id: "job-1",
    tenant_id: "tenant_alpha",
    job_type: "claim_detection",
    aggregate_type: "claim_batch",
    aggregate_id: "aggregate-1",
    correlation_id: "request-1",
    idempotency_key: "a".repeat(64),

    payload: JSON.stringify(
      prospectivePayload(),
    ),

    status: "pending",
    attempt_count: 0,
    max_attempts: 3,
    available_at: FIXED_TIMESTAMP,
    leased_at: null,
    lease_expires_at: null,
    leased_by: null,
    last_error: null,
    failure_code: null,
    failed_watermark: null,
    covered_report_id: null,
    covered_watermark: null,
    covered_at: null,
    detection_strategy_id: 7,
    strategy_type: "deterministic_rules",
    model_deployment_id: null,
    created_at: FIXED_TIMESTAMP,
    updated_at: FIXED_TIMESTAMP,
    completed_at: null,

    /*
     * Test-only fake-clock state.
     */
    available: true,
    leaseExpired: false,

    ...overrides,
  };
}


function normalizeSql(sql) {
  return String(sql)
    .replace(/\s+/g, " ")
    .trim();
}


function createStatefulOutboxPool(
  initialRows,
) {
  const rows = initialRows;
  const sqlStatements = [];

  function isClaimDetectionJob(job) {
    return (
      job.job_type
      === "claim_detection"
    );
  }

  function recoverExpiredLeases(
    tenantId = null,
  ) {
    let affectedRows = 0;

    for (const job of rows) {
      if (
        !isClaimDetectionJob(job)
        || (
          tenantId
          && job.tenant_id !== tenantId
        )
        || job.status !== "processing"
        || !job.leaseExpired
      ) {
        continue;
      }

      job.status =
        job.attempt_count
          >= job.max_attempts
          ? "dead_letter"
          : "retry";

      job.available = true;
      job.leased_at = null;
      job.lease_expires_at = null;
      job.leased_by = null;
      job.last_error =
        "Worker lease expired before completion.";
      job.failure_code =
        "WORKER_LEASE_EXPIRED";

      job.completed_at =
        job.status === "dead_letter"
          ? FIXED_TIMESTAMP
          : null;

      job.leaseExpired = false;
      affectedRows += 1;
    }

    return affectedRows;
  }

  function deadLetterExhaustedJobs(
    tenantId = null,
  ) {
    let affectedRows = 0;

    for (const job of rows) {
      if (
        !isClaimDetectionJob(job)
        || (
          tenantId
          && job.tenant_id !== tenantId
        )
        || ![
          "pending",
          "retry",
        ].includes(job.status)
        || job.attempt_count
          < job.max_attempts
      ) {
        continue;
      }

      job.status = "dead_letter";

      job.completed_at =
        job.completed_at
        || FIXED_TIMESTAMP;

      job.leased_at = null;
      job.lease_expires_at = null;
      job.leased_by = null;

      job.last_error =
        job.last_error
        || "Maximum processing attempts exhausted.";

      job.failure_code =
        job.failure_code
        || "MAXIMUM_ATTEMPTS_EXHAUSTED";

      affectedRows += 1;
    }

    return affectedRows;
  }

  function leaseCandidates(
    tenantId = null,
  ) {
    return rows.filter(
      (job) => (
        isClaimDetectionJob(job)
        && (
          !tenantId
          || job.tenant_id === tenantId
        )
        && [
          "pending",
          "retry",
        ].includes(job.status)
        && job.attempt_count
          < job.max_attempts
        && job.available
      ),
    );
  }

  const connection = {
    async beginTransaction() {},
    async commit() {},
    async rollback() {},
    release() {},

    async execute(
      sql,
      params = [],
    ) {
      const statement =
        normalizeSql(sql);

      sqlStatements.push({
        sql: statement,
        params,
      });

      if (
        statement.includes(
          "Worker lease expired before completion.",
        )
      ) {
        const tenantId =
          params.length > 1
            ? params[1]
            : null;

        return [
          {
            affectedRows:
              recoverExpiredLeases(
                tenantId,
              ),
          },
        ];
      }

      if (
        statement.includes(
          "Maximum processing attempts exhausted.",
        )
      ) {
        const tenantId =
          params.length > 1
            ? params[1]
            : null;

        return [
          {
            affectedRows:
              deadLetterExhaustedJobs(
                tenantId,
              ),
          },
        ];
      }

      if (
        statement.startsWith(
          "SELECT id FROM claim_processing_outbox",
        )
        && statement.includes(
          "FOR UPDATE SKIP LOCKED",
        )
      ) {
        const tenantId =
          params.length > 1
            ? params[1]
            : null;

        return [
          leaseCandidates(
            tenantId,
          ).map(
            (job) => ({
              id: job.id,
            }),
          ),
        ];
      }

      if (
        statement.startsWith(
          "UPDATE claim_processing_outbox SET status = 'processing'",
        )
      ) {
        const workerId =
          params[1];

        const ids =
          new Set(
            params.slice(
              2,
              -1,
            ),
          );

        let affectedRows = 0;

        for (const job of rows) {
          if (
            ids.has(job.id)
            && isClaimDetectionJob(job)
            && [
              "pending",
              "retry",
            ].includes(job.status)
          ) {
            job.status = "processing";
            job.attempt_count += 1;
            job.leased_at =
              FIXED_TIMESTAMP;
            job.lease_expires_at =
              FIXED_TIMESTAMP;
            job.leased_by =
              workerId;
            job.last_error = null;
            job.failure_code = null;
            job.failed_watermark = null;
            job.available = false;

            affectedRows += 1;
          }
        }

        return [
          {
            affectedRows,
          },
        ];
      }

      if (
        statement.startsWith(
          "SELECT id, tenant_id, job_type",
        )
        && statement.includes(
          "leased_by = ?",
        )
        && statement.includes(
          "status = 'processing'",
        )
      ) {
        const workerId =
          params.at(-1);

        const ids =
          new Set(
            params.slice(
              0,
              -2,
            ),
          );

        return [
          rows.filter(
            (job) => (
              ids.has(job.id)
              && isClaimDetectionJob(job)
              && job.status
                === "processing"
              && job.leased_by
                === workerId
            ),
          ),
        ];
      }

      throw new Error(
        `Unexpected connection SQL: ${statement}`,
      );
    },
  };

  return {
    rows,
    sqlStatements,

    async getConnection() {
      return connection;
    },

    async execute(
      sql,
      params = [],
    ) {
      const statement =
        normalizeSql(sql);

      sqlStatements.push({
        sql: statement,
        params,
      });

      if (
        statement.startsWith(
          "UPDATE claim_processing_outbox SET status = 'completed'",
        )
      ) {
        const [
          id,
          tenantId,
          jobType,
          workerId,
        ] = params;

        const job = rows.find(
          (candidate) => (
            candidate.id === id
            && candidate.tenant_id
              === tenantId
            && candidate.job_type
              === jobType
            && candidate.status
              === "processing"
            && candidate.leased_by
              === workerId
          ),
        );

        if (!job) {
          return [
            {
              affectedRows: 0,
            },
          ];
        }

        job.status = "completed";
        job.completed_at =
          FIXED_TIMESTAMP;
        job.leased_at = null;
        job.lease_expires_at = null;
        job.leased_by = null;
        job.last_error = null;
        job.failure_code = null;
        job.failed_watermark = null;

        return [
          {
            affectedRows: 1,
          },
        ];
      }

      if (
        statement.startsWith(
          "UPDATE claim_processing_outbox SET status = CASE",
        )
      ) {
        const [
          ,
          lastError,
          failureCode,
          failedWatermark,
          id,
          tenantId,
          jobType,
          workerId,
        ] = params;

        const job = rows.find(
          (candidate) => (
            candidate.id === id
            && candidate.tenant_id
              === tenantId
            && candidate.job_type
              === jobType
            && candidate.status
              === "processing"
            && candidate.leased_by
              === workerId
          ),
        );

        if (!job) {
          return [
            {
              affectedRows: 0,
            },
          ];
        }

        const exhausted =
          job.attempt_count
          >= job.max_attempts;

        job.status =
          exhausted
            ? "dead_letter"
            : "retry";

        job.available = false;

        job.completed_at =
          exhausted
            ? FIXED_TIMESTAMP
            : null;

        job.leased_at = null;
        job.lease_expires_at = null;
        job.leased_by = null;
        job.last_error =
          lastError;

        job.failure_code =
          exhausted
            ? "MAXIMUM_ATTEMPTS_EXHAUSTED"
            : failureCode;

        job.failed_watermark =
          failedWatermark;

        return [
          {
            affectedRows: 1,
          },
        ];
      }

      if (
        statement.startsWith(
          "UPDATE claim_processing_outbox SET status = 'dead_letter'",
        )
      ) {
        const [
          lastError,
          failureCode,
          failedWatermark,
          id,
          tenantId,
          jobType,
          workerId,
        ] = params;

        const job = rows.find(
          (candidate) => (
            candidate.id === id
            && candidate.tenant_id
              === tenantId
            && candidate.job_type
              === jobType
            && candidate.status
              === "processing"
            && candidate.leased_by
              === workerId
          ),
        );

        if (!job) {
          return [
            {
              affectedRows: 0,
            },
          ];
        }

        job.status = "dead_letter";
        job.completed_at =
          FIXED_TIMESTAMP;
        job.leased_at = null;
        job.lease_expires_at = null;
        job.leased_by = null;
        job.last_error =
          lastError;
        job.failure_code =
          failureCode;
        job.failed_watermark =
          failedWatermark;

        return [
          {
            affectedRows: 1,
          },
        ];
      }

      if (
        statement.startsWith(
          "SELECT id, tenant_id, job_type",
        )
        && statement.includes(
          "WHERE id = ?",
        )
        && statement.includes(
          "AND tenant_id = ?",
        )
      ) {
        const [
          id,
          tenantId,
          jobType,
        ] = params;

        const job = rows.find(
          (candidate) => (
            candidate.id === id
            && candidate.tenant_id
              === tenantId
            && candidate.job_type
              === jobType
          ),
        );

        return [
          job
            ? [job]
            : [],
        ];
      }

      throw new Error(
        `Unexpected pool SQL: ${statement}`,
      );
    },
  };
}


test(
  "claim-version idempotency ignores target ordering but includes tenant, versions, and strategy identity",
  () => {
    const base = {
      tenantId: "tenant_alpha",
      targets: TARGETS,
      detectionStrategyId: 7,
      strategyType:
        "deterministic_rules",
      modelDeploymentId: null,
    };

    const key =
      createClaimBatchIdempotencyKey(
        base,
      );

    assert.equal(
      createClaimBatchIdempotencyKey({
        ...base,

        targets: [
          TARGETS[1],
          TARGETS[0],
        ],
      }),
      key,
    );

    assert.notEqual(
      createClaimBatchIdempotencyKey({
        ...base,
        tenantId:
          "tenant_beta",
      }),
      key,
    );

    assert.notEqual(
      createClaimBatchIdempotencyKey({
        ...base,

        targets: [
          {
            claim_id: "C-1",
            claim_version: 2,
          },
          TARGETS[0],
        ],
      }),
      key,
    );

    assert.notEqual(
      createClaimBatchIdempotencyKey({
        ...base,
        detectionStrategyId: 8,
      }),
      key,
    );

    assert.notEqual(
      createClaimBatchIdempotencyKey({
        ...base,
        detectionStrategyId: 9,
        strategyType:
          "approved_model",
        modelDeploymentId:
          "claimguard-model:1.1.0",
      }),
      key,
    );
  },
);


test(
  "idempotency rejects multiple versions of the same logical claim",
  () => {
    assert.throws(
      () =>
        createClaimBatchIdempotencyKey({
          tenantId:
            "tenant_alpha",

          targets: [
            {
              claim_id: "C-1",
              claim_version: 1,
            },
            {
              claim_id: "C-1",
              claim_version: 2,
            },
          ],

          detectionStrategyId: 7,
          strategyType:
            "deterministic_rules",
          modelDeploymentId: null,
        }),
      /multiple versions of claim C-1/i,
    );
  },
);


test(
  "concurrent workers cannot lease the same active claim-detection job",
  async () => {
    const pool =
      createStatefulOutboxPool([
        row(),
      ]);

    const repository =
      createClaimProcessingOutboxRepository(
        pool,
      );

    const first =
      await repository
        .leaseNextAvailableJobs({
          workerId: "worker-a",
          limit: 10,
          leaseSeconds: 60,
        });

    const second =
      await repository
        .leaseNextAvailableJobs({
          workerId: "worker-b",
          limit: 10,
          leaseSeconds: 60,
        });

    assert.equal(
      first.length,
      1,
    );

    assert.equal(
      first[0].jobType,
      "claim_detection",
    );

    assert.equal(
      first[0].leasedBy,
      "worker-a",
    );

    assert.equal(
      first[0].detectionStrategyId,
      7,
    );

    assert.deepEqual(
      first[0].payload,
      prospectivePayload(),
    );

    assert.deepEqual(
      second,
      [],
    );

    assert.equal(
      pool.sqlStatements.some(
        ({ sql }) =>
          /FOR UPDATE SKIP LOCKED/i.test(
            sql,
          ),
      ),
      true,
    );
  },
);


test(
  "legacy report-production jobs are never leased by the prospective worker repository",
  async () => {
    const legacy = row({
      id: "legacy-job",
      job_type:
        "report_production",

      payload: JSON.stringify({
        claims: [
          {
            claim_id:
              "C-LEGACY",
          },
        ],
      }),
    });

    const pool =
      createStatefulOutboxPool([
        legacy,
      ]);

    const repository =
      createClaimProcessingOutboxRepository(
        pool,
      );

    assert.deepEqual(
      await repository
        .leaseNextAvailableJobs({
          workerId:
            "prospective-worker",
        }),
      [],
    );

    assert.equal(
      legacy.status,
      "pending",
    );
  },
);


test(
  "expired processing leases are recovered and leased again",
  async () => {
    const expired = row({
      status: "processing",
      attempt_count: 1,
      leased_by:
        "crashed-worker",
      leaseExpired: true,
      available: false,
    });

    const pool =
      createStatefulOutboxPool([
        expired,
      ]);

    const repository =
      createClaimProcessingOutboxRepository(
        pool,
      );

    const leased =
      await repository
        .leaseNextAvailableJobs({
          workerId:
            "recovery-worker",
          limit: 1,
          leaseSeconds: 60,
        });

    assert.equal(
      leased.length,
      1,
    );

    assert.equal(
      leased[0].attemptCount,
      2,
    );

    assert.equal(
      leased[0].leasedBy,
      "recovery-worker",
    );
  },
);


test(
  "completed jobs are not leased again",
  async () => {
    const pool =
      createStatefulOutboxPool([
        row(),
      ]);

    const repository =
      createClaimProcessingOutboxRepository(
        pool,
      );

    const [job] =
      await repository
        .leaseNextAvailableJobs({
          workerId:
            "worker-a",
        });

    assert.equal(
      await repository.markCompleted({
        id: job.id,
        tenantId: job.tenantId,
        workerId: "worker-a",
      }),
      true,
    );

    assert.deepEqual(
      await repository
        .leaseNextAvailableJobs({
          workerId:
            "worker-b",
        }),
      [],
    );
  },
);


test(
  "retry jobs remain unavailable until their scheduled time",
  async () => {
    const retryRow = row();

    const pool =
      createStatefulOutboxPool([
        retryRow,
      ]);

    const repository =
      createClaimProcessingOutboxRepository(
        pool,
      );

    const [job] =
      await repository
        .leaseNextAvailableJobs({
          workerId:
            "worker-a",
        });

    assert.equal(
      await repository.markRetry({
        id: job.id,
        tenantId: job.tenantId,
        workerId: "worker-a",
        delaySeconds: 30,
        lastError:
          "Model service timeout",
        failureCode:
          "MODEL_SERVICE_TIMEOUT",
        failedWatermark:
          "watermark-1",
      }),
      true,
    );

    assert.equal(
      retryRow.status,
      "retry",
    );

    assert.equal(
      retryRow.failure_code,
      "MODEL_SERVICE_TIMEOUT",
    );

    assert.deepEqual(
      await repository
        .leaseNextAvailableJobs({
          workerId:
            "worker-a",
        }),
      [],
    );

    retryRow.available = true;

    const leased =
      await repository
        .leaseNextAvailableJobs({
          workerId:
            "worker-b",
        });

    assert.equal(
      leased.length,
      1,
    );
  },
);


test(
  "an expired exhausted job is dead-lettered instead of leased",
  async () => {
    const exhausted = row({
      status: "processing",
      attempt_count: 3,
      max_attempts: 3,
      leased_by:
        "crashed-worker",
      leaseExpired: true,
      available: false,
    });

    const pool =
      createStatefulOutboxPool([
        exhausted,
      ]);

    const repository =
      createClaimProcessingOutboxRepository(
        pool,
      );

    assert.deepEqual(
      await repository
        .leaseNextAvailableJobs({
          workerId:
            "worker-b",
        }),
      [],
    );

    assert.equal(
      exhausted.status,
      "dead_letter",
    );

    assert.equal(
      exhausted.failure_code,
      "WORKER_LEASE_EXPIRED",
    );

    assert.equal(
      exhausted.completed_at,
      FIXED_TIMESTAMP,
    );
  },
);


test(
  "pending or retry jobs that already exhausted attempts are dead-lettered before selection",
  async () => {
    const exhausted = row({
      status: "retry",
      attempt_count: 3,
      max_attempts: 3,
      available: true,
    });

    const pool =
      createStatefulOutboxPool([
        exhausted,
      ]);

    const repository =
      createClaimProcessingOutboxRepository(
        pool,
      );

    assert.deepEqual(
      await repository
        .leaseNextAvailableJobs({
          workerId:
            "worker-a",
        }),
      [],
    );

    assert.equal(
      exhausted.status,
      "dead_letter",
    );

    assert.equal(
      exhausted.failure_code,
      "MAXIMUM_ATTEMPTS_EXHAUSTED",
    );
  },
);


test(
  "retry at the maximum attempt transitions directly to dead letter",
  async () => {
    const finalAttempt = row({
      attempt_count: 2,
      max_attempts: 3,
    });

    const pool =
      createStatefulOutboxPool([
        finalAttempt,
      ]);

    const repository =
      createClaimProcessingOutboxRepository(
        pool,
      );

    const [job] =
      await repository
        .leaseNextAvailableJobs({
          workerId:
            "worker-a",
        });

    assert.equal(
      job.attemptCount,
      3,
    );

    assert.equal(
      await repository.markRetry({
        id: job.id,
        tenantId: job.tenantId,
        workerId: "worker-a",
        delaySeconds: 30,
        lastError:
          "Final retry failure",
        failureCode:
          "MODEL_SERVICE_TIMEOUT",
      }),
      true,
    );

    assert.equal(
      finalAttempt.status,
      "dead_letter",
    );

    assert.equal(
      finalAttempt.failure_code,
      "MAXIMUM_ATTEMPTS_EXHAUSTED",
    );
  },
);


test(
  "job status inspection is tenant-scoped and requires a complete pool interface",
  async () => {
    const statusRow = row({
      status: "completed",
      completed_at:
        FIXED_TIMESTAMP,
    });

    const pool =
      createStatefulOutboxPool([
        statusRow,
      ]);

    const repository =
      createClaimProcessingOutboxRepository(
        pool,
      );

    const visible =
      await repository.getJobStatus({
        id: statusRow.id,
        tenantId:
          "tenant_alpha",
      });

    assert.equal(
      visible.status,
      "completed",
    );

    assert.equal(
      visible.detectionStrategyId,
      7,
    );

    assert.equal(
      await repository.getJobStatus({
        id: statusRow.id,
        tenantId:
          "tenant_beta",
      }),
      null,
    );
  },
);
