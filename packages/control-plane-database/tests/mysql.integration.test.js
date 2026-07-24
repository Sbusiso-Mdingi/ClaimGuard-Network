import assert from "node:assert/strict";
import test from "node:test";

import {
  applyControlPlaneMigrations,
  createControlPlanePool,
  getControlPlaneMigrationStatus,
  loadControlPlaneMigrations,
} from "../src/index.js";


const databaseUrl =
  process.env
    .CONTROL_PLANE_TEST_MYSQL_URL
  || "";


test(
  "real MySQL clean/repeated migration and constraints",
  {
    skip:
      !databaseUrl,
  },
  async () => {
    const pool =
      createControlPlanePool(
        databaseUrl,
      );

    try {
      const migrations =
        await loadControlPlaneMigrations();

      assert.ok(
        migrations.length > 0,
        "The control-plane migration inventory must not be empty.",
      );

      const expectedMigrationCount =
        migrations.length;

      const first =
        await applyControlPlaneMigrations(
          pool,
          {
            applicationVersion:
              "integration-test",
          },
        );

      const second =
        await applyControlPlaneMigrations(
          pool,
          {
            applicationVersion:
              "integration-test",
          },
        );

      const status =
        await getControlPlaneMigrationStatus(
          pool,
        );

      /*
       * A clean database applies every migration.
       * A reused integration database may report some
       * or all of them as skipped.
       */
      assert.equal(
        first.applied.length
        + first.skipped.length,
        expectedMigrationCount,
      );

      /*
       * Repeating the migration run must not replay
       * any completed migration.
       */
      assert.equal(
        second.applied.length,
        0,
      );

      assert.equal(
        second.skipped.length,
        expectedMigrationCount,
      );

      assert.equal(
        status.applied.length,
        expectedMigrationCount,
      );

      assert.equal(
        status.pending.length,
        0,
      );

      const expectedMigrationIds =
        migrations.map(
          ({
            id,
          }) =>
            id,
        );

      assert.deepEqual(
        status.applied.map(
          ({
            id,
          }) =>
            id,
        ),
        expectedMigrationIds,
      );

      /*
       * Operational and medical-domain tables must
       * never be created in the control plane.
       */
      const [
        forbidden,
      ] =
        await pool.execute(
          `
            SELECT
              table_name
            FROM information_schema.tables
            WHERE table_schema =
              DATABASE()
              AND table_name IN (
                'claims',
                'members',
                'providers',
                'investigations',
                'ledger_entries',
                'shared_fraud_registry_entries',
                'simulation_instances',
                'claim_versions',
                'claim_processing_outbox',
                'claim_detection_results',
                'detection_strategies'
              )
            ORDER BY table_name
          `,
        );

      assert.deepEqual(
        forbidden,
        [],
      );
    } finally {
      await pool.end();
    }
  },
);
