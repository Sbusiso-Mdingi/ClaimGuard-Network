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

function context(tenantId, tenantSlug = tenantId) {
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

function claimFixture(suffix) {
  const schemeId = `S${suffix.slice(0, 7)}`;
  const memberId = `MEM-${suffix}`;
  const providerId = `PRO-${suffix}`;
  const claimId = `CLM-${suffix}`;
  return {
    schemeId,
    memberId,
    providerId,
    claimId,
    schemes: [{ scheme_id: schemeId, scheme_name: `Scheme ${suffix}` }],
    members: [{
      member_id: memberId,
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
      provider_id: providerId,
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
      member_id: memberId,
      provider_id: providerId,
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
  const fixture = claimFixture(suffix);
  const ingestion = await repositories.claims.ingestClaims({
    claims: fixture.claims,
    schemes: fixture.schemes,
    members: fixture.members,
    providers: fixture.providers,
    source: "case-workflow-mysql-test",
    correlationId: `ingest-${suffix}`,
  });
  assert.ok(ingestion.processing.jobId);
  const [strategies] = await pool.execute(
    "SELECT id, strategy_type, model_deployment_id FROM detection_strategies WHERE tenant_id = 'tenant_default' AND is_active = 1 LIMIT 1",
  );
  assert.equal(strategies.length, 1);
  const requestId = `detect-${suffix}`;
  await pool.execute(
    `INSERT INTO claim_detection_results (
       tenant_id, claim_id, claim_version, detection_strategy_id, strategy_type,
       model_deployment_id, source_job_id, request_id, analysis_mode,
       ensemble_id, ensemble_version, feature_schema_version, scored_at,
       result_payload, result_hash
     ) VALUES (?, ?, 1, ?, ?, ?, ?, ?, 'PROSPECTIVE_CLAIM_SCREENING',
       NULL, NULL, NULL, UTC_TIMESTAMP(3), ?, ?)`,
    [
      "tenant_default", fixture.claimId, strategies[0].id, strategies[0].strategy_type,
      strategies[0].model_deployment_id, ingestion.processing.jobId, requestId,
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
    [fixture.claimId],
  );
  assert.equal(signals.length, 1);
  return { ...fixture, signalId: signals[0].signal_id };
}

async function action(cases, caseId, actionName, actor, input) {
  return cases.performAction({
    caseId,
    action: actionName,
    actorContext: actor,
    evidenceReferences: [],
    processCheckReferences: [],
    ...input,
  });
}

test(
  "real MySQL enforces case creation, concurrency, idempotency and independent approval",
  { skip: !databaseUrl },
  async () => {
    const previousCodes = process.env.SEQURIN_CASE_OUTCOME_CODES;
    process.env.SEQURIN_CASE_OUTCOME_CODES = "CONFIGURED_NEUTRAL_OUTCOME";
    const pool = createMysqlConnection(databaseUrl);
    const suffix = crypto.randomBytes(5).toString("hex").slice(0, 10);
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
      const repositories = createOperationalRepositories(context("tenant_default", "default"), pool);

      const concurrencySignal = await createSignal(pool, repositories, `${suffix}a`);
      const created = await repositories.cases.createOrResolveCaseFromSignal({
        signalId: concurrencySignal.signalId,
        actorId: "detection-service",
        actorRole: CASE_ROLE.DETECTION_SERVICE,
        correlationId: `case-create-${suffix}`,
      });
      const resolved = await repositories.cases.createOrResolveCaseFromSignal({
        signalId: concurrencySignal.signalId,
        actorId: "detection-service",
        actorRole: CASE_ROLE.DETECTION_SERVICE,
        correlationId: `case-create-replay-${suffix}`,
      });
      assert.equal(resolved.case.caseId, created.case.caseId);
      assert.equal(resolved.replayed, true);

      const competing = ["one", "two"].map((label) => action(
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
      assert.equal(settled.filter((result) => result.status === "fulfilled").length, 1);
      assert.equal(settled.find((result) => result.status === "rejected").reason.code, "CASE_STATE_VERSION_CONFLICT");
      const [concurrencyRows] = await pool.execute(
        "SELECT current_state, state_version FROM investigation_cases WHERE tenant_id = 'tenant_default' AND case_id = ?",
        [created.case.caseId],
      );
      assert.equal(concurrencyRows[0].current_state, CASE_STATE.TRIAGE_PENDING);
      assert.equal(Number(concurrencyRows[0].state_version), 2);
      const [concurrencyEvents] = await pool.execute(
        "SELECT COUNT(*) AS total FROM case_transition_events WHERE tenant_id = 'tenant_default' AND case_id = ?",
        [created.case.caseId],
      );
      assert.equal(Number(concurrencyEvents[0].total), 1);

      const winningIndex = settled.findIndex((result) => result.status === "fulfilled");
      const winningLabel = winningIndex === 0 ? "one" : "two";
      const replay = await action(repositories.cases, created.case.caseId, "begin-triage", analyst, {
        expectedStateVersion: 1,
        reasonCode: "TRIAGE_STARTED",
        reasonSummary: `Competing triage ${winningLabel}`,
        correlationId: `triage-replay-${suffix}`,
        idempotencyKey: `triage-${winningLabel}-${suffix}`,
      });
      assert.equal(replay.replayed, true);
      assert.equal(replay.case.stateVersion, 2);
      await assert.rejects(
        () => action(repositories.cases, created.case.caseId, "begin-triage", analyst, {
          expectedStateVersion: 1,
          reasonCode: "DIFFERENT_INTENT",
          reasonSummary: "Different intent under the same key",
          correlationId: `triage-mismatch-${suffix}`,
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
      const advance = async (actionName, actor, extra = {}) => {
        const result = await action(repositories.cases, approvalCase.caseId, actionName, actor, {
          expectedStateVersion: version,
          reasonCode: `ACTION_${actionName.toUpperCase().replaceAll("-", "_")}`,
          reasonSummary: `Perform governed action ${actionName}`,
          correlationId: `${actionName}-${suffix}`,
          idempotencyKey: `${actionName}-${suffix}`,
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

      await assert.rejects(
        () => action(repositories.cases, approvalCase.caseId, "approve-outcome", actorContext(
          "investigator-1",
          [CASE_PERMISSION.APPROVE_OUTCOME],
          ["applications_committee_member"],
        ), {
          expectedStateVersion: version,
          reasonCode: "OUTCOME_REVIEWED",
          reasonSummary: "Attempted self review",
          correlationId: `self-review-${suffix}`,
          idempotencyKey: `self-review-${suffix}`,
          outcomeCode: "CONFIGURED_NEUTRAL_OUTCOME",
          recordedReasons: ["Self review must fail."],
          identityMatchReviewResult: { reviewed: true, resultCode: "REVIEWED" },
          supportingReportReference: "report-1",
          evidenceSetReference: "evidence-set-1",
          processCheckReferences: ["process-check-1"],
          processCheckComplete: true,
        }),
        (error) => error.code === "CASE_REVIEWER_INDEPENDENCE_REQUIRED",
      );

      const [claimBefore] = await pool.execute(
        "SELECT * FROM claims WHERE tenant_id = 'tenant_default' AND claim_id = ?",
        [approvalSignal.claimId],
      );
      const [registryBefore] = await pool.execute("SELECT COUNT(*) AS total FROM shared_fraud_registry_entries");
      const approvalInput = (id) => action(repositories.cases, approvalCase.caseId, "approve-outcome", reviewer(id), {
        expectedStateVersion: version,
        reasonCode: "OUTCOME_REVIEWED",
        reasonSummary: "Independent outcome review completed",
        correlationId: `approval-${id}-${suffix}`,
        idempotencyKey: `approval-${id}-${suffix}`,
        outcomeCode: "CONFIGURED_NEUTRAL_OUTCOME",
        recordedReasons: ["Bounded neutral outcome approved."],
        identityMatchReviewResult: { reviewed: true, resultCode: "REVIEWED" },
        supportingReportReference: "report-1",
        evidenceSetReference: "evidence-set-1",
        processCheckReferences: ["process-check-1"],
        processCheckComplete: true,
      });
      const approvals = await Promise.allSettled([approvalInput("reviewer-1"), approvalInput("reviewer-2")]);
      assert.equal(approvals.filter((result) => result.status === "fulfilled").length, 1);
      assert.equal(approvals.find((result) => result.status === "rejected").reason.code, "CASE_STATE_VERSION_CONFLICT");

      const [outcomes] = await pool.execute(
        "SELECT COUNT(*) AS total FROM case_outcomes WHERE tenant_id = 'tenant_default' AND case_id = ?",
        [approvalCase.caseId],
      );
      assert.equal(Number(outcomes[0].total), 1);
      const [authorizationChecks] = await pool.execute(
        "SELECT COUNT(*) AS total FROM case_process_checks WHERE tenant_id = 'tenant_default' AND case_id = ? AND check_code = 'AUTHORIZATION_CONTEXT'",
        [approvalCase.caseId],
      );
      assert.ok(Number(authorizationChecks[0].total) >= 1);
      const [approvalEvents] = await pool.execute(
        "SELECT COUNT(*) AS total FROM case_transition_events WHERE tenant_id = 'tenant_default' AND case_id = ? AND new_state = 'OUTCOME_APPROVED'",
        [approvalCase.caseId],
      );
      assert.equal(Number(approvalEvents[0].total), 1);
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
        actorId: "analyst-legacy",
        actorRole: CASE_ROLE.SCHEME_ANALYST,
        correlationId: `legacy-first-access-${suffix}`,
      });
      assert.equal(migrated.case.currentState, CASE_STATE.TRIAGE_PENDING);
      assert.equal(migrated.case.legacyStatus, "CONFIRMED_FRAUD");
      assert.equal(migrated.case.migrationReviewStatus, "REVIEW_REQUIRED");
      const migratedReplay = await repositories.cases.resolveLegacyInvestigationCase({
        legacyInvestigationId: legacyInvestigation.investigationId,
        actorId: "analyst-legacy",
        actorRole: CASE_ROLE.SCHEME_ANALYST,
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
      const tenantB = createOperationalRepositories(context(otherTenantId), pool);
      assert.equal(await tenantB.cases.getCase(migrated.case.caseId), null);
      await assert.rejects(
        () => action(tenantB.cases, migrated.case.caseId, "dismiss", actorContext(
          "tenant-b-analyst",
          [CASE_PERMISSION.DISMISS],
          ["fraud_analyst"],
          otherTenantId,
        ), {
          expectedStateVersion: migrated.case.stateVersion,
          reasonCode: "CROSS_TENANT",
          reasonSummary: "Cross-tenant mutation must fail",
          correlationId: `cross-tenant-${suffix}`,
          idempotencyKey: `cross-tenant-${suffix}`,
        }),
        (error) => error.code === "CASE_NOT_FOUND",
      );
    } finally {
      if (previousCodes === undefined) delete process.env.SEQURIN_CASE_OUTCOME_CODES;
      else process.env.SEQURIN_CASE_OUTCOME_CODES = previousCodes;
      await pool.end();
    }
  },
);
