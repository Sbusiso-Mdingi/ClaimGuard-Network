import assert from "node:assert/strict";
import test from "node:test";

import { applyControlPlaneMigrations, createControlPlanePool, getControlPlaneMigrationStatus } from "../src/index.js";

const databaseUrl = process.env.CONTROL_PLANE_TEST_MYSQL_URL || "";

test("real MySQL clean/repeated migration and constraints", { skip: !databaseUrl }, async () => {
  const pool = createControlPlanePool(databaseUrl);
  try {
    const first = await applyControlPlaneMigrations(pool, { applicationVersion: "integration-test" });
    const second = await applyControlPlaneMigrations(pool, { applicationVersion: "integration-test" });
    const status = await getControlPlaneMigrationStatus(pool);
    assert.equal(first.applied.length + first.skipped.length, 5);
    assert.equal(second.applied.length, 0);
    assert.equal(status.pending.length, 0);
    const [forbidden] = await pool.execute(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = DATABASE() AND table_name IN
        ('claims', 'members', 'providers', 'investigations', 'ledger_entries', 'shared_fraud_registry_entries', 'simulation_instances')`,
    );
    assert.deepEqual(forbidden, []);
  } finally {
    await pool.end();
  }
});
