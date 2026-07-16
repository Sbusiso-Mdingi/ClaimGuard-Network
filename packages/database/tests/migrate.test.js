import assert from "node:assert/strict";
import test from "node:test";

import { applyMigrations } from "../src/index.js";

function createFakePool() {
  const statements = [];

  return {
    statements,
    async query(statement) {
      statements.push(statement);
      return [[], []];
    },
  };
}

test("applyMigrations executes all schema statements", async () => {
  const pool = createFakePool();
  const result = await applyMigrations(pool);

  assert.equal(result.appliedStatements > 0, true);
  assert.ok(pool.statements.some((statement) => String(statement).includes("CREATE TABLE IF NOT EXISTS ledger_entries")));
  assert.ok(pool.statements.some((statement) => String(statement).includes("CREATE TABLE IF NOT EXISTS claims")));
  assert.ok(pool.statements.some((statement) => String(statement).includes("CREATE TABLE IF NOT EXISTS investigations")));
  assert.ok(pool.statements.some((statement) => String(statement).includes("CREATE TABLE IF NOT EXISTS investigation_notes")));
  assert.ok(pool.statements.some((statement) => String(statement).includes("CREATE TABLE IF NOT EXISTS investigation_evidence")));
  assert.ok(pool.statements.some((statement) => String(statement).includes("CREATE TABLE IF NOT EXISTS claim_processing_outbox")));
  assert.ok(pool.statements.some((statement) => String(statement).includes("CREATE TABLE IF NOT EXISTS ledger_chain_heads")));
  assert.ok(pool.statements.some((statement) => String(statement).includes("CREATE TABLE IF NOT EXISTS fraud_workflow_operations")));
});
