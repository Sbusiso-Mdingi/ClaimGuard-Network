import assert from "node:assert/strict";
import test from "node:test";

import {
  createClaimBatchIdempotencyKey,
  createClaimProcessingOutboxRepository,
} from "../src/index.js";

function row(overrides = {}) {
  return {
    id: "job-1",
    tenant_id: "tenant_alpha",
    job_type: "report_production",
    aggregate_type: "claim_batch",
    aggregate_id: "aggregate-1",
    correlation_id: "request-1",
    idempotency_key: "a".repeat(64),
    payload: JSON.stringify({ claims: [{ claim_id: "C-1" }] }),
    status: "pending",
    attempt_count: 0,
    max_attempts: 3,
    available: true,
    lease_expired: false,
    leased_by: null,
    ...overrides,
  };
}

function createStatefulOutboxPool(initialRows) {
  const rows = initialRows;
  const sqlStatements = [];

  function candidates() {
    return rows.filter((job) => ["pending", "retry"].includes(job.status) && job.available);
  }

  const connection = {
    async beginTransaction() {},
    async commit() {},
    async rollback() {},
    release() {},
    async execute(sql, params = []) {
      sqlStatements.push(sql);
      if (/UPDATE claim_processing_outbox[\s\S]*lease expired before completion/i.test(sql)) {
        let affectedRows = 0;
        for (const job of rows) {
          if (job.status === "processing" && job.lease_expired) {
            job.status = job.attempt_count >= job.max_attempts ? "dead_letter" : "retry";
            job.available = true;
            job.leased_by = null;
            job.lease_expired = false;
            affectedRows += 1;
          }
        }
        return [{ affectedRows }];
      }
      if (/SELECT id[\s\S]*FOR UPDATE SKIP LOCKED/i.test(sql)) {
        return [candidates().map(({ id }) => ({ id }))];
      }
      if (/SET[\s\S]*status = 'processing'/i.test(sql)) {
        const workerId = params[1];
        const ids = new Set(params.slice(2));
        for (const job of rows) {
          if (ids.has(job.id)) {
            job.status = "processing";
            job.attempt_count += 1;
            job.leased_by = workerId;
          }
        }
        return [{ affectedRows: ids.size }];
      }
      if (/SELECT \*[\s\S]*leased_by = \?/i.test(sql)) {
        const workerId = params.at(-1);
        return [rows.filter((job) => job.status === "processing" && job.leased_by === workerId)];
      }
      throw new Error(`Unexpected connection SQL: ${sql}`);
    },
  };

  return {
    rows,
    sqlStatements,
    async getConnection() {
      return connection;
    },
    async execute(sql, params) {
      sqlStatements.push(sql);
      const [id, tenantId, workerId] = params.slice(-3);
      const job = rows.find((candidate) => candidate.id === id && candidate.tenant_id === tenantId);
      if (!job || job.status !== "processing" || job.leased_by !== workerId) {
        return [{ affectedRows: 0 }];
      }
      if (/status = 'completed'/i.test(sql)) {
        job.status = "completed";
        job.leased_by = null;
      } else if (/status = 'retry'/i.test(sql)) {
        job.status = "retry";
        job.available = false;
        job.leased_by = null;
      } else if (/status = 'dead_letter'/i.test(sql)) {
        job.status = "dead_letter";
        job.leased_by = null;
      }
      return [{ affectedRows: 1 }];
    },
  };
}

test("claim batch idempotency ignores ordering but includes canonical tenant and content", () => {
  const claims = [
    { claim_id: "C-2", amount: 20 },
    { amount: 10, claim_id: "C-1" },
  ];
  const key = createClaimBatchIdempotencyKey({ tenantId: "tenant_alpha", claims });

  assert.equal(
    createClaimBatchIdempotencyKey({
      tenantId: "tenant_alpha",
      claims: [{ claim_id: "C-1", amount: 10 }, { amount: 20, claim_id: "C-2" }],
    }),
    key,
  );
  assert.notEqual(createClaimBatchIdempotencyKey({ tenantId: "tenant_beta", claims }), key);
  assert.notEqual(
    createClaimBatchIdempotencyKey({ tenantId: "tenant_alpha", claims: [{ claim_id: "C-1", amount: 11 }] }),
    key,
  );
});

test("concurrent workers cannot lease the same active job", async () => {
  const pool = createStatefulOutboxPool([row()]);
  const repository = createClaimProcessingOutboxRepository(pool);

  const first = await repository.leaseNextAvailableJobs({ workerId: "worker-a", limit: 10, leaseSeconds: 60 });
  const second = await repository.leaseNextAvailableJobs({ workerId: "worker-b", limit: 10, leaseSeconds: 60 });

  assert.equal(first.length, 1);
  assert.equal(first[0].leasedBy, "worker-a");
  assert.equal(second.length, 0);
  assert.ok(pool.sqlStatements.some((sql) => /FOR UPDATE SKIP LOCKED/i.test(sql)));
});

test("expired processing leases are recovered and can be leased again", async () => {
  const pool = createStatefulOutboxPool([
    row({ status: "processing", attempt_count: 1, leased_by: "crashed-worker", lease_expired: true }),
  ]);
  const repository = createClaimProcessingOutboxRepository(pool);

  const leased = await repository.leaseNextAvailableJobs({ workerId: "recovery-worker", limit: 1, leaseSeconds: 60 });

  assert.equal(leased.length, 1);
  assert.equal(leased[0].attemptCount, 2);
  assert.equal(leased[0].leasedBy, "recovery-worker");
});

test("completed jobs are not leased again", async () => {
  const pool = createStatefulOutboxPool([row()]);
  const repository = createClaimProcessingOutboxRepository(pool);
  const [job] = await repository.leaseNextAvailableJobs({ workerId: "worker-a" });

  assert.equal(await repository.markCompleted({ id: job.id, tenantId: job.tenantId, workerId: "worker-a" }), true);
  assert.deepEqual(await repository.leaseNextAvailableJobs({ workerId: "worker-b" }), []);
});

test("retry jobs remain unavailable until their available time", async () => {
  const retryRow = row();
  const pool = createStatefulOutboxPool([retryRow]);
  const repository = createClaimProcessingOutboxRepository(pool);

  const [job] = await repository.leaseNextAvailableJobs({ workerId: "worker-a" });
  assert.equal(await repository.markRetry({
    id: job.id,
    tenantId: job.tenantId,
    workerId: "worker-a",
    delaySeconds: 30,
    lastError: "TimeoutError",
  }), true);
  assert.deepEqual(await repository.leaseNextAvailableJobs({ workerId: "worker-a" }), []);
  retryRow.available = true;
  const leased = await repository.leaseNextAvailableJobs({ workerId: "worker-b" });
  assert.equal(leased.length, 1);
});

test("an expired exhausted job is dead-lettered instead of leased", async () => {
  const exhausted = row({
    status: "processing",
    attempt_count: 3,
    max_attempts: 3,
    leased_by: "crashed-worker",
    lease_expired: true,
  });
  const pool = createStatefulOutboxPool([exhausted]);
  const repository = createClaimProcessingOutboxRepository(pool);

  assert.deepEqual(await repository.leaseNextAvailableJobs({ workerId: "worker-b" }), []);
  assert.equal(exhausted.status, "dead_letter");
});

test("job status inspection is tenant-scoped", async () => {
  const statusRow = row({ status: "completed" });
  const pool = {
    async execute(_sql, params) {
      return [[params[1] === statusRow.tenant_id ? statusRow : null].filter(Boolean)];
    },
  };
  const repository = createClaimProcessingOutboxRepository(pool);

  assert.equal((await repository.getJobStatus({ id: statusRow.id, tenantId: "tenant_alpha" })).status, "completed");
  assert.equal(await repository.getJobStatus({ id: statusRow.id, tenantId: "tenant_beta" }), null);
});
