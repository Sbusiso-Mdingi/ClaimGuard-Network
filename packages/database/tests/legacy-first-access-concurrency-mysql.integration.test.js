import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";

import {
  applyMigrations,
  CASE_STATE,
  createMysqlConnection,
  createOperationalRepositories,
} from "../src/index.js";
import {
  countRows,
  createLegacyInvestigation,
  legacyDataPlaneContext,
  legacyMigrationActor,
} from "../test-support/legacy-first-access-fixture.js";

const databaseUrl = process.env.OPERATIONAL_TEST_MYSQL_URL || "";
const RACE_ITERATIONS = 5;

function safeError(error) {
  return {
    name: error?.name || null,
    code: error?.code || null,
    errno: error?.errno ?? null,
    sqlState: error?.sqlState || null,
    message: error?.message || null,
  };
}

test(
  "real MySQL repeatedly resolves simultaneous legacy first access to one complete neutral migration",
  { skip: !databaseUrl },
  async () => {
    const pool = createMysqlConnection(databaseUrl);
    try {
      await applyMigrations(pool, undefined, { applicationVersion: "legacy-first-access-race-repetition" });
      const repositories = createOperationalRepositories(legacyDataPlaneContext(), pool);
      const actor = legacyMigrationActor("repeated-race-reviewer");

      for (let iteration = 0; iteration < RACE_ITERATIONS; iteration += 1) {
        const suffix = `${crypto.randomBytes(4).toString("hex")}r${iteration}`;
        const { signal, investigation } = await createLegacyInvestigation(
          pool,
          repositories,
          suffix,
          "OPEN",
        );
        const [claimBefore] = await pool.execute(
          "SELECT * FROM claims WHERE tenant_id = 'tenant_default' AND claim_id = ?",
          [signal.claimId],
        );
        const [investigationBefore] = await pool.execute(
          "SELECT fraud_confirmed_at FROM investigations WHERE tenant_id = 'tenant_default' AND investigation_id = ?",
          [investigation.investigationId],
        );
        const registryBefore = await countRows(pool, "SELECT COUNT(*) AS total FROM shared_fraud_registry_entries");

        const settled = await Promise.allSettled([
          repositories.cases.resolveLegacyInvestigationCase({
            legacyInvestigationId: investigation.investigationId,
            actorContext: actor,
            correlationId: `race-a-${suffix}`,
          }),
          repositories.cases.resolveLegacyInvestigationCase({
            legacyInvestigationId: investigation.investigationId,
            actorContext: actor,
            correlationId: `race-b-${suffix}`,
          }),
        ]);
        const diagnostic = settled.map((item) => item.status === "fulfilled"
          ? { status: item.status, caseId: item.value.case.caseId, replayed: item.value.replayed }
          : { status: item.status, error: safeError(item.reason) });
        assert.equal(
          settled.filter((item) => item.status === "fulfilled").length,
          2,
          `Iteration ${iteration} failed:\n${JSON.stringify(diagnostic, null, 2)}`,
        );

        const results = settled.map((item) => item.value);
        assert.equal(new Set(results.map((result) => result.case.caseId)).size, 1);
        const caseId = results[0].case.caseId;
        assert.equal(results[0].case.currentState, CASE_STATE.TRIAGE_PENDING);
        assert.equal(results[1].case.currentState, CASE_STATE.TRIAGE_PENDING);
        assert.equal(results[0].case.stateVersion, 2);
        assert.equal(results[1].case.stateVersion, 2);
        assert.equal(results.some((result) => result.replayed === false), true);
        assert.equal(results.some((result) => result.replayed === true), true);

        assert.equal(await countRows(
          pool,
          "SELECT COUNT(*) AS total FROM investigation_cases WHERE tenant_id = 'tenant_default' AND legacy_investigation_id = ? AND signal_id = ? AND claim_id = ? AND claim_version = 1 AND current_state = 'TRIAGE_PENDING' AND migration_review_status = 'REVIEW_REQUIRED'",
          [investigation.investigationId, signal.signalId, signal.claimId],
        ), 1);
        assert.equal(await countRows(
          pool,
          "SELECT COUNT(*) AS total FROM case_transition_events WHERE tenant_id = 'tenant_default' AND case_id = ? AND previous_state = 'SIGNAL_GENERATED' AND new_state = 'TRIAGE_PENDING'",
          [caseId],
        ), 1);
        assert.equal(await countRows(
          pool,
          "SELECT COUNT(*) AS total FROM case_process_checks WHERE tenant_id = 'tenant_default' AND case_id = ? AND check_code = 'LEGACY_MIGRATION_AUTHORIZATION'",
          [caseId],
        ), 1);
        assert.equal(await countRows(
          pool,
          "SELECT COUNT(*) AS total FROM detection_signals WHERE tenant_id = 'tenant_default' AND signal_id = ? AND claim_id = ? AND claim_version = 1",
          [signal.signalId, signal.claimId],
        ), 1);
        assert.equal(await countRows(
          pool,
          "SELECT COUNT(*) AS total FROM case_outcomes WHERE tenant_id = 'tenant_default' AND case_id = ?",
          [caseId],
        ), 0);

        const [claimAfter] = await pool.execute(
          "SELECT * FROM claims WHERE tenant_id = 'tenant_default' AND claim_id = ?",
          [signal.claimId],
        );
        const [investigationAfter] = await pool.execute(
          "SELECT fraud_confirmed_at FROM investigations WHERE tenant_id = 'tenant_default' AND investigation_id = ?",
          [investigation.investigationId],
        );
        assert.deepEqual(claimAfter, claimBefore);
        assert.deepEqual(investigationAfter, investigationBefore);
        assert.equal(
          await countRows(pool, "SELECT COUNT(*) AS total FROM shared_fraud_registry_entries"),
          registryBefore,
        );
      }
    } finally {
      await pool.end();
    }
  },
);
