import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";

import {
  applyMigrations,
  CASE_PERMISSION,
  CASE_PERMISSION_POLICY_VERSION,
  CASE_ROLE,
  CASE_STATE,
  createDataPlaneContext,
  createMysqlConnection,
  createOperationalRepositories,
} from "../src/index.js";

const databaseUrl = process.env.OPERATIONAL_TEST_MYSQL_URL || "";

function dataPlaneContext(tenantId, tenantSlug = tenantId) {
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

function actorContext(actorId, permissions, roles, tenantId = "tenant_default") {
  return Object.freeze({
    actorId,
    tenantId,
    permissions: Object.freeze([...permissions].sort()),
    roles: Object.freeze([...(roles || [])].sort()),
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
      first_name: "Integration",
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
    source: "case-workflow-mysql-test",
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
     ) VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, 'PROSPECTIVE_CLAIM_SCREENING',
       NULL, NULL, NULL, UTC_TIMESTAMP(3), ?, ?)`,
    [
      "tenant_default",
      assessments[0].assessment_id,
      value.claimId,
      assessments[0].detection_strategy_id,
      assessments[0].strategy_type,
      assessments[0].model_deployment_id,
      ingestion.processing.jobId,
      `detect-${suffix}`,
      JSON.stringify({
        schemaVersion: "1.0",
        reasonCodes: ["INTEGRATION_SIGNAL"],
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

function perform(cases, caseId, action, actor, input) {
  return cases.performAction({
    caseId,
    action,
    actorContext: actor,
    evidenceReferences: [],
    processCheckReferences: [],
    ...input,
  });
}

test(
  "real MySQL enforces permission authority, concurrency, replay and independent approval",
  { skip: !databaseUrl },
  async () => {
    const previousCodes = process.env.SEQURIN_CASE_OUTCOME_CODES;
    process.env.SEQURIN_CASE_OUTCOME_CODES = "CONFIGURED_NEUTRAL_OUTCOME";
    const pool = createMysqlConnection(databaseUrl);
    const suffix = crypto.randomBytes(5).toString("hex");
    const analyst = actorContext("analyst-1", [
      CASE_PERMISSION.TRIAGE,
      CASE_PERMISSION.DISMISS,
      CASE_PERMISSION.MONITOR,
      CASE_PERMISSION.OPEN_INVESTIGATION,
    ], ["fraud_analyst"]);
    const investigator = actorContext("investigator-1", [
      CASE_PERMISSION.RECORD_NOTICE,
      CASE_PERMISSION.RECORD_RESPONSE,
      CASE_PERMISSION.REVIEW_EVIDENCE,
      CASE_PERMISSION.COMPLETE_REPORT,
      CASE_PERMISSION.SUBMIT_OUTCOME_REVIEW,
    ], ["investigator"]);
    const reviewer = (id) => actorContext(id, [
      CASE_PERMISSION.REVIEW_OUTCOME,
      CASE_PERMISSION.APPROVE_OUTCOME,
      CASE_PERMISSION.CLOSE_UNSUBSTANTIATED,
      CASE_PERMISSION.OPEN_APPEAL_OR_REVIEW,
      CASE_PERMISSION.RETURN_FOR_FURTHER_EVIDENCE,
    ], ["applications_committee_member"]);

    try {
      await applyMigrations(pool, undefined, { applicationVersion: "case-workflow-mysql-test" });
      const repositories = createOperationalRepositories(dataPlaneContext("tenant_default", "default"), pool);

      const signal = await createSignal(pool, repositories, `${suffix}a`);
      const created = await repositories.cases.createOrResolveCaseFromSignal({
        signalId: signal.signalId,
        actorId: "detection-service",
        actorRole: CASE_ROLE.DETECTION_SERVICE,
        correlationId: `create-${suffix}`,
      });
      const resolved = await repositories.cases.createOrResolveCaseFromSignal({
        signalId: signal.signalId,
        actorId: "detection-service",
        actorRole: CASE_ROLE.DETECTION_SERVICE,
        correlationId: `create-replay-${suffix}`,
      });
      assert.equal(resolved.case.caseId, created.case.caseId);
      assert.equal(resolved.replayed, true);

      const competing = ["one", "two"].map((label) => perform(
        repositories.cases,
        created.case.caseId,
        "begin-triage",
        analyst,
        {
          expectedStateVersion: 1,
          reasonCode: "TRIAGE_STARTED",
          reasonSummary: `Competing triage ${label}`,
          correlationId: `triage-${label}-${suffix}`,
          idempotencyKey: `triage-${label}-${suffix}`,
        },
      ));
      const settled = await Promise.allSettled(competing);
      assert.equal(settled.filter((item) => item.status === "fulfilled").length, 1);
      assert.equal(
        settled.find((item) => item.status === "rejected").reason.code,
        "CASE_STATE_VERSION_CONFLICT",
      );
      const winningLabel = settled[0].status === "fulfilled" ? "one" : "two";
      const replay = await perform(repositories.cases, created.case.caseId, "begin-triage", analyst, {
        expectedStateVersion: 1,
        reasonCode: "TRIAGE_STARTED",
        reasonSummary: `Competing triage ${winningLabel}`,
        correlationId: `triage-replay-${suffix}`,
        idempotencyKey: `triage-${winningLabel}-${suffix}`,
      });
      assert.equal(replay.replayed, true);
      assert.equal(replay.case.stateVersion, 2);
      await assert.rejects(
        () => perform(repositories.cases, created.case.caseId, "begin-triage", analyst, {
          expectedStateVersion: 1,
          reasonCode: "DIFFERENT_INTENT",
          reasonSummary: "Different intent under the same key",
          correlationId: `mismatch-${suffix}`,
          idempotencyKey: `triage-${winningLabel}-${suffix}`,
        }),
        (error) => error.code === "CASE_IDEMPOTENCY_MISMATCH",
      );

      const approvalSignal = await createSignal(pool, repositories, `${suffix}b`);
      const approvalCase = (await repositories.cases.createOrResolveCaseFromSignal({
        signalId: approvalSignal.signalId,
        actorId: "detection-service",
        actorRole: CASE_ROLE.DETECTION_SERVICE,
        correlationId: `approval-create-${suffix}`,
      })).case;
      let version = approvalCase.stateVersion;
      const advance = async (action, actor, extra = {}) => {
        const result = await perform(repositories.cases, approvalCase.caseId, action, actor, {
          expectedStateVersion: version,
          reasonCode: `ACTION_${action.toUpperCase().replaceAll("-", "_")}`,
          reasonSummary: `Governed action ${action}`,
          correlationId: `${action}-${suffix}`,
          idempotencyKey: `${action}-${suffix}`,
          ...extra,
        });
        version = result.case.stateVersion;
        return result;
      };

      await advance("begin-triage", analyst);
      await advance("open-investigation", analyst, { assignedInvestigatorId: "investigator-1" });
      await advance("record-notice", investigator);
      await advance("begin-evidence-review", investigator);
      await advance("complete-investigation-report", investigator, {
        evidenceReferences: ["evidence-report-1"],
        reportReference: "report-1",
        completionReason: "REPORT_COMPLETE",
      });
      await advance("submit-outcome-review", investigator, {
        processCheckReferences: ["process-check-1"],
      });

      const approvalPayload = {
        expectedStateVersion: version,
        reasonCode: "OUTCOME_REVIEWED",
        reasonSummary: "Independent outcome review completed",
        outcomeCode: "CONFIGURED_NEUTRAL_OUTCOME",
        recordedReasons: ["Bounded neutral outcome approved."],
        identityMatchReviewResult: { reviewed: true, resultCode: "REVIEWED" },
        supportingReportReference: "report-1",
        evidenceSetReference: "evidence-set-1",
        processCheckReferences: ["process-check-1"],
        processCheckComplete: true,
      };
      await assert.rejects(
        () => perform(repositories.cases, approvalCase.caseId, "approve-outcome", actorContext(
          "investigator-1",
          [CASE_PERMISSION.APPROVE_OUTCOME],
          ["applications_committee_member"],
        ), {
          ...approvalPayload,
          correlationId: `self-review-${suffix}`,
          idempotencyKey: `self-review-${suffix}`,
        }),
        (error) => error.code === "CASE_REVIEWER_INDEPENDENCE_REQUIRED",
      );

      const [claimBefore] = await pool.execute(
        "SELECT * FROM claims WHERE tenant_id = 'tenant_default' AND claim_id = ?",
        [approvalSignal.claimId],
      );
      const [registryBefore] = await pool.execute("SELECT COUNT(*) AS total FROM shared_fraud_registry_entries");
      const approvals = await Promise.allSettled([
        perform(repositories.cases, approvalCase.caseId, "approve-outcome", reviewer("reviewer-1"), {
          ...approvalPayload,
          correlationId: `approval-one-${suffix}`,
          idempotencyKey: `approval-one-${suffix}`,
        }),
        perform(repositories.cases, approvalCase.caseId, "approve-outcome", reviewer("reviewer-2"), {
          ...approvalPayload,
          correlationId: `approval-two-${suffix}`,
          idempotencyKey: `approval-two-${suffix}`,
        }),
      ]);
      assert.equal(approvals.filter((item) => item.status === "fulfilled").length, 1);
      assert.equal(
        approvals.find((item) => item.status === "rejected").reason.code,
        "CASE_STATE_VERSION_CONFLICT",
      );
      const [outcomes] = await pool.execute(
        "SELECT COUNT(*) AS total FROM case_outcomes WHERE tenant_id = 'tenant_default' AND case_id = ?",
        [approvalCase.caseId],
      );
      assert.equal(Number(outcomes[0].total), 1);
      const [approvalEvents] = await pool.execute(
        "SELECT COUNT(*) AS total FROM case_transition_events WHERE tenant_id = 'tenant_default' AND case_id = ? AND new_state = 'OUTCOME_APPROVED'",
        [approvalCase.caseId],
      );
      assert.equal(Number(approvalEvents[0].total), 1);
      const [authorizationChecks] = await pool.execute(
        "SELECT COUNT(*) AS total FROM case_process_checks WHERE tenant_id = 'tenant_default' AND case_id = ? AND check_code = 'AUTHORIZATION_CONTEXT'",
        [approvalCase.caseId],
      );
      assert.ok(Number(authorizationChecks[0].total) >= 1);
      const [claimAfter] = await pool.execute(
        "SELECT * FROM claims WHERE tenant_id = 'tenant_default' AND claim_id = ?",
        [approvalSignal.claimId],
      );
      const [registryAfter] = await pool.execute("SELECT COUNT(*) AS total FROM shared_fraud_registry_entries");
      assert.deepEqual(claimAfter, claimBefore);
      assert.equal(Number(registryAfter[0].total), Number(registryBefore[0].total));

      const legacySignal = await createSignal(pool, repositories, `${suffix}c`);
      const legacyInvestigation = await repositories.investigations.createInvestigation({
        claimId: legacySignal.claimId,
        assignedBy: "analyst-legacy",
        expectedClaimVersion: 1,
        correlationId: `legacy-investigation-${suffix}`,
      });
      await pool.execute(
        "UPDATE investigations SET status = 'CONFIRMED_FRAUD', fraud_confirmed_at = UTC_TIMESTAMP(3) WHERE tenant_id = 'tenant_default' AND investigation_id = ?",
        [legacyInvestigation.investigationId],
      );
      const migrated = await repositories.cases.resolveLegacyInvestigationCase({
        legacyInvestigationId: legacyInvestigation.investigationId,
        actorContext: analyst,
        correlationId: `legacy-first-access-${suffix}`,
      });
      assert.equal(migrated.case.currentState, CASE_STATE.TRIAGE_PENDING);
      assert.equal(migrated.case.legacyStatus, "CONFIRMED_FRAUD");
      assert.equal(migrated.case.migrationReviewStatus, "REVIEW_REQUIRED");
      const migratedReplay = await repositories.cases.resolveLegacyInvestigationCase({
        legacyInvestigationId: legacyInvestigation.investigationId,
        actorContext: analyst,
        correlationId: `legacy-first-access-replay-${suffix}`,
      });
      assert.equal(migratedReplay.case.caseId, migrated.case.caseId);
      assert.equal(migratedReplay.replayed, true);
      const [legacyOutcomes] = await pool.execute(
        "SELECT COUNT(*) AS total FROM case_outcomes WHERE tenant_id = 'tenant_default' AND case_id = ?",
        [migrated.case.caseId],
      );
      assert.equal(Number(legacyOutcomes[0].total), 0);

      const otherTenantId = `tenant-${suffix}`;
      await pool.execute(
        "INSERT INTO tenants (tenant_id, tenant_slug, tenant_name, status) VALUES (?, ?, ?, 'active')",
        [otherTenantId, otherTenantId, `Tenant ${suffix}`],
      );
      const tenantB = createOperationalRepositories(dataPlaneContext(otherTenantId), pool);
      assert.equal(await tenantB.cases.getCase(migrated.case.caseId), null);
    } finally {
      if (previousCodes === undefined) delete process.env.SEQURIN_CASE_OUTCOME_CODES;
      else process.env.SEQURIN_CASE_OUTCOME_CODES = previousCodes;
      await pool.end();
    }
  },
);
