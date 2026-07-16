import assert from "node:assert/strict";
import test from "node:test";

import {
  applyControlPlaneMigrations,
  getControlPlaneMigrationStatus,
  loadControlPlaneMigrations,
  MigrationChecksumMismatchError,
  MigrationExecutionError,
} from "../src/index.js";

function createFakePool({ failPattern = null } = {}) {
  const history = new Map();
  const executed = [];
  const state = { begins: 0, commits: 0, rollbacks: 0 };
  const connection = {
    async query(sql, params = []) {
      const normalized = String(sql).replace(/\s+/g, " ").trim();
      if (normalized.startsWith("SELECT GET_LOCK")) return [[{ acquired: 1 }], []];
      if (normalized.startsWith("SELECT RELEASE_LOCK")) return [[{ released: 1 }], []];
      if (normalized.startsWith("CREATE TABLE IF NOT EXISTS control_plane_migration_history")) return [[], []];
      if (normalized.startsWith("SELECT migration_id, checksum, applied_at")) return [[...history.values()], []];
      if (normalized === "SELECT migration_id, checksum FROM control_plane_migration_history ORDER BY migration_id") {
        return [[...history.values()].map(({ migration_id, checksum }) => ({ migration_id, checksum })), []];
      }
      if (normalized.startsWith("INSERT INTO control_plane_migration_history")) {
        history.set(params[0], {
          migration_id: params[0], checksum: params[1], execution_duration_ms: params[2],
          application_version: params[3], applied_at: new Date(),
        });
        return [{ affectedRows: 1 }, []];
      }
      executed.push(normalized);
      if (failPattern && normalized.includes(failPattern)) {
        const error = new Error("simulated partial migration failure");
        error.code = "ER_SIMULATED";
        throw error;
      }
      return [[], []];
    },
    async beginTransaction() { state.begins += 1; },
    async commit() { state.commits += 1; },
    async rollback() { state.rollbacks += 1; },
    release() {},
  };
  return { history, executed, state, async getConnection() { return connection; } };
}

test("clean migrations record checksums and repeat without replay", async () => {
  const pool = createFakePool();
  const migrations = await loadControlPlaneMigrations();
  const first = await applyControlPlaneMigrations(pool, { applicationVersion: "test-version" });
  const statementCount = pool.executed.length;
  const repeated = await applyControlPlaneMigrations(pool, { applicationVersion: "test-version" });

  assert.equal(first.applied.length, migrations.length);
  assert.equal(pool.history.size, migrations.length);
  assert.equal(repeated.applied.length, 0);
  assert.deepEqual(repeated.skipped, migrations.map((migration) => migration.id));
  assert.equal(pool.executed.length, statementCount);
  assert.equal([...pool.history.values()].every((row) => /^[a-f0-9]{64}$/.test(row.checksum)), true);
});

test("migration status reports exact applied and pending migrations", async () => {
  const pool = createFakePool();
  const before = await getControlPlaneMigrationStatus(pool);
  assert.equal(before.applied.length, 0);
  assert.equal(before.pending.length, 4);
  await applyControlPlaneMigrations(pool);
  const after = await getControlPlaneMigrationStatus(pool);
  assert.equal(after.applied.length, 4);
  assert.equal(after.pending.length, 0);
});

test("changed checksum for an applied migration is rejected", async () => {
  const pool = createFakePool();
  await applyControlPlaneMigrations(pool);
  const first = pool.history.values().next().value;
  first.checksum = "0".repeat(64);
  await assert.rejects(() => getControlPlaneMigrationStatus(pool), MigrationChecksumMismatchError);
});

test("partial migration failure is visible and history is not recorded", async () => {
  const pool = createFakePool({ failPattern: "CREATE TABLE IF NOT EXISTS users" });
  await assert.rejects(() => applyControlPlaneMigrations(pool), MigrationExecutionError);
  assert.equal(pool.history.size, 0);
  assert.equal(pool.state.rollbacks, 1);
});
