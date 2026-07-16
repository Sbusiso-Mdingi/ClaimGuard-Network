import assert from "node:assert/strict";
import test from "node:test";

import {
  ClaimOwnershipConflictError,
  createClaimIngestionRepository,
  runWithTenantContext,
} from "../src/index.js";

function createFakePool() {
  const executions = [];
  let outboxRow = null;

  return {
    executions,
    async getConnection() {
      return {
        async beginTransaction() {},
        async execute(sql, params) {
          executions.push({ sql, params });
          if (/SELECT tenant_id FROM claims/i.test(sql)) {
            return [[]];
          }
          if (/INSERT INTO claim_processing_outbox/i.test(sql)) {
            const [id, tenant_id, job_type, aggregate_type, aggregate_id, correlation_id, idempotency_key, payload, max_attempts] = params;
            outboxRow = {
              id,
              tenant_id,
              job_type,
              aggregate_type,
              aggregate_id,
              correlation_id,
              idempotency_key,
              payload,
              status: "pending",
              attempt_count: 0,
              max_attempts,
            };
            return [{ affectedRows: 1 }];
          }
          if (/FROM claim_processing_outbox/i.test(sql)) {
            return [[outboxRow]];
          }
          return [{ affectedRows: 1 }];
        },
        async commit() {},
        async rollback() {},
        release() {},
      };
    },
  };
}

test("claim ingestion repository inserts claims through transaction", async () => {
  const pool = createFakePool();
  const repository = createClaimIngestionRepository(pool);

  const result = await repository.ingestClaims({
    source: "synthetic-run",
    claims: [
      {
        claim_id: "C-100",
        scheme_id: "scheme_a",
        member_id: "M-1",
        provider_id: "P-1",
        service_date: "2025-01-15",
        billing_code: "CONSULT",
        amount: 233.19,
      },
    ],
  });

  assert.equal(result.received, 1);
  assert.equal(result.inserted, 1);
  assert.equal(result.updated, 0);
  assert.equal(result.source, "synthetic-run");
  assert.equal(result.processing.status, "queued");
  assert.equal(result.processing.asynchronous, true);
  assert.equal(pool.executions.length, 4);
  assert.match(pool.executions[1].sql, /INSERT INTO claims/i);
  assert.equal(pool.executions[1].params[7], "tenant_default");
  assert.match(pool.executions[2].sql, /INSERT INTO claim_processing_outbox/i);
  assert.equal(pool.executions[2].params[1], "tenant_default");
});

test("claim ingestion repository validates required fields", async () => {
  const pool = createFakePool();
  const repository = createClaimIngestionRepository(pool);

  await assert.rejects(
    () =>
      repository.ingestClaims({
        claims: [
          {
            claim_id: "C-101",
            scheme_id: "scheme_a",
          },
        ],
      }),
    /missing required fields/i,
  );
});

test("claim ingestion repository persists tenant_id from active tenant context", async () => {
  const pool = createFakePool();
  const repository = createClaimIngestionRepository(pool);

  await runWithTenantContext(
    {
      tenant_id: "tenant_alpha",
      tenant_slug: "alpha",
      scheme_id: null,
      source: "header",
    },
    async () => {
      await repository.ingestClaims({
        source: "api",
        claims: [
          {
            claim_id: "C-102",
            scheme_id: "scheme_a",
            member_id: "M-2",
            provider_id: "P-2",
            service_date: "2025-01-16",
            billing_code: "XRAY",
            amount: 100.0,
          },
        ],
      });
    },
  );

  assert.equal(pool.executions.length, 4);
  assert.equal(pool.executions[1].params[7], "tenant_alpha");
  assert.match(pool.executions[1].sql, /tenant_id/i);
  assert.equal(pool.executions[2].params[1], "tenant_alpha");
});

function createStatefulClaimPool({ failClaimInsert = false, failOutboxInsert = false } = {}) {
  const claims = new Map();
  const outbox = new Map();
  let rollbackCount = 0;

  return {
    claims,
    outbox,
    get rollbackCount() {
      return rollbackCount;
    },
    async getConnection() {
      let transactionSnapshot = null;
      let outboxSnapshot = null;
      return {
        async beginTransaction() {
          transactionSnapshot = new Map([...claims].map(([id, claim]) => [id, { ...claim }]));
          outboxSnapshot = new Map([...outbox].map(([id, job]) => [id, { ...job }]));
        },
        async execute(sql, params) {
          if (/SELECT tenant_id FROM claims/i.test(sql)) {
            const claim = claims.get(params[0]);
            return [claim ? [{ tenant_id: claim.tenant_id }] : []];
          }
          if (/INSERT INTO claims/i.test(sql)) {
            if (failClaimInsert) {
              throw new Error("claim insert failed");
            }
            const [claim_id, scheme_id, member_id, provider_id, service_date, billing_code, amount, tenant_id] = params;
            if (claims.has(claim_id)) {
              const error = new Error("duplicate");
              error.code = "ER_DUP_ENTRY";
              throw error;
            }
            claims.set(claim_id, { claim_id, scheme_id, member_id, provider_id, service_date, billing_code, amount, tenant_id });
            return [{ affectedRows: 1 }];
          }
          if (/UPDATE claims/i.test(sql)) {
            const [scheme_id, member_id, provider_id, service_date, billing_code, amount, claim_id, tenant_id] = params;
            const existing = claims.get(claim_id);
            if (existing?.tenant_id === tenant_id) {
              claims.set(claim_id, { ...existing, scheme_id, member_id, provider_id, service_date, billing_code, amount });
              return [{ affectedRows: 1 }];
            }
            return [{ affectedRows: 0 }];
          }
          if (/INSERT INTO claim_processing_outbox/i.test(sql)) {
            if (failOutboxInsert) {
              throw new Error("outbox insert failed");
            }
            const [id, tenant_id, job_type, aggregate_type, aggregate_id, correlation_id, idempotency_key, payload, max_attempts] = params;
            const key = `${tenant_id}:${idempotency_key}`;
            if (!outbox.has(key)) {
              outbox.set(key, {
                id,
                tenant_id,
                job_type,
                aggregate_type,
                aggregate_id,
                correlation_id,
                idempotency_key,
                payload,
                status: "pending",
                attempt_count: 0,
                max_attempts,
              });
              return [{ affectedRows: 1 }];
            }
            return [{ affectedRows: 0 }];
          }
          if (/FROM claim_processing_outbox/i.test(sql)) {
            return [[outbox.get(`${params[0]}:${params[1]}`)].filter(Boolean)];
          }
          throw new Error(`Unexpected SQL: ${sql}`);
        },
        async commit() {
          transactionSnapshot = null;
        },
        async rollback() {
          rollbackCount += 1;
          claims.clear();
          for (const [id, claim] of transactionSnapshot || []) claims.set(id, claim);
          outbox.clear();
          for (const [id, job] of outboxSnapshot || []) outbox.set(id, job);
        },
        release() {},
      };
    },
  };
}

function claimInput(amount) {
  return {
    claim_id: "C-IMMUTABLE",
    scheme_id: "scheme_a",
    member_id: "M-1",
    provider_id: "P-1",
    service_date: "2026-07-16",
    billing_code: "CONSULT",
    amount,
  };
}

test("claim ownership is immutable while same-tenant updates remain idempotent", async () => {
  const pool = createStatefulClaimPool();
  const repository = createClaimIngestionRepository(pool);

  await runWithTenantContext({ tenant_id: "tenant_alpha" }, () =>
    repository.ingestClaims({ claims: [claimInput(100)] }),
  );
  const update = await runWithTenantContext({ tenant_id: "tenant_alpha" }, () =>
    repository.ingestClaims({ claims: [claimInput(125)] }),
  );

  await assert.rejects(
    () => runWithTenantContext({ tenant_id: "tenant_beta" }, () =>
      repository.ingestClaims({ claims: [claimInput(999)] }),
    ),
    ClaimOwnershipConflictError,
  );

  assert.equal(update.inserted, 0);
  assert.equal(update.updated, 1);
  assert.equal(pool.claims.get("C-IMMUTABLE").tenant_id, "tenant_alpha");
  assert.equal(pool.claims.get("C-IMMUTABLE").amount, 125);
  assert.equal(pool.outbox.size, 2);
  assert.equal(pool.rollbackCount, 1);
});

test("claim and outbox creation commit together and identical retries reuse one job", async () => {
  const pool = createStatefulClaimPool();
  const repository = createClaimIngestionRepository(pool);

  const first = await runWithTenantContext({ tenant_id: "tenant_alpha" }, () =>
    repository.ingestClaims({ claims: [claimInput(100)], correlationId: "request-1" }),
  );
  const retry = await runWithTenantContext({ tenant_id: "tenant_alpha" }, () =>
    repository.ingestClaims({ claims: [claimInput(100)], correlationId: "request-2" }),
  );

  assert.equal(pool.claims.size, 1);
  assert.equal(pool.outbox.size, 1);
  assert.equal(first.processing.reused, false);
  assert.equal(retry.processing.reused, true);
  assert.equal(retry.processing.jobId, first.processing.jobId);
  assert.equal(retry.processing.correlationId, "request-1");
});

test("outbox enqueue failure rolls back the claim write", async () => {
  const pool = createStatefulClaimPool({ failOutboxInsert: true });
  const repository = createClaimIngestionRepository(pool);

  await assert.rejects(
    () => runWithTenantContext({ tenant_id: "tenant_alpha" }, () =>
      repository.ingestClaims({ claims: [claimInput(100)] }),
    ),
    /outbox insert failed/,
  );

  assert.equal(pool.claims.size, 0);
  assert.equal(pool.outbox.size, 0);
  assert.equal(pool.rollbackCount, 1);
});

test("claim failure creates no outbox job", async () => {
  const pool = createStatefulClaimPool({ failClaimInsert: true });
  const repository = createClaimIngestionRepository(pool);

  await assert.rejects(
    () => runWithTenantContext({ tenant_id: "tenant_alpha" }, () =>
      repository.ingestClaims({ claims: [claimInput(100)] }),
    ),
    /claim insert failed/,
  );

  assert.equal(pool.claims.size, 0);
  assert.equal(pool.outbox.size, 0);
});

test("ownership conflict rolls back without creating an outbox job", async () => {
  const pool = createStatefulClaimPool();
  const repository = createClaimIngestionRepository(pool);
  await runWithTenantContext({ tenant_id: "tenant_alpha" }, () =>
    repository.ingestClaims({ claims: [claimInput(100)] }),
  );

  await assert.rejects(
    () => runWithTenantContext({ tenant_id: "tenant_beta" }, () =>
      repository.ingestClaims({ claims: [claimInput(100)] }),
    ),
    ClaimOwnershipConflictError,
  );

  assert.equal(pool.outbox.size, 1);
  assert.equal([...pool.outbox.values()][0].tenant_id, "tenant_alpha");
});
