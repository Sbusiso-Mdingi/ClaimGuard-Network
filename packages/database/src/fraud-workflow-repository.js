import crypto from "node:crypto";

import { appendLedgerEntry, LedgerConcurrencyConflictError } from "./ledger-chain.js";
import { stableStringify } from "./ledger-entry.js";

export const FRAUD_WORKFLOW_OPERATION = Object.freeze({
  CONFIRMATION: "FRAUD_CONFIRMATION",
  REVERSAL: "FRAUD_REVERSAL",
});

export const FRAUD_WORKFLOW_VERSION = 1;

const CONFIRMED_FRAUD_ENTRY_TYPE = "INVESTIGATOR_CONFIRMED_FRAUD";
const REVERSED_FRAUD_ENTRY_TYPE = "INVESTIGATOR_REVERSED_FRAUD";
const CONFIRMED_FRAUD_STATUS = "CONFIRMED_FRAUD";
const REVERSED_STATUS = "REVERSED";
const REGISTRY_OFFENCE_CATEGORY = "CONFIRMED_CLAIM_FRAUD";
const REGISTRY_SUBJECT_TYPE = "PROVIDER";

class FraudWorkflowError extends Error {
  constructor(message, { code, status }) {
    super(message);
    this.name = this.constructor.name;
    this.code = code;
    this.status = status;
  }
}

export class FraudWorkflowValidationError extends FraudWorkflowError {
  constructor(message, code = "fraud_workflow_validation_failed") {
    super(message, { code, status: 400 });
  }
}

export class FraudWorkflowNotFoundError extends FraudWorkflowError {
  constructor(message = "The investigation was not found in the active tenant.") {
    super(message, { code: "investigation_not_found", status: 404 });
  }
}

export class FraudWorkflowConflictError extends FraudWorkflowError {
  constructor(message, code = "fraud_workflow_conflict") {
    super(message, { code, status: 409 });
  }
}

export class FraudWorkflowIdempotencyConflictError extends FraudWorkflowConflictError {
  constructor(message = "The idempotency key has already been used for a different fraud-workflow intent.") {
    super(message, "fraud_workflow_idempotency_mismatch");
  }
}

function requirePool(pool) {
  if (!pool || typeof pool.getConnection !== "function") {
    throw new Error("A mysql2 pool with transaction support is required for fraud workflows.");
  }
}

function normalizeRequiredString(value, fieldName, maxLength) {
  if (typeof value !== "string" || !value.trim()) {
    throw new FraudWorkflowValidationError(`${fieldName} is required.`, `missing_${fieldName}`);
  }

  const normalized = value.trim();
  if (normalized.length > maxLength) {
    throw new FraudWorkflowValidationError(
      `${fieldName} must be at most ${maxLength} characters.`,
      `invalid_${fieldName}`,
    );
  }
  return normalized;
}

function normalizeOptionalString(value, fieldName, maxLength) {
  if (value === null || value === undefined || value === "") {
    return null;
  }
  return normalizeRequiredString(value, fieldName, maxLength);
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function createOperationId({ tenantId, operationType, investigationId, idempotencyKey }) {
  return sha256(stableStringify({ tenantId, operationType, investigationId, idempotencyKey }));
}

function createIntentHash(intent) {
  return sha256(stableStringify(intent));
}

function parseJson(value) {
  if (typeof value === "string") {
    return JSON.parse(value);
  }
  return value;
}

function mapRegistryEntry({
  registryEntryId,
  ledgerHash,
  investigationId,
  tenantId,
  medicalScheme,
  fraudSubjectType,
  subjectToken,
  offenceCategory,
  findingDate,
  investigatorReference,
  publicationTimestamp,
  status,
  reversesRegistryEntryId,
}) {
  return {
    registryEntryId,
    ledgerHash,
    investigationId,
    tenantId,
    medicalScheme,
    fraudSubjectType,
    subjectToken,
    offenceCategory,
    findingDate,
    investigatorReference,
    publicationTimestamp,
    status,
    reversesRegistryEntryId,
  };
}

async function loadLockedInvestigation(connection, tenantId, investigationId) {
  const [rows] = await connection.execute(
    `
      SELECT investigation_id, tenant_id, claim_id, status, fraud_confirmed_at,
        confirmation_operation_id, reversal_operation_id, reversed_at
      FROM investigations
      WHERE investigation_id = ? AND tenant_id = ?
      LIMIT 1
      FOR UPDATE
    `,
    [investigationId, tenantId],
  );
  return rows?.[0] ?? null;
}

async function resolveIdempotency(
  connection,
  { tenantId, operationType, investigationId, idempotencyKey, intentHash },
) {
  const [rows] = await connection.execute(
    `
      SELECT investigation_id, idempotency_key, intent_hash, result_payload
      FROM fraud_workflow_operations
      WHERE tenant_id = ? AND operation_type = ?
        AND (investigation_id = ? OR idempotency_key = ?)
      FOR UPDATE
    `,
    [tenantId, operationType, investigationId, idempotencyKey],
  );

  if (!rows?.length) {
    return null;
  }

  const exactReplay = rows.find(
    (row) =>
      row.investigation_id === investigationId &&
      row.idempotency_key === idempotencyKey &&
      row.intent_hash === intentHash,
  );
  if (exactReplay && rows.length === 1) {
    return { ...parseJson(exactReplay.result_payload), replayed: true };
  }

  throw new FraudWorkflowIdempotencyConflictError();
}

async function saveOperation(
  connection,
  {
    operationId,
    tenantId,
    operationType,
    investigationId,
    idempotencyKey,
    intentHash,
    actorId,
    actorRole,
    correlationId,
    ledgerEntryId,
    registryEntryId,
    result,
  },
) {
  await connection.execute(
    `
      INSERT INTO fraud_workflow_operations (
        operation_id, tenant_id, operation_type, investigation_id, idempotency_key,
        intent_hash, actor_id, actor_role, correlation_id, ledger_entry_id,
        registry_entry_id, result_payload, workflow_version
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
    [
      operationId,
      tenantId,
      operationType,
      investigationId,
      idempotencyKey,
      intentHash,
      actorId,
      actorRole,
      correlationId,
      ledgerEntryId,
      registryEntryId,
      JSON.stringify(result),
      FRAUD_WORKFLOW_VERSION,
    ],
  );
}

async function inTransaction(pool, operation) {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const result = await operation(connection);
    await connection.commit();
    return result;
  } catch (error) {
    await connection.rollback();
    if (error?.code === "ER_DUP_ENTRY" || error?.errno === 1062) {
      throw new FraudWorkflowConflictError(
        "This fraud workflow was completed concurrently. Retry with the same idempotency key.",
        "fraud_workflow_concurrency_conflict",
      );
    }
    throw error;
  } finally {
    connection.release();
  }
}

function normalizeWorkflowInput(input, operationType) {
  const tenantId = normalizeRequiredString(input?.tenantId, "tenantId", 64);
  const investigationId = normalizeRequiredString(input?.investigationId, "investigationId", 64);
  const reason = normalizeRequiredString(input?.reason, "reason", 1024);
  const actorId = normalizeRequiredString(input?.actorId, "actorId", 255);
  const actorRole = normalizeRequiredString(input?.actorRole, "actorRole", 64);
  const correlationId = normalizeRequiredString(input?.correlationId, "correlationId", 128);
  const requestedClaimId = normalizeOptionalString(input?.requestedClaimId, "claimId", 32);
  const idempotencyKey = normalizeOptionalString(input?.idempotencyKey, "idempotencyKey", 128)
    ?? `${operationType}:${investigationId}`;
  const intent = {
    tenantId,
    operationType,
    investigationId,
    requestedClaimId,
    reason,
    actorId,
    actorRole,
  };

  return {
    tenantId,
    investigationId,
    reason,
    actorId,
    actorRole,
    correlationId,
    requestedClaimId,
    idempotencyKey,
    intentHash: createIntentHash(intent),
    operationId: createOperationId({ tenantId, operationType, investigationId, idempotencyKey }),
  };
}

export function createFraudWorkflowRepository(pool) {
  requirePool(pool);

  return {
    async confirmFraud(input) {
      const operationType = FRAUD_WORKFLOW_OPERATION.CONFIRMATION;
      const normalized = normalizeWorkflowInput(input, operationType);

      return inTransaction(pool, async (connection) => {
        const investigation = await loadLockedInvestigation(
          connection,
          normalized.tenantId,
          normalized.investigationId,
        );
        if (!investigation) {
          throw new FraudWorkflowNotFoundError();
        }

        const replay = await resolveIdempotency(connection, {
          ...normalized,
          operationType,
        });
        if (replay) {
          return replay;
        }

        if (investigation.status !== CONFIRMED_FRAUD_STATUS || investigation.fraud_confirmed_at) {
          throw new FraudWorkflowConflictError(
            investigation.fraud_confirmed_at
              ? "This investigation has already published a fraud decision."
              : "Investigation status must be CONFIRMED_FRAUD before fraud can be confirmed.",
            investigation.fraud_confirmed_at
              ? "fraud_already_confirmed"
              : "invalid_confirmation_lifecycle",
          );
        }
        if (normalized.requestedClaimId && normalized.requestedClaimId !== investigation.claim_id) {
          throw new FraudWorkflowValidationError(
            "claimId must match the investigation claim.",
            "investigation_claim_mismatch",
          );
        }

        const [authoritativeRows] = await connection.execute(
          `
            SELECT c.claim_id, c.provider_id, c.scheme_id,
              COALESCE(ms.scheme_name, s.scheme_name) AS medical_scheme,
              COUNT(e.evidence_id) AS evidence_count
            FROM claims c
            JOIN schemes s ON s.scheme_id = c.scheme_id AND s.tenant_id = c.tenant_id
            LEFT JOIN medical_schemes ms
              ON ms.scheme_id = c.scheme_id AND ms.tenant_id = c.tenant_id
            LEFT JOIN investigation_evidence e
              ON e.investigation_id = ? AND e.tenant_id = c.tenant_id
            WHERE c.claim_id = ? AND c.tenant_id = ?
            GROUP BY c.claim_id, c.provider_id, c.scheme_id, ms.scheme_name, s.scheme_name
            LIMIT 1
          `,
          [normalized.investigationId, investigation.claim_id, normalized.tenantId],
        );
        const authoritative = authoritativeRows?.[0];
        if (!authoritative?.provider_id || !authoritative?.medical_scheme) {
          throw new FraudWorkflowValidationError(
            "The investigation claim does not have authoritative provider and medical-scheme data.",
            "authoritative_registry_data_missing",
          );
        }
        if (Number(authoritative.evidence_count) < 1) {
          throw new FraudWorkflowConflictError(
            "At least one persisted evidence record is required before fraud confirmation.",
            "confirmation_evidence_required",
          );
        }

        const decisionTime = new Date();
        const decisionTimestamp = decisionTime.toISOString();
        const findingDate = decisionTimestamp.slice(0, 10);
        const subjectToken = sha256(`provider:${authoritative.provider_id}`);
        const ledgerEntry = await appendLedgerEntry(connection, {
          tenantId: normalized.tenantId,
          entryType: CONFIRMED_FRAUD_ENTRY_TYPE,
          payload: {
            investigationId: normalized.investigationId,
            claimId: investigation.claim_id,
            schemeId: authoritative.scheme_id,
            reason: normalized.reason,
            actor: {
              id: normalized.actorId,
              role: normalized.actorRole,
              tenantId: normalized.tenantId,
            },
            correlationId: normalized.correlationId,
            decisionTimestamp,
            registryPublication: {
              required: true,
              reason: "AUTHORITATIVE_PROVIDER_FINDING",
            },
            workflowVersion: FRAUD_WORKFLOW_VERSION,
          },
          operationId: normalized.operationId,
          operationType,
          investigationId: normalized.investigationId,
          actorId: normalized.actorId,
          actorRole: normalized.actorRole,
          correlationId: normalized.correlationId,
          workflowVersion: FRAUD_WORKFLOW_VERSION,
        });

        const [updateResult] = await connection.execute(
          `
            UPDATE investigations
            SET fraud_confirmed_at = ?, confirmation_operation_id = ?,
              confirmation_intent_hash = ?, confirmation_ledger_entry_id = ?,
              confirmed_by = ?, confirmed_by_role = ?, confirmation_correlation_id = ?,
              registry_publication_required = 1,
              registry_publication_reason = 'AUTHORITATIVE_PROVIDER_FINDING',
              workflow_version = ?
            WHERE investigation_id = ? AND tenant_id = ?
              AND status = 'CONFIRMED_FRAUD' AND fraud_confirmed_at IS NULL
          `,
          [
            decisionTime,
            normalized.operationId,
            normalized.intentHash,
            ledgerEntry.id,
            normalized.actorId,
            normalized.actorRole,
            normalized.correlationId,
            FRAUD_WORKFLOW_VERSION,
            normalized.investigationId,
            normalized.tenantId,
          ],
        );
        if (updateResult.affectedRows !== 1) {
          throw new FraudWorkflowConflictError(
            "The investigation lifecycle changed during fraud confirmation.",
            "confirmation_lifecycle_conflict",
          );
        }

        const registryEntryId = crypto.randomUUID();
        await connection.execute(
          `
            INSERT INTO shared_fraud_registry_entries (
              registry_entry_id, ledger_hash, investigation_id, tenant_id, medical_scheme,
              fraud_subject_type, subject_token, offence_category, finding_date,
              investigator_reference, status, reverses_registry_entry_id,
              confirmation_operation_id, reversal_operation_id
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ACTIVE', NULL, ?, NULL)
          `,
          [
            registryEntryId,
            ledgerEntry.entryHash,
            normalized.investigationId,
            normalized.tenantId,
            authoritative.medical_scheme,
            REGISTRY_SUBJECT_TYPE,
            subjectToken,
            REGISTRY_OFFENCE_CATEGORY,
            findingDate,
            normalized.actorId,
            normalized.operationId,
          ],
        );

        const registryEntry = mapRegistryEntry({
          registryEntryId,
          ledgerHash: ledgerEntry.entryHash,
          investigationId: normalized.investigationId,
          tenantId: normalized.tenantId,
          medicalScheme: authoritative.medical_scheme,
          fraudSubjectType: REGISTRY_SUBJECT_TYPE,
          subjectToken,
          offenceCategory: REGISTRY_OFFENCE_CATEGORY,
          findingDate,
          investigatorReference: normalized.actorId,
          publicationTimestamp: decisionTimestamp,
          status: "ACTIVE",
          reversesRegistryEntryId: null,
        });
        const result = { entry: ledgerEntry, registryEntry, replayed: false };

        await saveOperation(connection, {
          ...normalized,
          operationType,
          ledgerEntryId: ledgerEntry.id,
          registryEntryId,
          result,
        });
        return result;
      });
    },

    async reverseFraud(input) {
      const operationType = FRAUD_WORKFLOW_OPERATION.REVERSAL;
      const normalized = normalizeWorkflowInput(input, operationType);

      return inTransaction(pool, async (connection) => {
        const investigation = await loadLockedInvestigation(
          connection,
          normalized.tenantId,
          normalized.investigationId,
        );
        if (!investigation) {
          throw new FraudWorkflowNotFoundError();
        }

        const replay = await resolveIdempotency(connection, {
          ...normalized,
          operationType,
        });
        if (replay) {
          return replay;
        }

        if (investigation.status !== CONFIRMED_FRAUD_STATUS || !investigation.fraud_confirmed_at) {
          throw new FraudWorkflowConflictError(
            investigation.status === REVERSED_STATUS || investigation.reversed_at
              ? "This investigation fraud decision has already been reversed."
              : "A completed fraud confirmation is required before reversal.",
            investigation.status === REVERSED_STATUS || investigation.reversed_at
              ? "fraud_already_reversed"
              : "invalid_reversal_lifecycle",
          );
        }
        if (normalized.requestedClaimId && normalized.requestedClaimId !== investigation.claim_id) {
          throw new FraudWorkflowValidationError(
            "claimId must match the investigation claim.",
            "investigation_claim_mismatch",
          );
        }

        const [registryRows] = await connection.execute(
          `
            SELECT active.registry_entry_id, active.ledger_hash, active.medical_scheme,
              active.fraud_subject_type, active.subject_token, active.offence_category,
              active.finding_date
            FROM shared_fraud_registry_entries active
            WHERE active.investigation_id = ? AND active.tenant_id = ?
              AND active.status = 'ACTIVE'
              AND NOT EXISTS (
                SELECT 1 FROM shared_fraud_registry_entries reversal
                WHERE reversal.reverses_registry_entry_id = active.registry_entry_id
              )
            LIMIT 1
            FOR UPDATE
          `,
          [normalized.investigationId, normalized.tenantId],
        );
        const originalRegistry = registryRows?.[0];
        if (!originalRegistry) {
          throw new FraudWorkflowConflictError(
            "No active registry finding exists for this investigation.",
            "active_registry_finding_not_found",
          );
        }

        const [originalLedgerRows] = await connection.execute(
          `
            SELECT id, entry_hash
            FROM ledger_entries
            WHERE entry_hash = ? AND tenant_id = ? AND investigation_id = ?
            LIMIT 1
            FOR UPDATE
          `,
          [originalRegistry.ledger_hash, normalized.tenantId, normalized.investigationId],
        );
        const originalLedger = originalLedgerRows?.[0];
        if (!originalLedger) {
          throw new FraudWorkflowConflictError(
            "The active registry finding is not linked to an authoritative tenant ledger entry.",
            "registry_ledger_link_missing",
          );
        }

        const reversalTime = new Date();
        const reversalTimestamp = reversalTime.toISOString();
        const ledgerEntry = await appendLedgerEntry(connection, {
          tenantId: normalized.tenantId,
          entryType: REVERSED_FRAUD_ENTRY_TYPE,
          payload: {
            investigationId: normalized.investigationId,
            claimId: investigation.claim_id,
            reason: normalized.reason,
            actor: {
              id: normalized.actorId,
              role: normalized.actorRole,
              tenantId: normalized.tenantId,
            },
            correlationId: normalized.correlationId,
            originalLedgerEntryId: Number(originalLedger.id),
            originalLedgerHash: originalLedger.entry_hash,
            originalRegistryEntryId: originalRegistry.registry_entry_id,
            reversalTimestamp,
            workflowVersion: FRAUD_WORKFLOW_VERSION,
          },
          operationId: normalized.operationId,
          operationType,
          investigationId: normalized.investigationId,
          reversedLedgerEntryId: Number(originalLedger.id),
          actorId: normalized.actorId,
          actorRole: normalized.actorRole,
          correlationId: normalized.correlationId,
          workflowVersion: FRAUD_WORKFLOW_VERSION,
        });

        const registryEntryId = crypto.randomUUID();
        await connection.execute(
          `
            INSERT INTO shared_fraud_registry_entries (
              registry_entry_id, ledger_hash, investigation_id, tenant_id, medical_scheme,
              fraud_subject_type, subject_token, offence_category, finding_date,
              investigator_reference, status, reverses_registry_entry_id,
              confirmation_operation_id, reversal_operation_id
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'REVERSED', ?, NULL, ?)
          `,
          [
            registryEntryId,
            ledgerEntry.entryHash,
            normalized.investigationId,
            normalized.tenantId,
            originalRegistry.medical_scheme,
            originalRegistry.fraud_subject_type,
            originalRegistry.subject_token,
            originalRegistry.offence_category,
            originalRegistry.finding_date,
            normalized.actorId,
            originalRegistry.registry_entry_id,
            normalized.operationId,
          ],
        );

        const [updateResult] = await connection.execute(
          `
            UPDATE investigations
            SET status = 'REVERSED', reversal_operation_id = ?, reversal_intent_hash = ?,
              reversal_ledger_entry_id = ?, reversal_reason = ?, reversed_by = ?,
              reversed_by_role = ?, reversed_at = ?, reversal_correlation_id = ?,
              workflow_version = ?
            WHERE investigation_id = ? AND tenant_id = ?
              AND status = 'CONFIRMED_FRAUD' AND fraud_confirmed_at IS NOT NULL
              AND reversed_at IS NULL
          `,
          [
            normalized.operationId,
            normalized.intentHash,
            ledgerEntry.id,
            normalized.reason,
            normalized.actorId,
            normalized.actorRole,
            reversalTime,
            normalized.correlationId,
            FRAUD_WORKFLOW_VERSION,
            normalized.investigationId,
            normalized.tenantId,
          ],
        );
        if (updateResult.affectedRows !== 1) {
          throw new FraudWorkflowConflictError(
            "The investigation lifecycle changed during fraud reversal.",
            "reversal_lifecycle_conflict",
          );
        }

        const registryEntry = mapRegistryEntry({
          registryEntryId,
          ledgerHash: ledgerEntry.entryHash,
          investigationId: normalized.investigationId,
          tenantId: normalized.tenantId,
          medicalScheme: originalRegistry.medical_scheme,
          fraudSubjectType: originalRegistry.fraud_subject_type,
          subjectToken: originalRegistry.subject_token,
          offenceCategory: originalRegistry.offence_category,
          findingDate: originalRegistry.finding_date,
          investigatorReference: normalized.actorId,
          publicationTimestamp: reversalTimestamp,
          status: "REVERSED",
          reversesRegistryEntryId: originalRegistry.registry_entry_id,
        });
        const result = { entry: ledgerEntry, registryEntry, replayed: false };

        await saveOperation(connection, {
          ...normalized,
          operationType,
          ledgerEntryId: ledgerEntry.id,
          registryEntryId,
          result,
        });
        return result;
      });
    },
  };
}

export { LedgerConcurrencyConflictError };
