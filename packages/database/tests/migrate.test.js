import assert from "node:assert/strict";
import test from "node:test";

import { applyMigrations, getOperationalMigrationStatus } from "../src/index.js";

function createFakePool() {
  const statements = [];
  const history = new Map();

  return {
    statements,
    history,
    async query(statement, params = []) {
      statements.push(statement);
      if (String(statement).includes("GET_LOCK")) return [[{ acquired: 1 }], []];
      if (String(statement).includes("RELEASE_LOCK")) return [[{ released: 1 }], []];
      if (String(statement).includes("SELECT migration_id, checksum, applied_at")) return [[...history.values()], []];
      if (String(statement).includes("SELECT migration_id, checksum FROM operational_migration_history")) {
        return [[...history.values()].map(({ migration_id, checksum }) => ({ migration_id, checksum })), []];
      }
      if (String(statement).includes("INSERT INTO operational_migration_history")) {
        const [migration_id, checksum, execution_duration_ms, application_version] = params;
        history.set(migration_id, { migration_id, checksum, execution_duration_ms, application_version, applied_at: new Date() });
      }
      return [[], []];
    },
  };
}

test("applyMigrations executes, records, checksum-validates, and skips all schema migrations", async () => {
  const pool = createFakePool();
  const first = await applyMigrations(pool);
  const statementCountAfterFirst = pool.statements.length;
  const second = await applyMigrations(pool);
  const status = await getOperationalMigrationStatus(pool);

  assert.equal(first.appliedStatements > 0, true);
  assert.equal(first.applied.length, 9);
  assert.equal(second.appliedStatements, 0);
  assert.equal(second.applied.length, 0);
  assert.equal(second.skipped.length, 9);
  assert.equal(status.pending.length, 0);
  assert.equal(pool.statements.slice(statementCountAfterFirst).some((statement) => String(statement).includes("ALTER TABLE claims ADD COLUMN")), false);
  assert.ok(pool.statements.some((statement) => String(statement).includes("CREATE TABLE IF NOT EXISTS ledger_entries")));
  assert.ok(pool.statements.some((statement) => String(statement).includes("CREATE TABLE IF NOT EXISTS claims")));
  assert.ok(pool.statements.some((statement) => String(statement).includes("CREATE TABLE IF NOT EXISTS investigations")));
  assert.ok(pool.statements.some((statement) => String(statement).includes("CREATE TABLE IF NOT EXISTS investigation_notes")));
  assert.ok(pool.statements.some((statement) => String(statement).includes("CREATE TABLE IF NOT EXISTS investigation_evidence")));
  assert.ok(pool.statements.some((statement) => String(statement).includes("CREATE TABLE IF NOT EXISTS claim_processing_outbox")));
  assert.ok(pool.statements.some((statement) => String(statement).includes("CREATE TABLE IF NOT EXISTS ledger_chain_heads")));
  assert.ok(pool.statements.some((statement) => String(statement).includes("CREATE TABLE IF NOT EXISTS fraud_workflow_operations")));
  assert.ok(pool.statements.some((statement) => String(statement).includes("ADD COLUMN covered_report_id")));
  assert.ok(pool.statements.some((statement) => String(statement).includes("CREATE TABLE IF NOT EXISTS simulation_instances")));
  assert.ok(pool.statements.some((statement) => String(statement).includes("CREATE TABLE IF NOT EXISTS simulation_leases")));
  assert.ok(pool.statements.some((statement) => String(statement).includes("CREATE TABLE IF NOT EXISTS simulation_tick_history")));
  assert.ok(pool.statements.some((statement) => String(statement).includes("CREATE TABLE IF NOT EXISTS data_plane_metadata")));
  assert.ok(pool.statements.some((statement) => String(statement).includes("chk_data_plane_metadata_singleton")));
});

test("applyMigrations fails closed when an applied checksum changes", async () => {
  const pool = createFakePool();
  await applyMigrations(pool);
  pool.history.get("0008_data_plane_metadata").checksum = "0".repeat(64);
  await assert.rejects(
    () => applyMigrations(pool),
    (error) => error.code === "OPERATIONAL_MIGRATION_CHECKSUM_MISMATCH",
  );
});
