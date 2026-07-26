import assert from "node:assert/strict";
import test from "node:test";

import { createInvestigationQueueRepository } from "../src/investigation-queue-repository.js";
import { runWithTenantContext } from "../src/index.js";

function tenantContext(tenantId) {
  return { tenant_id: tenantId, tenant_slug: tenantId, scheme_id: null, source: "test" };
}

function createPool() {
  const calls = [];
  return {
    calls,
    async execute(sql, params) {
      const statement = String(sql).replace(/\s+/g, " ").trim();
      calls.push({ statement, params });
      if (statement.startsWith("SELECT COUNT(*) AS total")) return [[{ total: 1 }]];
      return [[{
        investigation_id: "INV-2",
        claim_id: "CLAIM-2",
        assigned_investigator: "investigator-alpha",
        assigned_by: "analyst-alpha",
        status: "UNDER_REVIEW",
        priority: "HIGH",
        created_at: "2026-07-24T10:00:00.000Z",
        updated_at: "2026-07-25T10:00:00.000Z",
        closed_at: null,
        fraud_confirmed_at: null,
        reversed_at: null,
        note_count: 2,
        evidence_count: 1,
      }]];
    },
  };
}

test("investigation queue pins every query to the active tenant and applies filters", async () => {
  const pool = createPool();
  const repository = createInvestigationQueueRepository(pool, { allowLegacyTenantContext: true });

  const result = await runWithTenantContext(tenantContext("tenant-alpha"), () => repository.listInvestigations({
    page: 2,
    pageSize: 10,
    status: "under review",
    priority: "high",
    search: "CLAIM-2",
    assignment: "mine",
    actorId: "investigator-alpha",
  }));

  assert.equal(result.investigations[0].investigationId, "INV-2");
  assert.equal(result.investigations[0].noteCount, 2);
  assert.equal(result.pagination.page, 2);
  assert.equal(result.filters.status, "UNDER_REVIEW");
  assert.equal(pool.calls.length, 2);
  for (const call of pool.calls) {
    assert.match(call.statement, /i\.tenant_id = \?/);
    assert.equal(call.params[0], "tenant-alpha");
  }
  assert.deepEqual(pool.calls[1].params, [
    "tenant-alpha",
    "UNDER_REVIEW",
    "HIGH",
    "%CLAIM-2%",
    "%CLAIM-2%",
    "investigator-alpha",
  ]);
  assert.match(pool.calls[1].statement, /LIMIT 10 OFFSET 10$/);
});

test("mine filter requires an authenticated actor", async () => {
  const repository = createInvestigationQueueRepository(createPool(), { allowLegacyTenantContext: true });
  await assert.rejects(
    () => runWithTenantContext(tenantContext("tenant-alpha"), () => repository.listInvestigations({ assignment: "mine" })),
    /authenticated actor is required/i,
  );
});
