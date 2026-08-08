import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";

import {
  applyMigrations,
  AssessmentContextRepositoryError,
  createMysqlConnection,
  createOperationalRepositories,
  requestAssessmentReassessment,
} from "../src/index.js";
import {
  legacyDataPlaneContext,
  legacyFixture,
} from "../test-support/legacy-first-access-fixture.js";

const databaseUrl = process.env.OPERATIONAL_TEST_MYSQL_URL || "";

function jsonObject(value) {
  if (Buffer.isBuffer(value)) return JSON.parse(value.toString("utf8"));
  if (typeof value === "string") return JSON.parse(value);
  return value;
}

async function countRows(pool, sql, values = []) {
  const [rows] = await pool.execute(sql, values);
  return Number(rows[0].total);
}

async function requestReassessment(pool, values) {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const result = await requestAssessmentReassessment(connection, values);
    await connection.commit();
    return result;
  } catch (error) {
    try { await connection.rollback(); } catch { /* preserve original */ }
    throw error;
  } finally {
    connection.release();
  }
}

async function ingestAssessment(repositories, suffix) {
  const fixture = legacyFixture(suffix);
  const ingestion = await repositories.claims.ingestClaims({
    claims: fixture.claims,
    schemes: fixture.schemes,
    members: fixture.members,
    providers: fixture.providers,
    source: "assessment-reassessment-mysql-test",
    correlationId: `ingest-${suffix}`,
  });
  return {
    fixture,
    assessmentId: ingestion.processing.assessmentId,
    jobId: ingestion.processing.jobId,
  };
}

async function insertDetectionResult(pool, { assessment, jobId, requestId }) {
  const payload = JSON.stringify({
    schemaVersion: "claimguard.claim-detection-result.v1",
    reasonCodes: ["ASSESSMENT_REASSESSMENT_TEST"],
    evidenceReferences: [`evidence:${requestId}`],
  });
  await pool.execute(
    `INSERT INTO claim_detection_results (
       tenant_id, assessment_id, claim_id, claim_version,
       detection_strategy_id, strategy_type, model_deployment_id,
       source_job_id, request_id, analysis_mode,
       ensemble_id, ensemble_version, feature_schema_version,
       scored_at, result_payload, result_hash
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'PROSPECTIVE_CLAIM_SCREENING',
       NULL, NULL, NULL, UTC_TIMESTAMP(3), ?, ?)`,
    [
      assessment.tenant_id,
      assessment.assessment_id,
      assessment.claim_id,
      assessment.claim_version,
      assessment.detection_strategy_id,
      assessment.strategy_type,
      assessment.model_deployment_id,
      jobId,
      requestId,
      payload,
      crypto.createHash("sha256").update(payload).digest("hex"),
    ],
  );
}

test(
  "real MySQL explicit reassessment is tenant-scoped, source-pinned and idempotent",
  { skip: !databaseUrl },
  async () => {
    const pool = createMysqlConnection(databaseUrl);
    try {
      await applyMigrations(pool, undefined, { applicationVersion: "assessment-reassessment-test" });
      const repositories = createOperationalRepositories(legacyDataPlaneContext(), pool);
      const suffix = `RA${crypto.randomUUID().replaceAll("-", "").slice(0, 10)}`;
      const {
        fixture,
        assessmentId: sourceAssessmentId,
        jobId: sourceJobId,
      } = await ingestAssessment(repositories, suffix);

      const [sourceRows] = await pool.execute(
        `SELECT assessment_id, tenant_id, claim_id, claim_version,
                member_id, member_version, provider_id, provider_version,
                detection_strategy_id, strategy_type, model_deployment_id,
                provenance_status, supersedes_assessment_id,
                source_correction_event_id
           FROM assessment_versions
          WHERE tenant_id = 'tenant_default' AND assessment_id = ?
          LIMIT 1`,
        [sourceAssessmentId],
      );
      assert.equal(sourceRows.length, 1);
      const source = sourceRows[0];
      assert.equal(source.provenance_status, "COMPLETE");

      const nextMemberVersion = Number(source.member_version) + 1;
      const nextProviderVersion = Number(source.provider_version) + 1;
      await pool.execute(
        `INSERT INTO member_versions (
           tenant_id, member_id, member_version, scheme_id,
           first_name, last_name, date_of_birth, gender, identity_number,
           banking_detail, home_region, home_lat, home_lon, join_date,
           version_reason, source_reference, created_by, payload_hash
         )
         SELECT tenant_id, member_id, ?, scheme_id,
                first_name, last_name, date_of_birth, gender, identity_number,
                banking_detail, home_region, home_lat, home_lon, join_date,
                'TEST_CURRENT_POINTER_ADVANCE', 'test:reassessment',
                'test:reassessment', payload_hash
           FROM member_versions
          WHERE tenant_id = ? AND member_id = ? AND member_version = ?`,
        [nextMemberVersion, source.tenant_id, source.member_id, source.member_version],
      );
      await pool.execute(
        `UPDATE members SET current_member_version = ?
          WHERE tenant_id = ? AND member_id = ?`,
        [nextMemberVersion, source.tenant_id, source.member_id],
      );
      await pool.execute(
        `INSERT INTO provider_versions (
           tenant_id, provider_id, provider_version, scheme_id,
           practice_number, specialty, practice_name, banking_detail,
           practice_region, practice_lat, practice_lon, provider_kind,
           provider_category, version_reason, source_reference, created_by,
           payload_hash
         )
         SELECT tenant_id, provider_id, ?, scheme_id,
                practice_number, specialty, practice_name, banking_detail,
                practice_region, practice_lat, practice_lon, provider_kind,
                provider_category, 'TEST_CURRENT_POINTER_ADVANCE',
                'test:reassessment', 'test:reassessment', payload_hash
           FROM provider_versions
          WHERE tenant_id = ? AND provider_id = ? AND provider_version = ?`,
        [nextProviderVersion, source.tenant_id, source.provider_id, source.provider_version],
      );
      await pool.execute(
        `UPDATE providers SET current_provider_version = ?
          WHERE tenant_id = ? AND provider_id = ?`,
        [nextProviderVersion, source.tenant_id, source.provider_id],
      );

      const [claimBeforeRows] = await pool.execute(
        `SELECT updated_at FROM claims
          WHERE tenant_id = ? AND claim_id = ? LIMIT 1`,
        [source.tenant_id, source.claim_id],
      );
      const claimUpdatedAtBefore = String(claimBeforeRows[0].updated_at);
      const governanceBefore = {
        cases: await countRows(pool, "SELECT COUNT(*) AS total FROM investigation_cases"),
        transitions: await countRows(pool, "SELECT COUNT(*) AS total FROM case_transition_events"),
        registry: await countRows(pool, "SELECT COUNT(*) AS total FROM shared_fraud_registry_entries"),
        unpinnedPendingJobs: await countRows(
          pool,
          `SELECT COUNT(*) AS total FROM claim_processing_outbox
            WHERE job_type = 'claim_detection'
              AND assessment_id IS NULL
              AND status IN ('pending','retry','processing')`,
        ),
      };

      const idempotencyKey = `reassess-${suffix}`;
      const first = await requestReassessment(pool, {
        tenantId: source.tenant_id,
        sourceAssessmentId,
        idempotencyKey,
        createdBy: "user:reassessment-test",
        source: "api:reassessment:reassessment-test",
        correlationId: `reassess-${suffix}-1`,
      });
      assert.equal(first.replayed, false);
      assert.equal(first.sourceAssessmentId, sourceAssessmentId);
      assert.notEqual(first.assessmentId, sourceAssessmentId);
      assert.match(first.operationId, /^[0-9a-f]{64}$/);

      const second = await requestReassessment(pool, {
        tenantId: source.tenant_id,
        sourceAssessmentId,
        idempotencyKey: `  ${idempotencyKey}  `,
        createdBy: "user:reassessment-test",
        source: "api:reassessment:reassessment-test",
        correlationId: `reassess-${suffix}-2`,
      });
      assert.equal(second.replayed, true);
      assert.equal(second.assessmentId, first.assessmentId);
      assert.equal(second.jobId, first.jobId);
      assert.equal(second.operationId, first.operationId);

      const [replacementRows] = await pool.execute(
        `SELECT assessment_id, tenant_id, claim_id, claim_version,
                member_id, member_version, provider_id, provider_version,
                detection_strategy_id, strategy_type, model_deployment_id,
                provenance_status, assessment_reason,
                supersedes_assessment_id, source_correction_event_id
           FROM assessment_versions
          WHERE tenant_id = ? AND supersedes_assessment_id = ?
            AND assessment_reason = 'EXPLICIT_REASSESSMENT'`,
        [source.tenant_id, sourceAssessmentId],
      );
      assert.equal(replacementRows.length, 1);
      const replacement = replacementRows[0];
      assert.equal(replacement.assessment_id, first.assessmentId);
      assert.equal(replacement.claim_id, source.claim_id);
      assert.equal(Number(replacement.claim_version), Number(source.claim_version));
      assert.equal(replacement.member_id, source.member_id);
      assert.equal(Number(replacement.member_version), Number(source.member_version));
      assert.notEqual(Number(replacement.member_version), nextMemberVersion);
      assert.equal(replacement.provider_id, source.provider_id);
      assert.equal(Number(replacement.provider_version), Number(source.provider_version));
      assert.notEqual(Number(replacement.provider_version), nextProviderVersion);
      assert.equal(Number(replacement.detection_strategy_id), Number(source.detection_strategy_id));
      assert.equal(replacement.strategy_type, source.strategy_type);
      assert.equal(replacement.model_deployment_id ?? null, source.model_deployment_id ?? null);
      assert.equal(replacement.supersedes_assessment_id, sourceAssessmentId);
      assert.equal(replacement.source_correction_event_id, null);
      assert.equal(replacement.provenance_status, "COMPLETE");

      const [jobRows] = await pool.execute(
        `SELECT id, assessment_id, job_type, payload, status
           FROM claim_processing_outbox
          WHERE tenant_id = ? AND assessment_id = ?`,
        [source.tenant_id, first.assessmentId],
      );
      assert.equal(jobRows.length, 1);
      assert.equal(jobRows[0].id, first.jobId);
      assert.equal(jobRows[0].job_type, "claim_detection");
      const payload = jsonObject(jobRows[0].payload);
      assert.equal(payload.schema_version, 3);
      assert.equal(payload.dataset_scope, "assessment_version");
      assert.equal(payload.assessment_id, first.assessmentId);
      assert.deepEqual(payload.targets, [{
        claim_id: source.claim_id,
        claim_version: Number(source.claim_version),
      }]);
      assert.equal(Object.hasOwn(payload, "context_cutoff_at"), false);

      await insertDetectionResult(pool, {
        assessment: replacement,
        jobId: first.jobId,
        requestId: `replacement-${suffix}`,
      });
      assert.equal(
        await countRows(
          pool,
          `SELECT COUNT(*) AS total FROM detection_signal_supersessions
            WHERE tenant_id = ? AND replacement_assessment_id = ?`,
          [source.tenant_id, first.assessmentId],
        ),
        0,
      );

      await insertDetectionResult(pool, {
        assessment: source,
        jobId: sourceJobId,
        requestId: `source-${suffix}`,
      });
      const [supersessionRows] = await pool.execute(
        `SELECT supersession_id, superseded_signal_id, replacement_signal_id,
                previous_assessment_id, replacement_assessment_id,
                correction_event_id, reason_code, correlation_id
           FROM detection_signal_supersessions
          WHERE tenant_id = ? AND previous_assessment_id = ?
            AND replacement_assessment_id = ?`,
        [source.tenant_id, sourceAssessmentId, first.assessmentId],
      );
      assert.equal(supersessionRows.length, 1);
      assert.notEqual(supersessionRows[0].superseded_signal_id, supersessionRows[0].replacement_signal_id);
      assert.equal(supersessionRows[0].correction_event_id, null);
      assert.equal(supersessionRows[0].reason_code, "EXPLICIT_REASSESSMENT");
      assert.equal(supersessionRows[0].correlation_id, `replacement-${suffix}`);

      await assert.rejects(
        () => pool.execute(
          `UPDATE detection_signal_supersessions SET reason_code = 'MUTATED'
            WHERE supersession_id = ?`,
          [supersessionRows[0].supersession_id],
        ),
        /SIGNAL_SUPERSESSION_IMMUTABLE/,
      );

      const [operationRows] = await pool.execute(
        `SELECT operation_id, assessment_id, intent_hash, result_payload
           FROM reassessment_operations
          WHERE tenant_id = ? AND idempotency_key = ?`,
        [source.tenant_id, idempotencyKey],
      );
      assert.equal(operationRows.length, 1);
      assert.equal(operationRows[0].assessment_id, sourceAssessmentId);
      assert.match(operationRows[0].operation_id, /^[0-9a-f]{64}$/);
      assert.match(operationRows[0].intent_hash, /^[0-9a-f]{64}$/);
      assert.deepEqual(jsonObject(operationRows[0].result_payload), {
        sourceAssessmentId,
        assessmentId: first.assessmentId,
        jobId: first.jobId,
        status: first.status,
      });

      await assert.rejects(
        () => requestReassessment(pool, {
          tenantId: "tenant_other",
          sourceAssessmentId,
          idempotencyKey: `cross-tenant-${suffix}`,
          createdBy: "user:reassessment-test",
          source: "api:reassessment:reassessment-test",
          correlationId: `cross-tenant-${suffix}`,
        }),
        (error) => error instanceof AssessmentContextRepositoryError
          && error.code === "ASSESSMENT_NOT_FOUND"
          && error.status === 404,
      );

      const legacyPartialId = crypto.randomUUID();
      await pool.execute(
        `INSERT INTO assessment_versions (
           assessment_id, tenant_id, claim_id, claim_version,
           member_id, member_version, provider_id, provider_version,
           detection_strategy_id, strategy_type, model_deployment_id,
           model_or_rule_version, feature_schema_version, reference_data_version,
           input_snapshot, input_hash, assessment_reason,
           supersedes_assessment_id, source_correction_event_id,
           provenance_status, created_by
         )
         SELECT ?, tenant_id, claim_id, claim_version,
                member_id, member_version, provider_id, provider_version,
                detection_strategy_id, strategy_type, model_deployment_id,
                model_or_rule_version, feature_schema_version, reference_data_version,
                input_snapshot, input_hash, 'TEST_LEGACY_PARTIAL',
                NULL, NULL, 'LEGACY_PARTIAL', 'test:reassessment'
           FROM assessment_versions
          WHERE tenant_id = ? AND assessment_id = ?`,
        [legacyPartialId, source.tenant_id, sourceAssessmentId],
      );
      await assert.rejects(
        () => requestReassessment(pool, {
          tenantId: source.tenant_id,
          sourceAssessmentId: legacyPartialId,
          idempotencyKey: `legacy-${suffix}`,
          createdBy: "user:reassessment-test",
          source: "api:reassessment:reassessment-test",
          correlationId: `legacy-${suffix}`,
        }),
        (error) => error instanceof AssessmentContextRepositoryError
          && error.code === "ASSESSMENT_REASSESSMENT_PROVENANCE_INCOMPLETE"
          && error.status === 409,
      );

      const secondSource = await ingestAssessment(repositories, `RB${suffix.slice(2)}`);
      await assert.rejects(
        () => requestReassessment(pool, {
          tenantId: source.tenant_id,
          sourceAssessmentId: secondSource.assessmentId,
          idempotencyKey,
          createdBy: "user:reassessment-test",
          source: "api:reassessment:reassessment-test",
          correlationId: `mismatch-${suffix}`,
        }),
        (error) => error instanceof AssessmentContextRepositoryError
          && error.code === "ASSESSMENT_REASSESSMENT_IDEMPOTENCY_MISMATCH"
          && error.status === 409,
      );
      assert.equal(
        await countRows(
          pool,
          `SELECT COUNT(*) AS total FROM assessment_versions
            WHERE tenant_id = ? AND supersedes_assessment_id = ?`,
          [source.tenant_id, secondSource.assessmentId],
        ),
        0,
      );

      const [claimAfterRows] = await pool.execute(
        `SELECT updated_at FROM claims
          WHERE tenant_id = ? AND claim_id = ? LIMIT 1`,
        [source.tenant_id, source.claim_id],
      );
      assert.equal(String(claimAfterRows[0].updated_at), claimUpdatedAtBefore);
      assert.deepEqual({
        cases: await countRows(pool, "SELECT COUNT(*) AS total FROM investigation_cases"),
        transitions: await countRows(pool, "SELECT COUNT(*) AS total FROM case_transition_events"),
        registry: await countRows(pool, "SELECT COUNT(*) AS total FROM shared_fraud_registry_entries"),
        unpinnedPendingJobs: await countRows(
          pool,
          `SELECT COUNT(*) AS total FROM claim_processing_outbox
            WHERE job_type = 'claim_detection'
              AND assessment_id IS NULL
              AND status IN ('pending','retry','processing')`,
        ),
      }, governanceBefore);

      assert.equal(
        await countRows(
          pool,
          `SELECT COUNT(*) AS total FROM reassessment_operations
            WHERE tenant_id = ? AND idempotency_key = ?`,
          [source.tenant_id, idempotencyKey],
        ),
        1,
      );
      assert.equal(fixture.claims[0].claim_id, source.claim_id);
    } finally {
      await pool.end();
    }
  },
);
