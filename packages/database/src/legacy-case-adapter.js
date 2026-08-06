import crypto from "node:crypto";

import { repositoryTenantId } from "./repository-context.js";
import {
  canonicalCasePermissions,
  CASE_ERROR_CODE,
  CASE_PERMISSION,
  CASE_PERMISSION_POLICY_VERSION,
  CASE_STATE,
  CASE_WORKFLOW_VERSION,
  CasePolicyError,
} from "./case-transition-policy.js";
import { stableStringify } from "./ledger-entry.js";

const LEGACY_FIRST_ACCESS_MAX_ATTEMPTS = 3;
const RETRYABLE_DATABASE_CODES = new Set(["ER_LOCK_DEADLOCK", "ER_LOCK_WAIT_TIMEOUT"]);
const RETRYABLE_DATABASE_ERRNOS = new Set([1205, 1213]);

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

function normalizeActorContext(value, tenantId) {
  const actorId = requiredString(value?.actorId, "actorContext.actorId");
  const actorTenantId = requiredString(value?.tenantId, "actorContext.tenantId", 64);
  if (actorTenantId !== tenantId) {
    throw new CasePolicyError("The legacy investigation was not found in the active tenant.", CASE_ERROR_CODE.NOT_FOUND);
  }
  const permissions = canonicalCasePermissions(value?.permissions);
  if (!permissions.includes(CASE_PERMISSION.TRIAGE)
      || Number(value?.permissionPolicyVersion) !== CASE_PERMISSION_POLICY_VERSION) {
    throw new CasePolicyError(
      "The authenticated actor lacks permission to initiate reviewed legacy case migration.",
      CASE_ERROR_CODE.ROLE_NOT_AUTHORISED,
    );
  }
  const roles = Object.freeze([...new Set(
    (Array.isArray(value?.roles) ? value.roles : [])
      .filter((role) => typeof role === "string" && role.trim() && role.trim().length <= 64)
      .map((role) => role.trim()),
  )].sort());
  return Object.freeze({ actorId, tenantId, permissions, roles, permissionPolicyVersion: CASE_PERMISSION_POLICY_VERSION });
}

function auditRole(actorContext) {
  return actorContext.roles[0] || "permission_authorised_actor";
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

function isDuplicateKeyError(error) {
  return error?.code === "ER_DUP_ENTRY" || Number(error?.errno) === 1062;
}

function isRetryableTransactionError(error) {
  return RETRYABLE_DATABASE_CODES.has(error?.code)
    || RETRYABLE_DATABASE_ERRNOS.has(Number(error?.errno))
    || error?.sqlState === "40001";
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

async function loadLegacyInvestigation(executor, tenantId, investigationId, forUpdate = false) {
  const [rows] = await executor.execute(
    `SELECT i.investigation_id, i.claim_id, i.status AS legacy_status,
            c.current_claim_version
       FROM investigations i
       JOIN claims c
         ON c.tenant_id = i.tenant_id AND c.claim_id = i.claim_id
      WHERE i.tenant_id = ? AND i.investigation_id = ?
      LIMIT 1${forUpdate ? " FOR UPDATE" : ""}`,
    [tenantId, investigationId],
  );
  return rows?.[0] || null;
}

async function loadCanonicalSignal(executor, tenantId, claimId, claimVersion, forUpdate = false) {
  const [rows] = await executor.execute(
    `SELECT signal_id, claim_id, claim_version
       FROM detection_signals
      WHERE tenant_id = ? AND claim_id = ? AND claim_version = ?
      LIMIT 2${forUpdate ? " FOR UPDATE" : ""}`,
    [tenantId, claimId, claimVersion],
  );
  if (rows.length !== 1) {
    throw new CasePolicyError(
      "The legacy investigation cannot be linked to one authoritative immutable signal and requires manual migration review.",
      "LEGACY_CASE_SIGNAL_LINK_REQUIRED",
      409,
    );
  }
  return rows[0];
}

async function countRows(executor, sql, values) {
  const [rows] = await executor.execute(sql, values);
  return Number(rows?.[0]?.total || 0);
}

function incompleteReplayError() {
  return new CasePolicyError(
    "The canonical legacy case migration is incomplete or inconsistent and requires manual review.",
    "LEGACY_CASE_MIGRATION_INCOMPLETE",
    409,
  );
}

async function resolveCompleteReplay(executor, { tenantId, investigationId, forUpdate = false }) {
  const existing = await loadCaseByLegacy(executor, tenantId, investigationId, forUpdate);
  if (!existing) return null;

  const legacy = await loadLegacyInvestigation(executor, tenantId, investigationId, forUpdate);
  if (!legacy) throw incompleteReplayError();
  const signal = await loadCanonicalSignal(
    executor,
    tenantId,
    legacy.claim_id,
    Number(legacy.current_claim_version),
    forUpdate,
  );

  if (existing.tenantId !== tenantId
      || existing.legacyInvestigationId !== investigationId
      || existing.claimId !== legacy.claim_id
      || existing.claimVersion !== Number(legacy.current_claim_version)
      || existing.signalId !== signal.signal_id
      || existing.legacyStatus !== legacy.legacy_status
      || existing.currentState !== CASE_STATE.TRIAGE_PENDING
      || existing.stateVersion !== 2
      || existing.migrationReviewStatus !== "REVIEW_REQUIRED"
      || !existing.lastTransitionEventId) {
    throw incompleteReplayError();
  }

  const [neutralTransitions, migrationChecks, outcomes, operations] = await Promise.all([
    countRows(
      executor,
      `SELECT COUNT(*) AS total
         FROM case_transition_events
        WHERE tenant_id = ? AND case_id = ?
          AND previous_state = 'SIGNAL_GENERATED'
          AND new_state = 'TRIAGE_PENDING'
          AND event_id = ?`,
      [tenantId, existing.caseId, existing.lastTransitionEventId],
    ),
    countRows(
      executor,
      `SELECT COUNT(*) AS total
         FROM case_process_checks
        WHERE tenant_id = ? AND case_id = ?
          AND check_code = 'LEGACY_MIGRATION_AUTHORIZATION'
          AND transition_event_id = ?`,
      [tenantId, existing.caseId, existing.lastTransitionEventId],
    ),
    countRows(
      executor,
      "SELECT COUNT(*) AS total FROM case_outcomes WHERE tenant_id = ? AND case_id = ?",
      [tenantId, existing.caseId],
    ),
    countRows(
      executor,
      `SELECT COUNT(*) AS total
         FROM case_transition_operations
        WHERE tenant_id = ? AND case_id = ? AND idempotency_key = ?
          AND JSON_LENGTH(result_payload) > 0`,
      [tenantId, existing.caseId, `legacy-first-access:${investigationId}`],
    ),
  ]);

  if (neutralTransitions !== 1 || migrationChecks !== 1 || outcomes !== 0 || operations !== 1) {
    throw incompleteReplayError();
  }
  return { case: existing, replayed: true };
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
      actorContext: suppliedActorContext,
      correlationId,
      migrationReason = "LEGACY_FIRST_ACCESS_REQUIRES_HUMAN_REVIEW",
    }) {
      const tenantId = canonicalTenantId();
      const investigationId = requiredString(legacyInvestigationId, "legacyInvestigationId", 64);
      const actorContext = normalizeActorContext(suppliedActorContext, tenantId);
      const reviewerId = actorContext.actorId;
      const reviewerRole = auditRole(actorContext);
      const requestId = requiredString(correlationId, "correlationId", 128);
      const reasonCode = requiredString(migrationReason, "migrationReason", 128);

      for (let attempt = 1; attempt <= LEGACY_FIRST_ACCESS_MAX_ATTEMPTS; attempt += 1) {
        try {
          return await withTransaction(pool, async (executor) => {
            const replay = await resolveCompleteReplay(executor, {
              tenantId,
              investigationId,
              forUpdate: true,
            });
            if (replay) return replay;

            const legacy = await loadLegacyInvestigation(executor, tenantId, investigationId, true);
            if (!legacy) {
              throw new CasePolicyError("The legacy investigation was not found in the active tenant.", CASE_ERROR_CODE.NOT_FOUND);
            }

            const signal = await loadCanonicalSignal(
              executor,
              tenantId,
              legacy.claim_id,
              Number(legacy.current_claim_version),
              true,
            );
            const [linkedRows] = await executor.execute(
              `SELECT case_id, legacy_investigation_id, current_state, state_version
                 FROM investigation_cases
                WHERE tenant_id = ? AND signal_id = ?
                LIMIT 1 FOR UPDATE`,
              [tenantId, signal.signal_id],
            );
            const linked = linkedRows?.[0] || null;
            const caseId = linked?.case_id || crypto.randomUUID();
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
                [investigationId, legacy.legacy_status, reviewerId, reasonCode, requestId, tenantId, caseId],
              );
            }

            const currentState = linked?.current_state || CASE_STATE.SIGNAL_GENERATED;
            const currentVersion = Number(linked?.state_version || 1);
            if (currentState !== CASE_STATE.SIGNAL_GENERATED) {
              return resolveCompleteReplay(executor, { tenantId, investigationId, forUpdate: true });
            }

            const idempotencyKey = `legacy-first-access:${investigationId}`;
            const operationId = sha256(stableStringify({ tenantId, caseId, idempotencyKey }));
            const intentHash = sha256(stableStringify({
              tenantId,
              caseId,
              investigationId,
              legacyStatus: legacy.legacy_status,
              signalId: signal.signal_id,
              action: "legacy-first-access-review",
              actorId: reviewerId,
              roles: actorContext.roles,
              permissions: actorContext.permissions,
              permissionPolicyVersion: actorContext.permissionPolicyVersion,
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
                reviewerRole, reasonCode,
                "Historical investigation linked for neutral human lifecycle review.",
                requestId, operationId, CASE_WORKFLOW_VERSION],
            );
            await executor.execute(
              `INSERT INTO case_process_checks (
                 process_check_id, tenant_id, case_id, check_code, check_result,
                 recorded_by, recorded_by_role, correlation_id, transition_event_id
               ) VALUES (?, ?, ?, 'LEGACY_MIGRATION_AUTHORIZATION', ?, ?, ?, ?, ?)`,
              [crypto.randomUUID(), tenantId, caseId, JSON.stringify({
                action: "legacy-first-access-review",
                legacyStatus: legacy.legacy_status,
                roles: actorContext.roles,
                permissions: actorContext.permissions,
                permissionPolicyVersion: actorContext.permissionPolicyVersion,
                ignoredAsOutcomeAuthority: true,
              }), reviewerId, reviewerRole, requestId, eventId],
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
              throw new CasePolicyError("The reviewed legacy migration changed concurrently.", CASE_ERROR_CODE.STATE_VERSION_CONFLICT);
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
          if (isDuplicateKeyError(error)) {
            const replay = await withTransaction(pool, (executor) => resolveCompleteReplay(executor, {
              tenantId,
              investigationId,
              forUpdate: true,
            }));
            if (replay) return replay;
            throw incompleteReplayError();
          }
          if (!isRetryableTransactionError(error)) throw error;
          if (attempt === LEGACY_FIRST_ACCESS_MAX_ATTEMPTS) {
            throw new CasePolicyError(
              "The reviewed legacy migration changed concurrently. Refresh and retry.",
              CASE_ERROR_CODE.STATE_VERSION_CONFLICT,
            );
          }
        }
      }

      throw new CasePolicyError(
        "The reviewed legacy migration changed concurrently. Refresh and retry.",
        CASE_ERROR_CODE.STATE_VERSION_CONFLICT,
      );
    },
  };
}
