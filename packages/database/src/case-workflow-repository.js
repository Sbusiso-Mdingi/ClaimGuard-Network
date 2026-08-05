import crypto from "node:crypto";

import { repositoryTenantId } from "./repository-context.js";
import {
  assertCaseProcessRequirements,
  assertCaseTransition,
  CASE_ERROR_CODE,
  CASE_ROLE,
  CASE_STATE,
  CASE_WORKFLOW_VERSION,
  CasePolicyError,
} from "./case-transition-policy.js";
import { stableStringify } from "./ledger-entry.js";

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function requiredString(value, fieldName, maxLength = 255) {
  if (typeof value !== "string" || !value.trim()) {
    throw new CasePolicyError(`${fieldName} is required.`, CASE_ERROR_CODE.VALIDATION_FAILED);
  }
  const normalized = value.trim();
  if (normalized.length > maxLength) {
    throw new CasePolicyError(`${fieldName} is too long.`, CASE_ERROR_CODE.VALIDATION_FAILED);
  }
  return normalized;
}

function optionalString(value, fieldName, maxLength = 255) {
  if (value === null || value === undefined || value === "") return null;
  return requiredString(value, fieldName, maxLength);
}

function requiredVersion(value) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 2_147_483_647) {
    throw new CasePolicyError(
      "A positive bounded case state version is required.",
      CASE_ERROR_CODE.VALIDATION_FAILED,
    );
  }
  return parsed;
}

function parseJson(value, fallback = null) {
  if (value == null) return fallback;
  if (typeof value === "string") {
    try { return JSON.parse(value); } catch { return fallback; }
  }
  return value;
}

function normalizedReferences(value) {
  if (!Array.isArray(value)) return [];
  return value.map((reference) => requiredString(reference, "reference", 255));
}

function mapCase(row) {
  if (!row) return null;
  return {
    caseId: row.case_id,
    tenantId: row.tenant_id,
    signalId: row.signal_id,
    claimId: row.claim_id,
    claimVersion: Number(row.claim_version),
    currentState: row.current_state,
    stateVersion: Number(row.state_version),
    assignedInvestigatorId: row.assigned_investigator_id || null,
    triageOwnerId: row.triage_owner_id || null,
    originatingReason: row.originating_reason || null,
    correlationId: row.correlation_id,
    lastTransitionEventId: row.last_transition_event_id || null,
    reportCompletingInvestigatorId: row.report_completing_investigator_id || null,
    reportReference: row.report_reference || null,
    reportDigest: row.report_digest || null,
    reportCompletionEventId: row.report_completion_event_id || null,
    legacyInvestigationId: row.legacy_investigation_id || null,
    legacyStatus: row.legacy_status || null,
    migrationReviewStatus: row.migration_review_status || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function transaction(pool, operation) {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const result = await operation(connection);
    await connection.commit();
    return result;
  } catch (error) {
    await connection.rollback();
    if (error?.code === "ER_DUP_ENTRY" || error?.errno === 1062) {
      throw new CasePolicyError(
        "The case workflow changed concurrently.",
        CASE_ERROR_CODE.STATE_VERSION_CONFLICT,
      );
    }
    throw error;
  } finally {
    connection.release();
  }
}

async function loadCase(executor, tenantId, caseId, forUpdate = false) {
  const [rows] = await executor.execute(
    `SELECT case_id, tenant_id, signal_id, claim_id, claim_version, current_state,
            state_version, assigned_investigator_id, triage_owner_id,
            originating_reason, correlation_id, last_transition_event_id,
            report_completing_investigator_id, report_reference, report_digest,
            report_completion_event_id, legacy_investigation_id, legacy_status,
            migration_review_status, created_at, updated_at
       FROM investigation_cases
      WHERE tenant_id = ? AND case_id = ?
      LIMIT 1${forUpdate ? " FOR UPDATE" : ""}`,
    [tenantId, caseId],
  );
  return mapCase(rows?.[0] || null);
}

async function resolveReplay(executor, { tenantId, caseId, idempotencyKey, intentHash }) {
  const [rows] = await executor.execute(
    `SELECT case_id, intent_hash, result_payload
       FROM case_transition_operations
      WHERE tenant_id = ? AND idempotency_key = ?
      LIMIT 1 FOR UPDATE`,
    [tenantId, idempotencyKey],
  );
  const row = rows?.[0];
  if (!row) return null;
  if (row.case_id === caseId && row.intent_hash === intentHash) {
    return { ...parseJson(row.result_payload, {}), replayed: true };
  }
  throw new CasePolicyError(
    "The idempotency key has already been used for a different case transition intent.",
    CASE_ERROR_CODE.IDEMPOTENCY_MISMATCH,
  );
}

async function recordProcessCheck(executor, {
  tenantId,
  caseId,
  checkCode,
  checkResult,
  actorId,
  actorRole,
  correlationId,
  transitionEventId,
}) {
  const processCheckId = crypto.randomUUID();
  await executor.execute(
    `INSERT INTO case_process_checks (
       process_check_id, tenant_id, case_id, check_code, check_result,
       recorded_by, recorded_by_role, correlation_id, transition_event_id
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [processCheckId, tenantId, caseId, checkCode, JSON.stringify(checkResult),
      actorId, actorRole, correlationId, transitionEventId],
  );
  return processCheckId;
}

async function persistTransitionProcessChecks(executor, {
  tenantId,
  caseId,
  toState,
  actorId,
  actorRole,
  correlationId,
  transitionEventId,
  processCheckReferences,
  evidenceReferences,
  noEvidenceReason,
  reportReference,
  reportDigest,
  completionReason,
  identityMatchReviewResult,
  processCheckComplete,
}) {
  const persisted = [];
  for (const reference of processCheckReferences) {
    persisted.push(await recordProcessCheck(executor, {
      tenantId,
      caseId,
      checkCode: "PROCESS_REFERENCE",
      checkResult: { reference },
      actorId,
      actorRole,
      correlationId,
      transitionEventId,
    }));
  }

  if (toState === CASE_STATE.INVESTIGATION_REPORT_COMPLETED) {
    persisted.push(await recordProcessCheck(executor, {
      tenantId,
      caseId,
      checkCode: "REPORT_COMPLETION_REQUIREMENTS",
      checkResult: {
        complete: true,
        evidenceReferences,
        noEvidenceReason: noEvidenceReason || null,
        reportReference: reportReference || null,
        reportDigest: reportDigest || null,
        completionReason,
      },
      actorId,
      actorRole,
      correlationId,
      transitionEventId,
    }));
  }

  if (toState === CASE_STATE.OUTCOME_APPROVED) {
    persisted.push(await recordProcessCheck(executor, {
      tenantId,
      caseId,
      checkCode: "OUTCOME_REVIEW_REQUIREMENTS",
      checkResult: {
        complete: processCheckComplete === true,
        identityMatchReviewResult,
      },
      actorId,
      actorRole,
      correlationId,
      transitionEventId,
    }));
  }
  return persisted;
}

function assertOutcomeCatalogue({ toState, outcomeCode, configuredOutcomeCodes }) {
  if (toState !== CASE_STATE.OUTCOME_APPROVED) return;
  if (configuredOutcomeCodes.length === 0) {
    throw new CasePolicyError(
      "No governed case outcome catalogue is configured.",
      "CASE_OUTCOME_CODE_NOT_CONFIGURED",
      503,
    );
  }
  if (!configuredOutcomeCodes.includes(outcomeCode)) {
    throw new CasePolicyError(
      "The requested outcome code is not allowed by the configured governed catalogue.",
      "CASE_OUTCOME_CODE_NOT_ALLOWED",
      422,
    );
  }
}

export function createCaseWorkflowRepository(
  pool,
  { dataPlaneContext = null, allowLegacyTenantContext = false, allowedOutcomeCodes = [] } = {},
) {
  if (!pool || typeof pool.getConnection !== "function") {
    throw new TypeError("A mysql2 transaction-capable pool is required for case workflows.");
  }
  if (!dataPlaneContext && !allowLegacyTenantContext) repositoryTenantId(null);
  const canonicalTenantId = () => repositoryTenantId(dataPlaneContext, { allowLegacyTenantContext });
  const configuredOutcomeCodes = [...new Set(
    (allowedOutcomeCodes || []).filter((value) => typeof value === "string" && value.trim())
      .map((value) => value.trim()),
  )];

  return {
    async getCase(caseId) {
      return loadCase(pool, canonicalTenantId(), requiredString(caseId, "caseId", 64));
    },

    async createOrResolveCaseFromSignal({ signalId, actorId, actorRole, correlationId }) {
      const tenantId = canonicalTenantId();
      const normalizedSignalId = requiredString(signalId, "signalId", 64);
      requiredString(actorId, "actorId");
      const normalizedCorrelationId = requiredString(correlationId, "correlationId", 128);
      if (actorRole !== CASE_ROLE.DETECTION_SERVICE) {
        throw new CasePolicyError(
          "Only the authorised detection workflow may create the initial signal case.",
          CASE_ERROR_CODE.ROLE_NOT_AUTHORISED,
        );
      }

      try {
        return await transaction(pool, async (executor) => {
          const [existing] = await executor.execute(
            "SELECT case_id FROM investigation_cases WHERE tenant_id = ? AND signal_id = ? LIMIT 1 FOR UPDATE",
            [tenantId, normalizedSignalId],
          );
          if (existing?.[0]) {
            return {
              case: await loadCase(executor, tenantId, existing[0].case_id),
              replayed: true,
            };
          }

          const [signals] = await executor.execute(
            `SELECT signal_id, claim_id, claim_version, correlation_id, reason_codes
               FROM detection_signals
              WHERE tenant_id = ? AND signal_id = ?
              LIMIT 1 FOR UPDATE`,
            [tenantId, normalizedSignalId],
          );
          const signal = signals?.[0];
          if (!signal) {
            throw new CasePolicyError(
              "The signal was not found in the active tenant.",
              CASE_ERROR_CODE.NOT_FOUND,
            );
          }
          const caseId = crypto.randomUUID();
          await executor.execute(
            `INSERT INTO investigation_cases (
               case_id, tenant_id, signal_id, claim_id, claim_version, current_state,
               state_version, originating_reason, correlation_id, migration_review_status
             ) VALUES (?, ?, ?, ?, ?, 'SIGNAL_GENERATED', 1, ?, ?, 'NOT_APPLICABLE')`,
            [caseId, tenantId, normalizedSignalId, signal.claim_id, signal.claim_version,
              JSON.stringify(parseJson(signal.reason_codes, [])), normalizedCorrelationId],
          );
          return { case: await loadCase(executor, tenantId, caseId), replayed: false };
        });
      } catch (error) {
        if (error?.code === CASE_ERROR_CODE.STATE_VERSION_CONFLICT) {
          const [rows] = await pool.execute(
            "SELECT case_id FROM investigation_cases WHERE tenant_id = ? AND signal_id = ? LIMIT 1",
            [tenantId, normalizedSignalId],
          );
          if (rows?.[0]) {
            return { case: await loadCase(pool, tenantId, rows[0].case_id), replayed: true };
          }
        }
        throw error;
      }
    },

    async transitionCase(input) {
      const tenantId = canonicalTenantId();
      const caseId = requiredString(input?.caseId, "caseId", 64);
      const actorId = requiredString(input?.actorId, "actorId");
      const actorRole = requiredString(input?.actorRole, "actorRole", 64);
      const toState = requiredString(input?.toState, "toState", 64);
      const expectedStateVersion = requiredVersion(input?.expectedStateVersion);
      const reasonCode = requiredString(input?.reasonCode, "reasonCode", 128);
      const reasonSummary = requiredString(input?.reasonSummary, "reasonSummary", 1024);
      const correlationId = requiredString(input?.correlationId, "correlationId", 128);
      const idempotencyKey = requiredString(input?.idempotencyKey, "idempotencyKey", 128);
      const evidenceReferences = normalizedReferences(input?.evidenceReferences);
      const processCheckReferences = normalizedReferences(input?.processCheckReferences);
      const normalized = {
        assignedInvestigatorId: optionalString(input?.assignedInvestigatorId, "assignedInvestigatorId"),
        noEvidenceReason: optionalString(input?.noEvidenceReason, "noEvidenceReason", 1024),
        reportReference: optionalString(input?.reportReference, "reportReference"),
        reportDigest: optionalString(input?.reportDigest, "reportDigest"),
        completionReason: optionalString(input?.completionReason, "completionReason", 128),
        outcomeCode: optionalString(input?.outcomeCode, "outcomeCode", 64),
        recordedReasons: input?.recordedReasons ?? null,
        identityMatchReviewResult: input?.identityMatchReviewResult ?? null,
        supportingReportReference: optionalString(input?.supportingReportReference, "supportingReportReference"),
        evidenceSetReference: optionalString(input?.evidenceSetReference, "evidenceSetReference"),
        processCheckComplete: input?.processCheckComplete === true,
      };
      const intent = {
        tenantId,
        caseId,
        toState,
        expectedStateVersion,
        reasonCode,
        reasonSummary,
        actorId,
        actorRole,
        evidenceReferences,
        processCheckReferences,
        ...normalized,
      };
      const intentHash = sha256(stableStringify(intent));
      const operationId = sha256(stableStringify({ tenantId, caseId, idempotencyKey }));

      return transaction(pool, async (executor) => {
        const replay = await resolveReplay(executor, {
          tenantId,
          caseId,
          idempotencyKey,
          intentHash,
        });
        if (replay) return replay;

        const current = await loadCase(executor, tenantId, caseId, true);
        if (!current) {
          throw new CasePolicyError(
            "The case was not found in the active tenant.",
            CASE_ERROR_CODE.NOT_FOUND,
          );
        }
        if (current.stateVersion !== expectedStateVersion) {
          throw new CasePolicyError(
            "The case changed after it was loaded. Refresh and retry.",
            CASE_ERROR_CODE.STATE_VERSION_CONFLICT,
          );
        }

        assertOutcomeCatalogue({
          toState,
          outcomeCode: normalized.outcomeCode,
          configuredOutcomeCodes,
        });
        assertCaseTransition({
          fromState: current.currentState,
          toState,
          actorRole,
          actorId,
          reportCompletingInvestigatorId: current.reportCompletingInvestigatorId,
        });
        assertCaseProcessRequirements({
          fromState: current.currentState,
          toState,
          actorId,
          assignedInvestigatorId: normalized.assignedInvestigatorId || current.assignedInvestigatorId,
          reportCompletingInvestigatorId: current.reportCompletingInvestigatorId,
          reportCompletionEventId: current.reportCompletionEventId,
          evidenceReferences,
          processCheckReferences,
          noEvidenceReason: normalized.noEvidenceReason,
          reportReference: normalized.reportReference,
          reportDigest: normalized.reportDigest,
          completionReason: normalized.completionReason || reasonSummary,
          outcomeCode: normalized.outcomeCode,
          allowedOutcomeCodes: configuredOutcomeCodes,
          recordedReasons: normalized.recordedReasons,
          identityMatchReviewResult: normalized.identityMatchReviewResult,
          supportingReportReference: normalized.supportingReportReference || current.reportReference,
          evidenceSetReference: normalized.evidenceSetReference,
          processCheckComplete: normalized.processCheckComplete,
        });

        const eventId = crypto.randomUUID();
        const outcomeId = toState === CASE_STATE.OUTCOME_APPROVED ? crypto.randomUUID() : null;
        const nextVersion = current.stateVersion + 1;

        await executor.execute(
          `INSERT INTO case_transition_operations (
             operation_id, tenant_id, case_id, idempotency_key, intent_hash, result_payload
           ) VALUES (?, ?, ?, ?, ?, JSON_OBJECT())`,
          [operationId, tenantId, caseId, idempotencyKey, intentHash],
        );
        await executor.execute(
          `INSERT INTO case_transition_events (
             event_id, tenant_id, case_id, previous_state, new_state,
             state_version_before, state_version_after, actor_id, actor_role,
             reason_code, reason_summary, evidence_references, process_check_references,
             correlation_id, operation_id, workflow_version
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [eventId, tenantId, caseId, current.currentState, toState,
            current.stateVersion, nextVersion, actorId, actorRole, reasonCode, reasonSummary,
            JSON.stringify(evidenceReferences), JSON.stringify(processCheckReferences),
            correlationId, operationId, CASE_WORKFLOW_VERSION],
        );

        const persistedProcessCheckIds = await persistTransitionProcessChecks(executor, {
          tenantId,
          caseId,
          toState,
          actorId,
          actorRole,
          correlationId,
          transitionEventId: eventId,
          processCheckReferences,
          evidenceReferences,
          noEvidenceReason: normalized.noEvidenceReason,
          reportReference: normalized.reportReference,
          reportDigest: normalized.reportDigest,
          completionReason: normalized.completionReason || reasonSummary,
          identityMatchReviewResult: normalized.identityMatchReviewResult,
          processCheckComplete: normalized.processCheckComplete,
        });

        if (outcomeId) {
          await executor.execute(
            `INSERT INTO case_outcomes (
               outcome_id, tenant_id, case_id, outcome_code, recorded_reasons,
               supporting_report_reference, evidence_set_reference, process_check_result,
               identity_match_review_result, decision_maker_id, decision_maker_role,
               correlation_id, workflow_version
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [outcomeId, tenantId, caseId, normalized.outcomeCode,
              JSON.stringify(normalized.recordedReasons),
              normalized.supportingReportReference || current.reportReference,
              normalized.evidenceSetReference,
              JSON.stringify({ complete: true, processCheckIds: persistedProcessCheckIds }),
              JSON.stringify(normalized.identityMatchReviewResult), actorId, actorRole,
              correlationId, CASE_WORKFLOW_VERSION],
          );
        }

        const assignments = [];
        const values = [toState, eventId];
        if (input?.assignedInvestigatorId !== undefined) {
          assignments.push("assigned_investigator_id = ?");
          values.push(normalized.assignedInvestigatorId);
        }
        if (toState === CASE_STATE.TRIAGE_PENDING && !current.triageOwnerId) {
          assignments.push("triage_owner_id = ?");
          values.push(actorId);
        }
        if (toState === CASE_STATE.INVESTIGATION_REPORT_COMPLETED) {
          assignments.push(
            "report_completing_investigator_id = ?",
            "report_reference = ?",
            "report_digest = ?",
            "report_completion_event_id = ?",
          );
          values.push(actorId, normalized.reportReference, normalized.reportDigest, eventId);
        }

        const [update] = await executor.execute(
          `UPDATE investigation_cases
              SET current_state = ?, state_version = state_version + 1,
                  last_transition_event_id = ?, ${assignments.length ? `${assignments.join(", ")},` : ""}
                  correlation_id = ?
            WHERE tenant_id = ? AND case_id = ?
              AND current_state = ? AND state_version = ?`,
          [...values, correlationId, tenantId, caseId, current.currentState, current.stateVersion],
        );
        if (update.affectedRows !== 1) {
          throw new CasePolicyError(
            "The case changed concurrently.",
            CASE_ERROR_CODE.STATE_VERSION_CONFLICT,
          );
        }

        const result = {
          case: await loadCase(executor, tenantId, caseId),
          transitionEventId: eventId,
          operationId,
          outcomeId,
          processCheckIds: persistedProcessCheckIds,
          correlationId,
          replayed: false,
        };
        await executor.execute(
          "UPDATE case_transition_operations SET result_payload = ? WHERE operation_id = ?",
          [JSON.stringify(result), operationId],
        );
        return result;
      });
    },
  };
}
