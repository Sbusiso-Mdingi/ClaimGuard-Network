import crypto from "node:crypto";

import { repositoryTenantId } from "./repository-context.js";
import {
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
    correlationId: row.correlation_id,
    lastTransitionEventId: row.last_transition_event_id || null,
    legacyInvestigationId: row.legacy_investigation_id || null,
    legacyStatus: row.legacy_status || null,
    migrationReviewStatus: row.migration_review_status || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function loadCaseByLegacy(executor, tenantId, legacyInvestigationId, forUpdate = false) {
  const [rows] = await executor.execute(
    `SELECT case_id, tenant_id, signal_id, claim_id, claim_version, current_state,
            state_version, assigned_investigator_id, triage_owner_id, correlation_id,
            last_transition_event_id, legacy_investigation_id, legacy_status,
            migration_review_status, created_at, updated_at
       FROM investigation_cases
      WHERE tenant_id = ? AND legacy_investigation_id = ?
      LIMIT 1${forUpdate ? " FOR UPDATE" : ""}`,
    [tenantId, legacyInvestigationId],
  );
  return mapCase(rows?.[0] || null);
}

async function withTransaction(pool, operation) {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const result = await operation(connection);
    await connection.commit();
    return result;
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

export function createLegacyCaseAdapter(
  pool,
  { dataPlaneContext = null, allowLegacyTenantContext = false } = {},
) {
  if (!pool || typeof pool.getConnection !== "function") {
    throw new TypeError("A mysql2 transaction-capable pool is required for legacy case migration.");
  }
  if (!dataPlaneContext && !allowLegacyTenantContext) repositoryTenantId(null);
  const canonicalTenantId = () => repositoryTenantId(dataPlaneContext, { allowLegacyTenantContext });

  return {
    async resolveLegacyInvestigationCase({
      legacyInvestigationId,
      actorId,
      actorRole,
      correlationId,
      migrationReason = "LEGACY_FIRST_ACCESS_REQUIRES_HUMAN_REVIEW",
    }) {
      const tenantId = canonicalTenantId();
      const investigationId = requiredString(legacyInvestigationId, "legacyInvestigationId", 64);
      const reviewerId = requiredString(actorId, "actorId");
      const requestId = requiredString(correlationId, "correlationId", 128);
      const reasonCode = requiredString(migrationReason, "migrationReason", 128);
      if (actorRole !== CASE_ROLE.SCHEME_ANALYST) {
        throw new CasePolicyError(
          "An authorised scheme analyst must initiate reviewed legacy case migration.",
          CASE_ERROR_CODE.ROLE_NOT_AUTHORISED,
        );
      }

      try {
        return await withTransaction(pool, async (executor) => {
          const existing = await loadCaseByLegacy(executor, tenantId, investigationId, true);
          if (existing) return { case: existing, replayed: true };

          const [legacyRows] = await executor.execute(
            `SELECT i.investigation_id, i.claim_id, i.status AS legacy_status,
                    c.current_claim_version
               FROM investigations i
               JOIN claims c
                 ON c.tenant_id = i.tenant_id AND c.claim_id = i.claim_id
              WHERE i.tenant_id = ? AND i.investigation_id = ?
              LIMIT 1 FOR UPDATE`,
            [tenantId, investigationId],
          );
          const legacy = legacyRows?.[0];
          if (!legacy) {
            throw new CasePolicyError(
              "The legacy investigation was not found in the active tenant.",
              CASE_ERROR_CODE.NOT_FOUND,
            );
          }

          const [signalRows] = await executor.execute(
            `SELECT signal_id, claim_id, claim_version
               FROM detection_signals
              WHERE tenant_id = ? AND claim_id = ? AND claim_version = ?
              LIMIT 2 FOR UPDATE`,
            [tenantId, legacy.claim_id, legacy.current_claim_version],
          );
          if (signalRows.length !== 1) {
            throw new CasePolicyError(
              "The legacy investigation cannot be linked to one authoritative immutable signal and requires manual migration review.",
              "LEGACY_CASE_SIGNAL_LINK_REQUIRED",
              409,
            );
          }
          const signal = signalRows[0];

          const [linkedRows] = await executor.execute(
            `SELECT case_id, legacy_investigation_id, current_state, state_version
               FROM investigation_cases
              WHERE tenant_id = ? AND signal_id = ?
              LIMIT 1 FOR UPDATE`,
            [tenantId, signal.signal_id],
          );
          const linked = linkedRows?.[0] || null;
          let caseId = linked?.case_id || crypto.randomUUID();

          if (linked?.legacy_investigation_id && linked.legacy_investigation_id !== investigationId) {
            throw new CasePolicyError(
              "The authoritative signal is already linked to another reviewed legacy investigation.",
              "LEGACY_CASE_SIGNAL_ALREADY_LINKED",
              409,
            );
          }

          if (!linked) {
            await executor.execute(
              `INSERT INTO investigation_cases (
                 case_id, tenant_id, signal_id, claim_id, claim_version,
                 current_state, state_version, triage_owner_id, originating_reason,
                 correlation_id, legacy_investigation_id, legacy_status,
                 migration_review_status
               ) VALUES (?, ?, ?, ?, ?, 'SIGNAL_GENERATED', 1, ?, ?, ?, ?, ?, 'REVIEW_REQUIRED')`,
              [caseId, tenantId, signal.signal_id, signal.claim_id, signal.claim_version,
                reviewerId, reasonCode, requestId, investigationId, legacy.legacy_status],
            );
          } else {
            await executor.execute(
              `UPDATE investigation_cases
                  SET legacy_investigation_id = ?, legacy_status = ?,
                      migration_review_status = 'REVIEW_REQUIRED',
                      triage_owner_id = COALESCE(triage_owner_id, ?),
                      originating_reason = COALESCE(originating_reason, ?),
                      correlation_id = ?
                WHERE tenant_id = ? AND case_id = ?`,
              [investigationId, legacy.legacy_status, reviewerId, reasonCode,
                requestId, tenantId, caseId],
            );
          }

          const currentState = linked?.current_state || CASE_STATE.SIGNAL_GENERATED;
          const currentVersion = Number(linked?.state_version || 1);
          if (currentState !== CASE_STATE.SIGNAL_GENERATED) {
            return {
              case: await loadCaseByLegacy(executor, tenantId, investigationId),
              replayed: true,
            };
          }

          const idempotencyKey = `legacy-first-access:${investigationId}`;
          const operationId = sha256(stableStringify({ tenantId, caseId, idempotencyKey }));
          const intentHash = sha256(stableStringify({
            tenantId,
            caseId,
            investigationId,
            legacyStatus: legacy.legacy_status,
            signalId: signal.signal_id,
            targetState: CASE_STATE.TRIAGE_PENDING,
          }));
          const eventId = crypto.randomUUID();
          const nextVersion = currentVersion + 1;

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
               reason_code, reason_summary, evidence_references,
               process_check_references, correlation_id, operation_id, workflow_version
             ) VALUES (?, ?, ?, 'SIGNAL_GENERATED', 'TRIAGE_PENDING', ?, ?, ?, ?, ?, ?, JSON_ARRAY(), JSON_ARRAY(), ?, ?, ?)`,
            [eventId, tenantId, caseId, currentVersion, nextVersion, reviewerId,
              actorRole, reasonCode,
              "Historical investigation linked for neutral human lifecycle review.",
              requestId, operationId, CASE_WORKFLOW_VERSION],
          );
          const [updated] = await executor.execute(
            `UPDATE investigation_cases
                SET current_state = 'TRIAGE_PENDING', state_version = state_version + 1,
                    last_transition_event_id = ?, correlation_id = ?
              WHERE tenant_id = ? AND case_id = ?
                AND current_state = 'SIGNAL_GENERATED' AND state_version = ?`,
            [eventId, requestId, tenantId, caseId, currentVersion],
          );
          if (updated.affectedRows !== 1) {
            throw new CasePolicyError(
              "The reviewed legacy migration changed concurrently.",
              CASE_ERROR_CODE.STATE_VERSION_CONFLICT,
            );
          }

          const result = {
            case: await loadCaseByLegacy(executor, tenantId, investigationId),
            transitionEventId: eventId,
            operationId,
            replayed: false,
          };
          await executor.execute(
            "UPDATE case_transition_operations SET result_payload = ? WHERE operation_id = ?",
            [JSON.stringify(result), operationId],
          );
          return result;
        });
      } catch (error) {
        if (error?.code === "ER_DUP_ENTRY" || error?.errno === 1062) {
          const existing = await loadCaseByLegacy(pool, tenantId, investigationId);
          if (existing) return { case: existing, replayed: true };
        }
        throw error;
      }
    },
  };
}
