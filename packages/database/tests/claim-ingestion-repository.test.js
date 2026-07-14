import assert from "node:assert/strict";
import test from "node:test";

import { createClaimIngestionRepository, runWithTenantContext } from "../src/index.js";

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
  assert.equal(pool.executions[0].params[7], "tenant_default");
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

  assert.equal(pool.executions.length, 1);
  assert.equal(pool.executions[0].params[7], "tenant_alpha");
  assert.match(pool.executions[0].sql, /tenant_id/i);
});
