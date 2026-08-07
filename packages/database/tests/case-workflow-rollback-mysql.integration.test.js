import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";

import {
  applyMigrations,
  CASE_PERMISSION,
  CASE_PERMISSION_POLICY_VERSION,
  CASE_ROLE,
  createDataPlaneContext,
  createMysqlConnection,
  createOperationalRepositories,
} from "../src/index.js";
import {
  CASE_TRANSACTION_FAULT_STAGE,
  createCaseTransactionFaultPool,
} from "../test-support/case-transaction-fault-pool.js";

const databaseUrl = process.env.OPERATIONAL_TEST_MYSQL_URL || "";

function context() {
  return createDataPlaneContext({
    organisationId: "org-tenant_default",
    organisationType: "medical_scheme",
    organisationStatus: "active",
    operationalTenantId: "tenant_default",
    operationalTenantSlug: "default",
    routeId: "route-tenant_default",
    routeType: "legacy_shared",
    routeGeneration: 1,
    logicalDatabaseIdentifier: "legacy-operational-shared",
    databaseName: null,
    schemaVersion: "17",
    deploymentClass: "test",
    region: "test",
  });
}

function actor(actorId, permissions, roles) {
  return Object.freeze({
    actorId,
    tenantId: "tenant_default",
    permissions: Object.freeze([...permissions].sort()),
    roles: Object.freeze([...roles].sort()),
    permissionPolicyVersion: CASE_PERMISSION_POLICY_VERSION,
  });
}

const analyst = actor("rollback-analyst", [
  CASE_PERMISSION.TRIAGE,
  CASE_PERMISSION.OPEN_INVESTIGATION,
], ["fraud_analyst"]);
const investigator = actor("rollback-investigator", [
  CASE_PERMISSION.RECORD_NOTICE,
  CASE_PERMISSION.REVIEW_EVIDENCE,
  CASE_PERMISSION.COMPLETE_REPORT,
  CASE_PERMISSION.SUBMIT_OUTCOME_REVIEW,
], ["investigator"]);
const reviewer = actor("rollback-reviewer", [
  CASE_PERMISSION.APPROVE_OUTCOME,
], ["applications_committee_member"]);

function fixture(suffix) {
  const schemeId = `R${suffix.slice(0, 7)}`;
  return {
    claimId: `RCLM-${suffix}`,
    schemes: [{ scheme_id: schemeId, scheme_name: `Rollback ${suffix}` }],
    members: [{
      member_id: `RMEM-${suffix}`,
      scheme_id: schemeId,
      first_name: "Rollback",
      last_name: "Member",
      date_of_birth: "1990-01-01",
      gender: "F",
      identity_number: `RID-${suffix}`,
      banking_detail: `RBANK-${suffix}`,
      home_region: "Test",
      home_lat: -29.1,
      home_lon: 26.2,
      join_date: "2020-01-01",
    }],
    providers: [{
      provider_id: `RPRO-${suffix}`,
      scheme_id: schemeId,
      practice_number: `RPR-${suffix}`,
      specialty: "GENERAL",
      practice_name: `Rollback Practice ${suffix}`,
      banking_detail: `RPROVIDER-BANK-${suffix}`,
      practice_region: "Test",
      practice_lat: -29.1,
      practice_lon: 26.2,
      provider_kind: "PRACTICE",
      provider_category: "GENERAL",
    }],
  };
}

async function createCase(pool, repositories, suffix) {
  const value = fixture(suffix);
  const ingestion = await repositories.claims.ingestClaims({
    schemes: value.schemes,
    members: value.members,
    providers: value.providers,
    claims: [{
      claim_id: value.claimId,
      scheme_id: value.schemes[0].scheme_id,
      member_id: value.members[0].member_id,
      provider_id: value.providers[0].provider_id,
      service_date: "2026-01-01",
      received_date: "2026-01-02",
      billing_code: "ROLLBACK",
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
    source: "case-rollback-test",
    correlationId: `ingest-${suffix}`,
  });
  const [assessments] = await pool.execute(
    `SELECT assessment_id, detection_strategy_id, strategy_type,
            model_deployment_id, provenance_status
       FROM assessment_versions
      WHERE tenant_id = 'tenant_default'
        AND assessment_id = ?
        AND claim_id = ?
        AND claim_version = 1
      LIMIT 1`,
    [ingestion.processing.assessmentId, value.claimId],
  );
  assert.equal(assessments.length, 1);
  assert.equal(assessments[0].provenance_status, "COMPLETE");
  await pool.execute(
    `INSERT INTO claim_detection_results (
       tenant_id, assessment_id, claim_id, claim_version,
       detection_strategy_id, strategy_type, model_deployment_id,
       source_job_id, request_id, analysis_mode,
       ensemble_id, ensemble_version, feature_schema_version, scored_at,
       result_payload, result_hash
     ) VALUES ('tenant_default', ?, ?, 1, ?, ?, ?, ?, ?,
       'PROSPECTIVE_CLAIM_SCREENING', NULL, NULL, NULL, UTC_TIMESTAMP(3), ?, ?)`,
    [
      assessments[0].assessment_id,
      value.claimId,
      assessments[0].detection_strategy_id,
      assessments[0].strategy_type,
      assessments[0].model_deployment_id,
      ingestion.processing.jobId,
      `detect-${suffix}`,
      JSON.stringify({ schemaVersion: "1.0", reasonCodes: ["ROLLBACK_TEST"] }),
      crypto.createHash("sha256").update(`rollback-${suffix}`).digest("hex"),
    ],
  );
  const [signals] = await pool.execute(
    "SELECT signal_id FROM detection_signals WHERE tenant_id = 'tenant_default' AND claim_id = ? AND claim_version = 1",
    [value.claimId],
  );
  return (await repositories.cases.createOrResolveCaseFromSignal({
    signalId: signals[0].signal_id,
    actorId: "detection-service",
    actorRole: CASE_ROLE.DETECTION_SERVICE,
    correlationId: `create-${suffix}`,
  })).case;
}

function action(repository, caseId, actionName, actorContext, version, key, extra = {}) {
  return repository.performAction({
    caseId,
    action: actionName,
    actorContext,
    expectedStateVersion: version,
    reasonCode: `ROLLBACK_${actionName.toUpperCase().replaceAll("-", "_")}`,
    reasonSummary: `Rollback injection for ${actionName}.`,
    correlationId: `correlation-${key}`,
    idempotencyKey: key,
    evidenceReferences: [],
    processCheckReferences: [],
    ...extra,
  });
}

async function snapshot(pool, caseId, idempotencyKey) {
  const [[caseRow]] = await pool.execute(
    `SELECT current_state, state_version, report_completing_investigator_id,
            report_reference, report_digest, report_completion_event_id
       FROM investigation_cases
      WHERE tenant_id = 'tenant_default' AND case_id = ?`,
    [caseId],
  );
  const [[counts]] = await pool.execute(
    `SELECT
       (SELECT COUNT(*) FROM case_transition_events WHERE tenant_id = 'tenant_default' AND case_id = ?) AS events,
       (SELECT COUNT(*) FROM case_process_checks WHERE tenant_id = 'tenant_default' AND case_id = ?) AS checks,
       (SELECT COUNT(*) FROM case_outcomes WHERE tenant_id = 'tenant_default' AND case_id = ?) AS outcomes,
       (SELECT COUNT(*) FROM case_transition_operations WHERE tenant_id = 'tenant_default' AND idempotency_key = ?) AS operations`,
    [caseId, caseId, caseId, idempotencyKey],
  );
  return {
    state: caseRow.current_state,
    version: Number(caseRow.state_version),
    reportCompletingInvestigatorId: caseRow.report_completing_investigator_id || null,
    reportReference: caseRow.report_reference || null,
    reportDigest: caseRow.report_digest || null,
    reportCompletionEventId: caseRow.report_completion_event_id || null,
    events: Number(counts.events),
    checks: Number(counts.checks),
    outcomes: Number(counts.outcomes),
    operations: Number(counts.operations),
  };
}

async function assertFaultRollsBack({
  pool,
  normalRepositories,
  caseId,
  stage,
  actionName,
  actorContext,
  version,
  key,
  extra = {},
}) {
  const before = await snapshot(pool, caseId, key);
  const faultRepositories = createOperationalRepositories(
    context(),
    createCaseTransactionFaultPool(pool, stage),
  );
  await assert.rejects(
    () => action(faultRepositories.cases, caseId, actionName, actorContext, version, key, extra),
    (error) => error.code === "CASE_TRANSACTION_TEST_FAULT" && error.stage === stage,
  );
  assert.deepEqual(await snapshot(pool, caseId, key), before);
  const retry = await action(normalRepositories.cases, caseId, actionName, actorContext, version, key, extra);
  assert.equal(retry.replayed, false);
  assert.equal(retry.case.stateVersion, version + 1);
  return retry;
}

test(
  "real MySQL rolls back every governed case transaction write stage",
  { skip: !databaseUrl },
  async () => {
    const previousCodes = process.env.SEQURIN_CASE_OUTCOME_CODES;
    process.env.SEQURIN_CASE_OUTCOME_CODES = "CONFIGURED_NEUTRAL_OUTCOME";
    const pool = createMysqlConnection(databaseUrl);
    try {
      await applyMigrations(pool, undefined, { applicationVersion: "case-rollback-test" });
      const repositories = createOperationalRepositories(context(), pool);
      const simpleStages = [
        CASE_TRANSACTION_FAULT_STAGE.CASE_ROW_ACQUISITION,
        CASE_TRANSACTION_FAULT_STAGE.OPERATION_RESERVATION,
        CASE_TRANSACTION_FAULT_STAGE.IDEMPOTENCY_INTENT_PERSISTENCE,
        CASE_TRANSACTION_FAULT_STAGE.TRANSITION_EVENT_INSERTION,
        CASE_TRANSACTION_FAULT_STAGE.AUTHORIZATION_CONTEXT_INSERTION,
        CASE_TRANSACTION_FAULT_STAGE.CONDITIONAL_STATE_UPDATE,
        CASE_TRANSACTION_FAULT_STAGE.OPERATION_RESULT_FINALIZATION,
        CASE_TRANSACTION_FAULT_STAGE.COMMIT,
      ];

      for (const [index, stage] of simpleStages.entries()) {
        const suffix = `${crypto.randomBytes(4).toString("hex")}${index}`;
        const caseRow = await createCase(pool, repositories, suffix);
        await assertFaultRollsBack({
          pool,
          normalRepositories: repositories,
          caseId: caseRow.caseId,
          stage,
          actionName: "begin-triage",
          actorContext: analyst,
          version: 1,
          key: `rollback-${stage}-${suffix}`,
        });
      }

      {
        const suffix = `${crypto.randomBytes(4).toString("hex")}p`;
        const caseRow = await createCase(pool, repositories, suffix);
        await assertFaultRollsBack({
          pool,
          normalRepositories: repositories,
          caseId: caseRow.caseId,
          stage: CASE_TRANSACTION_FAULT_STAGE.PROCESS_CHECK_INSERTION,
          actionName: "begin-triage",
          actorContext: analyst,
          version: 1,
          key: `rollback-process-${suffix}`,
          extra: { processCheckReferences: ["required-process-reference"] },
        });
      }

      {
        const suffix = `${crypto.randomBytes(4).toString("hex")}r`;
        const caseRow = await createCase(pool, repositories, suffix);
        let version = 1;
        version = (await action(repositories.cases, caseRow.caseId, "begin-triage", analyst, version, `triage-${suffix}`)).case.stateVersion;
        version = (await action(repositories.cases, caseRow.caseId, "open-investigation", analyst, version, `open-${suffix}`, {
          assignedInvestigatorId: investigator.actorId,
        })).case.stateVersion;
        version = (await action(repositories.cases, caseRow.caseId, "record-notice", investigator, version, `notice-${suffix}`)).case.stateVersion;
        version = (await action(repositories.cases, caseRow.caseId, "begin-evidence-review", investigator, version, `evidence-${suffix}`)).case.stateVersion;
        await assertFaultRollsBack({
          pool,
          normalRepositories: repositories,
          caseId: caseRow.caseId,
          stage: CASE_TRANSACTION_FAULT_STAGE.REPORT_METADATA_UPDATE,
          actionName: "complete-investigation-report",
          actorContext: investigator,
          version,
          key: `rollback-report-${suffix}`,
          extra: {
            evidenceReferences: ["evidence-1"],
            reportReference: "report-rollback",
            completionReason: "REPORT_COMPLETE",
          },
        });
      }

      {
        const suffix = `${crypto.randomBytes(4).toString("hex")}o`;
        const caseRow = await createCase(pool, repositories, suffix);
        let version = 1;
        version = (await action(repositories.cases, caseRow.caseId, "begin-triage", analyst, version, `triage-${suffix}`)).case.stateVersion;
        version = (await action(repositories.cases, caseRow.caseId, "open-investigation", analyst, version, `open-${suffix}`, {
          assignedInvestigatorId: investigator.actorId,
        })).case.stateVersion;
        version = (await action(repositories.cases, caseRow.caseId, "record-notice", investigator, version, `notice-${suffix}`)).case.stateVersion;
        version = (await action(repositories.cases, caseRow.caseId, "begin-evidence-review", investigator, version, `evidence-${suffix}`)).case.stateVersion;
        version = (await action(repositories.cases, caseRow.caseId, "complete-investigation-report", investigator, version, `report-${suffix}`, {
          evidenceReferences: ["evidence-1"],
          reportReference: "report-outcome",
          completionReason: "REPORT_COMPLETE",
        })).case.stateVersion;
        version = (await action(repositories.cases, caseRow.caseId, "submit-outcome-review", investigator, version, `submit-${suffix}`, {
          processCheckReferences: ["process-check-1"],
        })).case.stateVersion;
        await assertFaultRollsBack({
          pool,
          normalRepositories: repositories,
          caseId: caseRow.caseId,
          stage: CASE_TRANSACTION_FAULT_STAGE.OUTCOME_INSERTION,
          actionName: "approve-outcome",
          actorContext: reviewer,
          version,
          key: `rollback-outcome-${suffix}`,
          extra: {
            outcomeCode: "CONFIGURED_NEUTRAL_OUTCOME",
            recordedReasons: ["Independent governed review."],
            identityMatchReviewResult: { reviewed: true, resultCode: "REVIEWED" },
            supportingReportReference: "report-outcome",
            evidenceSetReference: "evidence-set-1",
            processCheckReferences: ["process-check-1"],
            processCheckComplete: true,
          },
        });
      }
    } finally {
      if (previousCodes === undefined) delete process.env.SEQURIN_CASE_OUTCOME_CODES;
      else process.env.SEQURIN_CASE_OUTCOME_CODES = previousCodes;
      await pool.end();
    }
  },
);
