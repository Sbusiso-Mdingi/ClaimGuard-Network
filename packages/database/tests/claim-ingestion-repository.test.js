import assert from "node:assert/strict";
import test from "node:test";

import { createClaimIngestionRepository } from "../src/index.js";

function createFakePool() {
  const executions = [];

  return {
    executions,
    async getConnection() {
      return {
        async beginTransaction() {},
        async execute(sql, params) {
          executions.push({ sql, params });
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
  assert.equal(pool.executions.length, 1);
  assert.match(pool.executions[0].sql, /INSERT INTO claims/i);
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
