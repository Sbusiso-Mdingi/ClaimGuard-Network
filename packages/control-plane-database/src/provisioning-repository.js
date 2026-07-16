import crypto from "node:crypto";

import { ControlPlaneConflictError } from "./errors.js";
import { executorOr } from "./transaction.js";
import { PROVISIONING_STATUSES, requireEnum, safeErrorSummary } from "./validation.js";

export function createProvisioningRepository(defaultExecutor) {
  return {
    async createOperation(input, { executor } = {}) {
      const operationId = input.operationId || crypto.randomUUID();
      await executorOr(defaultExecutor, executor).execute(
        `INSERT INTO organisation_provisioning_operations
          (operation_id, organisation_id, operation_type, status, requested_by, correlation_id)
         VALUES (?, ?, ?, 'pending', ?, ?)`,
        [operationId, input.organisationId, input.operationType, input.requestedBy, input.correlationId || null],
      );
      return this.getOperation(operationId, { executor });
    },

    async getOperation(operationId, { executor } = {}) {
      const [rows] = await executorOr(defaultExecutor, executor).execute(
        "SELECT * FROM organisation_provisioning_operations WHERE operation_id = ? LIMIT 1",
        [operationId],
      );
      const row = rows?.[0];
      return row ? {
        operationId: row.operation_id,
        organisationId: row.organisation_id,
        operationType: row.operation_type,
        status: row.status,
        requestedBy: row.requested_by,
        correlationId: row.correlation_id || null,
        startedAt: row.started_at || null,
        completedAt: row.completed_at || null,
        safeErrorSummary: row.safe_error_summary || null,
      } : null;
    },

    async listOperations({ organisationId = null, statuses = [], limit = 100, executor } = {}) {
      const db = executorOr(defaultExecutor, executor);
      const safeLimit = Math.max(1, Math.min(500, Number.parseInt(limit, 10) || 100));
      const clauses = [];
      const params = [];

      if (organisationId) {
        clauses.push("organisation_id = ?");
        params.push(organisationId);
      }

      if (Array.isArray(statuses) && statuses.length > 0) {
        const placeholders = statuses.map(() => "?").join(", ");
        clauses.push(`status IN (${placeholders})`);
        params.push(...statuses.map((value) => requireEnum(value, PROVISIONING_STATUSES, "provisioning_status")));
      }

      const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
      const [rows] = await db.execute(
        `SELECT * FROM organisation_provisioning_operations ${where}
         ORDER BY created_at DESC
         LIMIT ${safeLimit}`,
        params,
      );

      return (rows || []).map((row) => ({
        operationId: row.operation_id,
        organisationId: row.organisation_id,
        operationType: row.operation_type,
        status: row.status,
        requestedBy: row.requested_by,
        correlationId: row.correlation_id || null,
        startedAt: row.started_at || null,
        completedAt: row.completed_at || null,
        safeErrorSummary: row.safe_error_summary || null,
      }));
    },

    async transitionOperation(operationId, fromStatuses, toStatus, { error = null, executor } = {}) {
      requireEnum(toStatus, PROVISIONING_STATUSES, "provisioning_status");
      const db = executorOr(defaultExecutor, executor);
      const safeError = error ? safeErrorSummary(error).summary : null;
      const placeholders = fromStatuses.map(() => "?").join(", ");
      const [result] = await db.execute(
        `UPDATE organisation_provisioning_operations
         SET status = ?,
           started_at = CASE WHEN ? = 'running' THEN COALESCE(started_at, UTC_TIMESTAMP(3)) ELSE started_at END,
           completed_at = CASE WHEN ? IN ('completed', 'compensated') THEN UTC_TIMESTAMP(3) ELSE completed_at END,
           safe_error_summary = ?
         WHERE operation_id = ? AND status IN (${placeholders})`,
        [toStatus, toStatus, toStatus, safeError, operationId, ...fromStatuses],
      );
      if (result.affectedRows !== 1) {
        throw new ControlPlaneConflictError("Provisioning operation is not in an allowed source state.", "INVALID_PROVISIONING_TRANSITION");
      }
      return this.getOperation(operationId, { executor: db });
    },

    async completeStep({ operationId, stepKey, externalResourceReference = null }, { executor } = {}) {
      const db = executorOr(defaultExecutor, executor);
      await db.execute(
        `INSERT INTO provisioning_steps
          (operation_id, step_key, status, attempt_count, external_resource_reference, started_at, completed_at)
         VALUES (?, ?, 'completed', 1, ?, UTC_TIMESTAMP(3), UTC_TIMESTAMP(3))
         ON DUPLICATE KEY UPDATE
          status = IF(status = 'completed', status, 'completed'),
          attempt_count = IF(status = 'completed', attempt_count, attempt_count + 1),
          external_resource_reference = COALESCE(external_resource_reference, VALUES(external_resource_reference)),
          completed_at = COALESCE(completed_at, UTC_TIMESTAMP(3))`,
        [operationId, stepKey, externalResourceReference],
      );
      return { operationId, stepKey, status: "completed" };
    },

    async startStep({ operationId, stepKey, externalResourceReference = null }, { executor } = {}) {
      const db = executorOr(defaultExecutor, executor);
      await db.execute(
        `INSERT INTO provisioning_steps
          (operation_id, step_key, status, attempt_count, external_resource_reference, started_at)
         VALUES (?, ?, 'running', 1, ?, UTC_TIMESTAMP(3))
         ON DUPLICATE KEY UPDATE
          status = IF(status = 'completed', status, 'running'),
          attempt_count = IF(status = 'completed', attempt_count, attempt_count + 1),
          external_resource_reference = COALESCE(external_resource_reference, VALUES(external_resource_reference)),
          started_at = IF(status = 'completed', started_at, UTC_TIMESTAMP(3)),
          completed_at = IF(status = 'completed', completed_at, NULL),
          error_type = IF(status = 'completed', error_type, NULL),
          safe_error_summary = IF(status = 'completed', safe_error_summary, NULL)`,
        [operationId, stepKey, externalResourceReference],
      );
      return { operationId, stepKey, status: "running" };
    },

    async failStep({ operationId, stepKey, error }, { executor } = {}) {
      const safe = safeErrorSummary(error);
      await executorOr(defaultExecutor, executor).execute(
        `INSERT INTO provisioning_steps
          (operation_id, step_key, status, attempt_count, started_at, completed_at, error_type, safe_error_summary)
         VALUES (?, ?, 'failed', 1, UTC_TIMESTAMP(3), UTC_TIMESTAMP(3), ?, ?)
         ON DUPLICATE KEY UPDATE status = 'failed', attempt_count = attempt_count + 1,
          completed_at = UTC_TIMESTAMP(3), error_type = VALUES(error_type), safe_error_summary = VALUES(safe_error_summary)`,
        [operationId, stepKey, safe.type, safe.summary],
      );
      return { operationId, stepKey, status: "failed", errorType: safe.type };
    },

    async listSteps(operationId, { executor } = {}) {
      const [rows] = await executorOr(defaultExecutor, executor).execute(
        `SELECT * FROM provisioning_steps WHERE operation_id = ? ORDER BY updated_at ASC, step_key ASC`,
        [operationId],
      );
      return (rows || []).map((row) => ({
        operationId: row.operation_id,
        stepKey: row.step_key,
        status: row.status,
        attemptCount: Number(row.attempt_count || 0),
        externalResourceReference: row.external_resource_reference || null,
        startedAt: row.started_at || null,
        completedAt: row.completed_at || null,
        errorType: row.error_type || null,
        safeErrorSummary: row.safe_error_summary || null,
        compensationStatus: row.compensation_status,
      }));
    },
  };
}
