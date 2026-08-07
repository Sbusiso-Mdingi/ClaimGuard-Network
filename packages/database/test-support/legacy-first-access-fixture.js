import assert from "node:assert/strict";
import crypto from "node:crypto";

import {
  CASE_PERMISSION,
  CASE_PERMISSION_POLICY_VERSION,
  createDataPlaneContext,
} from "../src/index.js";

export function legacyDataPlaneContext(tenantId = "tenant_default", tenantSlug = "default") {
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

export function legacyMigrationActor(actorId = "legacy-reviewer", tenantId = "tenant_default") {
  return Object.freeze({
    actorId,
    tenantId,
    permissions: Object.freeze([CASE_PERMISSION.TRIAGE]),
    roles: Object.freeze(["fraud_analyst"]),
    permissionPolicyVersion: CASE_PERMISSION_POLICY_VERSION,
  });
}

export function legacyFixture(suffix, tenantPrefix = "S") {
  const schemeId = `${tenantPrefix}${suffix.slice(0, 7)}`;
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

export async function createLegacySignal(pool, repositories, suffix) {
  const value = legacyFixture(suffix);
  const ingestion = await repositories.claims.ingestClaims({
    claims: value.claims,
    schemes: value.schemes,
    members: value.members,
    providers: value.providers,
    source: "legacy-first-access-tests",
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

export async function createLegacyInvestigation(pool, repositories, suffix, status = "OPEN") {
  const signal = await createLegacySignal(pool, repositories, suffix);
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

export async function countRows(pool, sql, values = []) {
  const [rows] = await pool.execute(sql, values);
  return Number(rows[0].total);
}

export async function legacySafetySnapshot(pool, { claimId, investigationId, caseId = null }) {
  const [claims] = await pool.execute(
    "SELECT * FROM claims WHERE tenant_id = 'tenant_default' AND claim_id = ?",
    [claimId],
  );
  const [investigations] = await pool.execute(
    "SELECT * FROM investigations WHERE tenant_id = 'tenant_default' AND investigation_id = ?",
    [investigationId],
  );
  const registry = await countRows(pool, "SELECT COUNT(*) AS total FROM shared_fraud_registry_entries");
  const cases = await countRows(
    pool,
    "SELECT COUNT(*) AS total FROM investigation_cases WHERE tenant_id = 'tenant_default' AND legacy_investigation_id = ?",
    [investigationId],
  );
  const events = caseId ? await countRows(
    pool,
    "SELECT COUNT(*) AS total FROM case_transition_events WHERE tenant_id = 'tenant_default' AND case_id = ?",
    [caseId],
  ) : 0;
  const checks = caseId ? await countRows(
    pool,
    "SELECT COUNT(*) AS total FROM case_process_checks WHERE tenant_id = 'tenant_default' AND case_id = ?",
    [caseId],
  ) : 0;
  const outcomes = caseId ? await countRows(
    pool,
    "SELECT COUNT(*) AS total FROM case_outcomes WHERE tenant_id = 'tenant_default' AND case_id = ?",
    [caseId],
  ) : 0;
  return { claims, investigations, registry, cases, events, checks, outcomes };
}
