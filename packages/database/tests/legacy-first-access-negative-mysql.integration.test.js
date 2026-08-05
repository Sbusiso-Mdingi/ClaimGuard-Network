import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";

import {
  applyMigrations,
  createMysqlConnection,
  createOperationalRepositories,
} from "../src/index.js";
import {
  countRows,
  createLegacyInvestigation,
  createLegacySignal,
  legacyDataPlaneContext,
  legacyFixture,
  legacyMigrationActor,
} from "../test-support/legacy-first-access-fixture.js";

const databaseUrl = process.env.OPERATIONAL_TEST_MYSQL_URL || "";

async function assertNoMigration(pool, investigationId) {
  assert.equal(await countRows(
    pool,
    "SELECT COUNT(*) AS total FROM investigation_cases WHERE tenant_id = 'tenant_default' AND legacy_investigation_id = ?",
    [investigationId],
  ), 0);
  assert.equal(await countRows(
    pool,
    `SELECT COUNT(*) AS total
       FROM case_transition_events e
       JOIN investigation_cases c ON c.tenant_id = e.tenant_id AND c.case_id = e.case_id
      WHERE c.tenant_id = 'tenant_default' AND c.legacy_investigation_id = ?`,
    [investigationId],
  ), 0);
  assert.equal(await countRows(
    pool,
    `SELECT COUNT(*) AS total
       FROM case_process_checks p
       JOIN investigation_cases c ON c.tenant_id = p.tenant_id AND c.case_id = p.case_id
      WHERE c.tenant_id = 'tenant_default' AND c.legacy_investigation_id = ?`,
    [investigationId],
  ), 0);
}

async function createClaimWithoutSignal(repositories, suffix) {
  const value = legacyFixture(suffix);
  await repositories.claims.ingestClaims({
    claims: value.claims,
    schemes: value.schemes,
    members: value.members,
    providers: value.providers,
    source: "legacy-negative-linkage",
    correlationId: `ingest-no-signal-${suffix}`,
  });
  const investigation = await repositories.investigations.createInvestigation({
    claimId: value.claimId,
    assignedBy: "legacy-author",
    expectedClaimVersion: 1,
    correlationId: `investigation-no-signal-${suffix}`,
  });
  return { value, investigation };
}

test(
  "real MySQL legacy first access fails closed for malformed, missing and ambiguous linkage",
  { skip: !databaseUrl },
  async () => {
    const pool = createMysqlConnection(databaseUrl);
    try {
      await applyMigrations(pool, undefined, { applicationVersion: "legacy-first-access-negative" });
      const repositories = createOperationalRepositories(legacyDataPlaneContext(), pool);
      const actor = legacyMigrationActor("negative-linkage-reviewer");
      const registryBefore = await countRows(pool, "SELECT COUNT(*) AS total FROM shared_fraud_registry_entries");

      await assert.rejects(
        () => repositories.cases.resolveLegacyInvestigationCase({
          legacyInvestigationId: "",
          actorContext: actor,
          correlationId: "malformed-empty",
        }),
        (error) => error.code === "CASE_VALIDATION_FAILED",
      );
      await assert.rejects(
        () => repositories.cases.resolveLegacyInvestigationCase({
          legacyInvestigationId: "x".repeat(65),
          actorContext: actor,
          correlationId: "malformed-long",
        }),
        (error) => error.code === "CASE_VALIDATION_FAILED",
      );

      const missingId = crypto.randomUUID();
      await assert.rejects(
        () => repositories.cases.resolveLegacyInvestigationCase({
          legacyInvestigationId: missingId,
          actorContext: actor,
          correlationId: "missing-investigation",
        }),
        (error) => error.code === "CASE_NOT_FOUND",
      );
      await assertNoMigration(pool, missingId);

      {
        const suffix = `${crypto.randomBytes(4).toString("hex")}missing`;
        const { value, investigation } = await createClaimWithoutSignal(repositories, suffix);
        const [claimBefore] = await pool.execute(
          "SELECT * FROM claims WHERE tenant_id = 'tenant_default' AND claim_id = ?",
          [value.claimId],
        );
        const [investigationBefore] = await pool.execute(
          "SELECT * FROM investigations WHERE tenant_id = 'tenant_default' AND investigation_id = ?",
          [investigation.investigationId],
        );
        await assert.rejects(
          () => repositories.cases.resolveLegacyInvestigationCase({
            legacyInvestigationId: investigation.investigationId,
            actorContext: actor,
            correlationId: `missing-signal-${suffix}`,
          }),
          (error) => error.code === "LEGACY_CASE_SIGNAL_LINK_REQUIRED",
        );
        await assertNoMigration(pool, investigation.investigationId);
        const [claimAfter] = await pool.execute(
          "SELECT * FROM claims WHERE tenant_id = 'tenant_default' AND claim_id = ?",
          [value.claimId],
        );
        const [investigationAfter] = await pool.execute(
          "SELECT * FROM investigations WHERE tenant_id = 'tenant_default' AND investigation_id = ?",
          [investigation.investigationId],
        );
        assert.deepEqual(claimAfter, claimBefore);
        assert.deepEqual(investigationAfter, investigationBefore);
      }

      {
        const suffix = `${crypto.randomBytes(4).toString("hex")}stale`;
        const { signal, investigation } = await createLegacyInvestigation(pool, repositories, suffix, "OPEN");
        const amended = legacyFixture(suffix);
        amended.claims[0].amount = 101;
        await repositories.claims.ingestClaims({
          claims: amended.claims,
          schemes: amended.schemes,
          members: amended.members,
          providers: amended.providers,
          source: "legacy-negative-stale-version",
          correlationId: `amend-${suffix}`,
        });
        await assert.rejects(
          () => repositories.cases.resolveLegacyInvestigationCase({
            legacyInvestigationId: investigation.investigationId,
            actorContext: actor,
            correlationId: `stale-version-${suffix}`,
          }),
          (error) => error.code === "LEGACY_CASE_SIGNAL_LINK_REQUIRED",
        );
        await assertNoMigration(pool, investigation.investigationId);
        assert.equal(await countRows(
          pool,
          "SELECT COUNT(*) AS total FROM detection_signals WHERE tenant_id = 'tenant_default' AND signal_id = ? AND claim_id = ? AND claim_version = 1",
          [signal.signalId, signal.claimId],
        ), 1);
      }

      {
        const suffix = `${crypto.randomBytes(4).toString("hex")}immutable`;
        const signal = await createLegacySignal(pool, repositories, suffix);
        await assert.rejects(
          () => pool.execute(
            "UPDATE detection_signals SET claim_id = ? WHERE tenant_id = 'tenant_default' AND signal_id = ?",
            [`WRONG-${suffix}`, signal.signalId],
          ),
          (error) => error.sqlState === "45000" && error.message.includes("DETECTION_SIGNAL_IMMUTABLE"),
        );
        await assert.rejects(
          () => pool.execute(
            `INSERT INTO detection_signals (
               signal_id, tenant_id, claim_id, claim_version, detection_strategy_id,
               strategy_type, model_deployment_id, source_job_id, request_id,
               reason_codes, evidence_references, input_provenance, correlation_id
             )
             SELECT UUID(), tenant_id, claim_id, claim_version, detection_strategy_id,
                    strategy_type, model_deployment_id, source_job_id, CONCAT(request_id, '-duplicate'),
                    reason_codes, evidence_references, input_provenance, CONCAT(correlation_id, '-duplicate')
               FROM detection_signals WHERE tenant_id = 'tenant_default' AND signal_id = ?`,
            [signal.signalId],
          ),
          (error) => error.code === "ER_DUP_ENTRY" && error.errno === 1062,
        );
        assert.equal(await countRows(
          pool,
          "SELECT COUNT(*) AS total FROM detection_signals WHERE tenant_id = 'tenant_default' AND claim_id = ? AND claim_version = 1",
          [signal.claimId],
        ), 1);
      }

      {
        const suffix = `${crypto.randomBytes(4).toString("hex")}foreign`;
        const { signal, investigation } = await createLegacyInvestigation(pool, repositories, suffix, "OPEN");
        await pool.execute(
          "INSERT IGNORE INTO tenants (tenant_id, tenant_slug, tenant_name, status) VALUES ('tenant_foreign', 'tenant-foreign', 'Foreign Tenant', 'active')",
        );
        const foreignInvestigationId = crypto.randomUUID();
        await pool.execute(
          `INSERT INTO investigations (
             investigation_id, tenant_id, claim_id, assigned_by, status, priority
           ) VALUES (?, 'tenant_foreign', ?, 'foreign-author', 'OPEN', 'NORMAL')`,
          [foreignInvestigationId, signal.claimId],
        );
        await assert.rejects(
          () => repositories.cases.resolveLegacyInvestigationCase({
            legacyInvestigationId: foreignInvestigationId,
            actorContext: actor,
            correlationId: `foreign-investigation-${suffix}`,
          }),
          (error) => error.code === "CASE_NOT_FOUND",
        );
        await assertNoMigration(pool, foreignInvestigationId);

        const foreignRepositories = createOperationalRepositories(
          legacyDataPlaneContext("tenant_foreign", "tenant-foreign"),
          pool,
        );
        await assert.rejects(
          () => foreignRepositories.cases.resolveLegacyInvestigationCase({
            legacyInvestigationId: foreignInvestigationId,
            actorContext: legacyMigrationActor("foreign-reviewer", "tenant_foreign"),
            correlationId: `claim-tenant-mismatch-${suffix}`,
          }),
          (error) => error.code === "CASE_NOT_FOUND",
        );
        assert.equal(await countRows(
          pool,
          "SELECT COUNT(*) AS total FROM investigation_cases WHERE tenant_id = 'tenant_foreign' AND legacy_investigation_id = ?",
          [foreignInvestigationId],
        ), 0);
        assert.equal(investigation.investigationId.length > 0, true);
      }

      {
        const suffix = `${crypto.randomBytes(4).toString("hex")}replay`;
        const { investigation } = await createLegacyInvestigation(pool, repositories, suffix, "OPEN");
        const first = await repositories.cases.resolveLegacyInvestigationCase({
          legacyInvestigationId: investigation.investigationId,
          actorContext: actor,
          correlationId: `first-${suffix}`,
        });
        const replayed = await Promise.all([
          repositories.cases.resolveLegacyInvestigationCase({
            legacyInvestigationId: investigation.investigationId,
            actorContext: actor,
            correlationId: `existing-a-${suffix}`,
          }),
          repositories.cases.resolveLegacyInvestigationCase({
            legacyInvestigationId: investigation.investigationId,
            actorContext: actor,
            correlationId: `existing-b-${suffix}`,
          }),
        ]);
        assert.equal(replayed[0].replayed, true);
        assert.equal(replayed[1].replayed, true);
        assert.equal(replayed[0].case.caseId, first.case.caseId);
        assert.equal(replayed[1].case.caseId, first.case.caseId);
        assert.equal(await countRows(
          pool,
          "SELECT COUNT(*) AS total FROM case_transition_events WHERE tenant_id = 'tenant_default' AND case_id = ? AND new_state = 'TRIAGE_PENDING'",
          [first.case.caseId],
        ), 1);
      }

      assert.equal(
        await countRows(pool, "SELECT COUNT(*) AS total FROM shared_fraud_registry_entries"),
        registryBefore,
      );
    } finally {
      await pool.end();
    }
  },
);
