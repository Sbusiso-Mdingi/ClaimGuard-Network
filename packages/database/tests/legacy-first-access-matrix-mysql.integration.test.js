import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";

import {
  applyMigrations,
  CASE_PERMISSION,
  CASE_PERMISSION_POLICY_VERSION,
  CASE_STATE,
  createDataPlaneContext,
  createMysqlConnection,
  createOperationalRepositories,
} from "../src/index.js";

const databaseUrl = process.env.OPERATIONAL_TEST_MYSQL_URL || "";

const LEGACY_STATUSES = Object.freeze([
  "OPEN",
  "UNDER_REVIEW",
  "AWAITING_EVIDENCE",
  "CONFIRMED_FRAUD",
  "REVERSED",
  "NO_FRAUD_FOUND",
  "CLOSED",
]);

function dataPlaneContext(tenantId = "tenant_default", tenantSlug = "default") {
  return createDataPlaneContext({
    organisationId: `org-${tenantId}`,
    organisationType: "medical_scheme",
    organisationStatus: "active",
    operationalTenantId: tenantId,
    operationalTenantSlug: tenantSlug,
    routeId: `route-${tenantId}`,
    routeType: "legacy_shared",
    routeGeneration: 1,
    logicalDatabaseIdentifier: "legacy-operational-shared",
    databaseName: null,
    schemaVersion: "17",
    deploymentClass: "test",
    region: "test",
  });
}

function migrationActor(actorId = "legacy-reviewer") {
  return Object.freeze({
    actorId,
    tenantId: "tenant_default",
    permissions: Object.freeze([CASE_PERMISSION.TRIAGE]),
    roles: Object.freeze(["fraud_analyst"]),
    permissionPolicyVersion: CASE_PERMISSION_POLICY_VERSION,
  });
}

function fixture(suffix) {
  const schemeId = `S${suffix.slice(0, 7)}`;
  const claimId = `CLM-${suffix}`;
  return {
    claimId,
    schemes: [{ scheme_id: schemeId, scheme_name: `Scheme ${suffix}` }],
    members: [{
      member_id: `MEM-${suffix}`,
      scheme_id: schemeId,
      first_name: "Legacy",
      last_name: "Member",
      date_of_birth: "1990-01-01",
      gender: "M",
      identity_number: `ID-${suffix}`,
      banking_detail: `BANK-${suffix}`,
      home_region: "Test",
      home_lat: -29.1,
      home_lon: 26.2,
      join_date: "2020-01-01",
    }],
    providers: [{
      provider_id: `PRO-${suffix}`,
      scheme_id: schemeId,
      practice_number: `PR-${suffix}`,
      specialty: "GENERAL",
      practice_name: `Practice ${suffix}`,
      banking_detail: `PROVIDER-BANK-${suffix}`,
      practice_region: "Test",
      practice_lat: -29.1,
      practice_lon: 26.2,
      provider_kind: "PRACTICE",
      provider_category: "GENERAL",
    }],
    claims: [{
      claim_id: claimId,
      scheme_id: schemeId,
      member_id: `MEM-${suffix}`,
      provider_id: `PRO-${suffix}`,
      service_date: "2026-01-01",
      received_date: "2026-01-02",
      billing_code: "TEST001",
      amount: 100,
      quantity: 1,
      benefit_option: "STANDARD",
      network_type: "IN_NETWORK",
      line_type: "SERVICE",
      tariff_discipline: "GENERAL",
      diagnosis_code: "Z00",
      rendering_practitioner_id: null,
      rendering_practitioner_category: "NONE",
      rendering_known_to_billing_provider: false,
    }],
  };
}

async function createSignal(pool, repositories, suffix) {
  const value = fixture(suffix);
  const ingestion = await repositories.claims.ingestClaims({
    claims: value.claims,
    schemes: value.schemes,
    members: value.members,
    providers: value.providers,
    source: "legacy-first-access-matrix",
    correlationId: `ingest-${suffix}`,
  });
  const [strategies] = await pool.execute(
    "SELECT id, strategy_type, model_deployment_id FROM detection_strategies WHERE tenant_id = 'tenant_default' AND is_active = 1 LIMIT 1",
  );
  assert.equal(strategies.length, 1);
  await pool.execute(
    `INSERT INTO claim_detection_results (
       tenant_id, claim_id, claim_version, detection_strategy_id, strategy_type,
       model_deployment_id, source_job_id, request_id, analysis_mode,
       ensemble_id, ensemble_version, feature_schema_version, scored_at,
       result_payload, result_hash
     ) VALUES (?, ?, 1, ?, ?, ?, ?, ?, 'PROSPECTIVE_CLAIM_SCREENING',
       NULL, NULL, NULL, UTC_TIMESTAMP(3), ?, ?)`,
    [
      "tenant_default",
      value.claimId,
      strategies[0].id,
      strategies[0].strategy_type,
      strategies[0].model_deployment_id,
      ingestion.processing.jobId,
      `detect-${suffix}`,
      JSON.stringify({
        schemaVersion: "1.0",
        reasonCodes: ["LEGACY_COMPATIBILITY_SIGNAL"],
        evidenceReferences: [`evidence-${suffix}`],
      }),
      crypto.createHash("sha256").update(`result-${suffix}`).digest("hex"),
    ],
  );
  const [signals] = await pool.execute(
    "SELECT signal_id FROM detection_signals WHERE tenant_id = 'tenant_default' AND claim_id = ? AND claim_version = 1",
    [value.claimId],
  );
  assert.equal(signals.length, 1);
  return { ...value, signalId: signals[0].signal_id };
}

async function count(pool, sql, values = []) {
  const [rows] = await pool.execute(sql, values);
  return Number(rows[0].total);
}

async function createLegacyInvestigation(pool, repositories, suffix, status) {
  const signal = await createSignal(pool, repositories, suffix);
  const investigation = await repositories.investigations.createInvestigation({
    claimId: signal.claimId,
    assignedBy: "legacy-author",
    expectedClaimVersion: 1,
    correlationId: `legacy-create-${suffix}`,
  });
  await pool.execute(
    `UPDATE investigations
        SET status = ?, fraud_confirmed_at = CASE WHEN ? = 'CONFIRMED_FRAUD' THEN UTC_TIMESTAMP(3) ELSE NULL END
      WHERE tenant_id = 'tenant_default' AND investigation_id = ?`,
    [status, status, investigation.investigationId],
  );
  return { signal, investigation };
}

test(
  "real MySQL maps every historical investigation status to neutral reviewed first access",
  { skip: !databaseUrl },
  async () => {
    const pool = createMysqlConnection(databaseUrl);
    const runId = crypto.randomBytes(4).toString("hex");
    try {
      await applyMigrations(pool, undefined, { applicationVersion: "legacy-first-access-matrix" });
      const repositories = createOperationalRepositories(dataPlaneContext(), pool);
      const actor = migrationActor();

      for (const [index, status] of LEGACY_STATUSES.entries()) {
        const suffix = `${runId}${index}`;
        const { signal, investigation } = await createLegacyInvestigation(
          pool,
          repositories,
          suffix,
          status,
        );
        const [claimBefore] = await pool.execute(
          "SELECT * FROM claims WHERE tenant_id = 'tenant_default' AND claim_id = ?",
          [signal.claimId],
        );
        const [investigationBefore] = await pool.execute(
          "SELECT fraud_confirmed_at FROM investigations WHERE tenant_id = 'tenant_default' AND investigation_id = ?",
          [investigation.investigationId],
        );
        const registryBefore = await count(pool, "SELECT COUNT(*) AS total FROM shared_fraud_registry_entries");

        const first = await repositories.cases.resolveLegacyInvestigationCase({
          legacyInvestigationId: investigation.investigationId,
          actorContext: actor,
          correlationId: `first-${suffix}`,
        });
        const replay = await repositories.cases.resolveLegacyInvestigationCase({
          legacyInvestigationId: investigation.investigationId,
          actorContext: actor,
          correlationId: `replay-${suffix}`,
        });

        assert.equal(first.case.currentState, CASE_STATE.TRIAGE_PENDING);
        assert.equal(first.case.stateVersion, 2);
        assert.equal(first.case.legacyInvestigationId, investigation.investigationId);
        assert.equal(first.case.legacyStatus, status);
        assert.equal(first.case.migrationReviewStatus, "REVIEW_REQUIRED");
        assert.equal(replay.case.caseId, first.case.caseId);
        assert.equal(replay.replayed, true);

        assert.equal(await count(
          pool,
          "SELECT COUNT(*) AS total FROM investigation_cases WHERE tenant_id = 'tenant_default' AND legacy_investigation_id = ?",
          [investigation.investigationId],
        ), 1);
        assert.equal(await count(
          pool,
          "SELECT COUNT(*) AS total FROM case_transition_events WHERE tenant_id = 'tenant_default' AND case_id = ? AND new_state = 'TRIAGE_PENDING'",
          [first.case.caseId],
        ), 1);
        assert.equal(await count(
          pool,
          "SELECT COUNT(*) AS total FROM case_process_checks WHERE tenant_id = 'tenant_default' AND case_id = ? AND check_code = 'LEGACY_MIGRATION_AUTHORIZATION'",
          [first.case.caseId],
        ), 1);
        assert.equal(await count(
          pool,
          "SELECT COUNT(*) AS total FROM case_outcomes WHERE tenant_id = 'tenant_default' AND case_id = ?",
          [first.case.caseId],
        ), 0);
        assert.equal(await count(
          pool,
          "SELECT COUNT(*) AS total FROM detection_signals WHERE tenant_id = 'tenant_default' AND claim_id = ? AND claim_version = 1",
          [signal.claimId],
        ), 1);

        const [claimAfter] = await pool.execute(
          "SELECT * FROM claims WHERE tenant_id = 'tenant_default' AND claim_id = ?",
          [signal.claimId],
        );
        const [investigationAfter] = await pool.execute(
          "SELECT fraud_confirmed_at FROM investigations WHERE tenant_id = 'tenant_default' AND investigation_id = ?",
          [investigation.investigationId],
        );
        const registryAfter = await count(pool, "SELECT COUNT(*) AS total FROM shared_fraud_registry_entries");
        assert.deepEqual(claimAfter, claimBefore);
        assert.deepEqual(investigationAfter, investigationBefore);
        assert.equal(registryAfter, registryBefore);
      }
    } finally {
      await pool.end();
    }
  },
);

test(
  "real MySQL concurrent legacy first access creates one case, event and process check",
  { skip: !databaseUrl },
  async () => {
    const pool = createMysqlConnection(databaseUrl);
    const suffix = `${crypto.randomBytes(4).toString("hex")}c`;
    try {
      await applyMigrations(pool, undefined, { applicationVersion: "legacy-first-access-concurrency" });
      const repositories = createOperationalRepositories(dataPlaneContext(), pool);
      const actor = migrationActor("concurrent-reviewer");
      const { investigation } = await createLegacyInvestigation(
        pool,
        repositories,
        suffix,
        "OPEN",
      );

      const settled = await Promise.allSettled([
        repositories.cases.resolveLegacyInvestigationCase({
          legacyInvestigationId: investigation.investigationId,
          actorContext: actor,
          correlationId: `concurrent-one-${suffix}`,
        }),
        repositories.cases.resolveLegacyInvestigationCase({
          legacyInvestigationId: investigation.investigationId,
          actorContext: actor,
          correlationId: `concurrent-two-${suffix}`,
        }),
      ]);
      assert.equal(settled.filter((item) => item.status === "fulfilled").length, 2);
      const caseIds = settled.map((item) => item.value.case.caseId);
      assert.equal(new Set(caseIds).size, 1);
      const caseId = caseIds[0];
      assert.equal(await count(
        pool,
        "SELECT COUNT(*) AS total FROM investigation_cases WHERE tenant_id = 'tenant_default' AND legacy_investigation_id = ?",
        [investigation.investigationId],
      ), 1);
      assert.equal(await count(
        pool,
        "SELECT COUNT(*) AS total FROM case_transition_events WHERE tenant_id = 'tenant_default' AND case_id = ? AND new_state = 'TRIAGE_PENDING'",
        [caseId],
      ), 1);
      assert.equal(await count(
        pool,
        "SELECT COUNT(*) AS total FROM case_process_checks WHERE tenant_id = 'tenant_default' AND case_id = ? AND check_code = 'LEGACY_MIGRATION_AUTHORIZATION'",
        [caseId],
      ), 1);
    } finally {
      await pool.end();
    }
  },
);
