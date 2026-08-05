import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";

import {
  applyMigrations,
  CASE_ROLE,
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
import {
  createLegacyFirstAccessFaultPool,
  LEGACY_FIRST_ACCESS_FAULT_STAGE,
} from "../test-support/legacy-first-access-fault-pool.js";

const databaseUrl = process.env.OPERATIONAL_TEST_MYSQL_URL || "";

async function safetySnapshot(pool, signal, investigation) {
  const [claims] = await pool.execute(
    "SELECT * FROM claims WHERE tenant_id = 'tenant_default' AND claim_id = ?",
    [signal.claimId],
  );
  const [investigations] = await pool.execute(
    "SELECT * FROM investigations WHERE tenant_id = 'tenant_default' AND investigation_id = ?",
    [investigation.investigationId],
  );
  const [cases] = await pool.execute(
    `SELECT case_id, signal_id, claim_id, claim_version, current_state, state_version,
            legacy_investigation_id, legacy_status, migration_review_status,
            last_transition_event_id
       FROM investigation_cases
      WHERE tenant_id = 'tenant_default' AND signal_id = ?`,
    [signal.signalId],
  );
  const caseIds = cases.map((row) => row.case_id);
  const eventCount = caseIds.length ? await countRows(
    pool,
    `SELECT COUNT(*) AS total FROM case_transition_events
      WHERE tenant_id = 'tenant_default' AND case_id IN (${caseIds.map(() => "?").join(",")})`,
    caseIds,
  ) : 0;
  const checkCount = caseIds.length ? await countRows(
    pool,
    `SELECT COUNT(*) AS total FROM case_process_checks
      WHERE tenant_id = 'tenant_default' AND case_id IN (${caseIds.map(() => "?").join(",")})`,
    caseIds,
  ) : 0;
  const outcomeCount = caseIds.length ? await countRows(
    pool,
    `SELECT COUNT(*) AS total FROM case_outcomes
      WHERE tenant_id = 'tenant_default' AND case_id IN (${caseIds.map(() => "?").join(",")})`,
    caseIds,
  ) : 0;
  return {
    claims,
    investigations,
    cases,
    eventCount,
    checkCount,
    outcomeCount,
    registryCount: await countRows(pool, "SELECT COUNT(*) AS total FROM shared_fraud_registry_entries"),
    signalCount: await countRows(
      pool,
      "SELECT COUNT(*) AS total FROM detection_signals WHERE tenant_id = 'tenant_default' AND signal_id = ? AND claim_id = ? AND claim_version = 1",
      [signal.signalId, signal.claimId],
    ),
  };
}

async function assertCleanMigration(pool, repositories, actor, signal, investigation, suffix) {
  const result = await repositories.cases.resolveLegacyInvestigationCase({
    legacyInvestigationId: investigation.investigationId,
    actorContext: actor,
    correlationId: `clean-retry-${suffix}`,
  });
  assert.equal(result.replayed, false);
  assert.equal(result.case.currentState, CASE_STATE.TRIAGE_PENDING);
  assert.equal(result.case.stateVersion, 2);
  assert.equal(result.case.signalId, signal.signalId);
  assert.equal(result.case.claimId, signal.claimId);
  assert.equal(result.case.migrationReviewStatus, "REVIEW_REQUIRED");
  assert.equal(await countRows(
    pool,
    "SELECT COUNT(*) AS total FROM investigation_cases WHERE tenant_id = 'tenant_default' AND legacy_investigation_id = ?",
    [investigation.investigationId],
  ), 1);
  assert.equal(await countRows(
    pool,
    "SELECT COUNT(*) AS total FROM case_transition_events WHERE tenant_id = 'tenant_default' AND case_id = ? AND new_state = 'TRIAGE_PENDING'",
    [result.case.caseId],
  ), 1);
  assert.equal(await countRows(
    pool,
    "SELECT COUNT(*) AS total FROM case_process_checks WHERE tenant_id = 'tenant_default' AND case_id = ? AND check_code = 'LEGACY_MIGRATION_AUTHORIZATION'",
    [result.case.caseId],
  ), 1);
  assert.equal(await countRows(
    pool,
    "SELECT COUNT(*) AS total FROM case_outcomes WHERE tenant_id = 'tenant_default' AND case_id = ?",
    [result.case.caseId],
  ), 0);
}

test(
  "real MySQL rolls back every legacy first-access transaction stage and permits one clean retry",
  { skip: !databaseUrl },
  async () => {
    const pool = createMysqlConnection(databaseUrl);
    try {
      await applyMigrations(pool, undefined, { applicationVersion: "legacy-first-access-rollback" });
      const context = legacyDataPlaneContext();
      const repositories = createOperationalRepositories(context, pool);
      const actor = legacyMigrationActor("legacy-rollback-reviewer");
      const stages = [
        LEGACY_FIRST_ACCESS_FAULT_STAGE.CASE_INSERTION,
        LEGACY_FIRST_ACCESS_FAULT_STAGE.NEUTRAL_TRANSITION,
        LEGACY_FIRST_ACCESS_FAULT_STAGE.PROCESS_CHECK,
        LEGACY_FIRST_ACCESS_FAULT_STAGE.BEFORE_COMMIT,
      ];

      for (const [index, stage] of stages.entries()) {
        const suffix = `${crypto.randomBytes(4).toString("hex")}f${index}`;
        const { signal, investigation } = await createLegacyInvestigation(pool, repositories, suffix, "OPEN");
        const before = await safetySnapshot(pool, signal, investigation);
        const faultRepositories = createOperationalRepositories(
          context,
          createLegacyFirstAccessFaultPool(pool, stage),
        );
        await assert.rejects(
          () => faultRepositories.cases.resolveLegacyInvestigationCase({
            legacyInvestigationId: investigation.investigationId,
            actorContext: actor,
            correlationId: `fault-${stage}-${suffix}`,
          }),
          (error) => error.code === "LEGACY_FIRST_ACCESS_TRANSACTION_TEST_FAULT"
            && error.stage === stage,
        );
        assert.deepEqual(await safetySnapshot(pool, signal, investigation), before);
        await assertCleanMigration(pool, repositories, actor, signal, investigation, suffix);
      }

      {
        const suffix = `${crypto.randomBytes(4).toString("hex")}link`;
        const { signal, investigation } = await createLegacyInvestigation(pool, repositories, suffix, "OPEN");
        const preexisting = await repositories.cases.createOrResolveCaseFromSignal({
          signalId: signal.signalId,
          actorId: "detection-service",
          actorRole: CASE_ROLE.DETECTION_SERVICE,
          correlationId: `preexisting-${suffix}`,
        });
        assert.equal(preexisting.case.currentState, CASE_STATE.SIGNAL_GENERATED);
        const before = await safetySnapshot(pool, signal, investigation);
        const faultRepositories = createOperationalRepositories(
          context,
          createLegacyFirstAccessFaultPool(pool, LEGACY_FIRST_ACCESS_FAULT_STAGE.LEGACY_LINKAGE),
        );
        await assert.rejects(
          () => faultRepositories.cases.resolveLegacyInvestigationCase({
            legacyInvestigationId: investigation.investigationId,
            actorContext: actor,
            correlationId: `fault-link-${suffix}`,
          }),
          (error) => error.code === "LEGACY_FIRST_ACCESS_TRANSACTION_TEST_FAULT"
            && error.stage === LEGACY_FIRST_ACCESS_FAULT_STAGE.LEGACY_LINKAGE,
        );
        assert.deepEqual(await safetySnapshot(pool, signal, investigation), before);
        await assertCleanMigration(pool, repositories, actor, signal, investigation, suffix);
      }
    } finally {
      await pool.end();
    }
  },
);
