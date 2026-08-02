import crypto from "node:crypto";

import { repositoryTenantId } from "./repository-context.js";

export const INVESTIGATION_STATUS = Object.freeze({
  OPEN: "OPEN",
  UNDER_REVIEW: "UNDER_REVIEW",
  AWAITING_EVIDENCE: "AWAITING_EVIDENCE",
  CONFIRMED_FRAUD: "CONFIRMED_FRAUD",
  REVERSED: "REVERSED",
  NO_FRAUD_FOUND: "NO_FRAUD_FOUND",
  CLOSED: "CLOSED",
});

export const INVESTIGATION_PRIORITY = Object.freeze({
  LOW: "LOW",
  NORMAL: "NORMAL",
  HIGH: "HIGH",
  CRITICAL: "CRITICAL",
});

export const INVESTIGATION_NOTE_TYPE = Object.freeze({
  EVIDENCE: "EVIDENCE",
  INTERVIEW: "INTERVIEW",
  MEDICAL_REVIEW: "MEDICAL_REVIEW",
  PROVIDER_REVIEW: "PROVIDER_REVIEW",
  INTERNAL_NOTE: "INTERNAL_NOTE",
});

const allowedStatusTransitions = Object.freeze({
  [INVESTIGATION_STATUS.OPEN]: Object.freeze([
    INVESTIGATION_STATUS.UNDER_REVIEW,
    INVESTIGATION_STATUS.AWAITING_EVIDENCE,
    INVESTIGATION_STATUS.CLOSED,
  ]),
  [INVESTIGATION_STATUS.UNDER_REVIEW]: Object.freeze([
    INVESTIGATION_STATUS.AWAITING_EVIDENCE,
    INVESTIGATION_STATUS.CONFIRMED_FRAUD,
    INVESTIGATION_STATUS.NO_FRAUD_FOUND,
    INVESTIGATION_STATUS.CLOSED,
  ]),
  [INVESTIGATION_STATUS.AWAITING_EVIDENCE]: Object.freeze([
    INVESTIGATION_STATUS.UNDER_REVIEW,
    INVESTIGATION_STATUS.CLOSED,
  ]),
  [INVESTIGATION_STATUS.CONFIRMED_FRAUD]: Object.freeze([INVESTIGATION_STATUS.CLOSED]),
  [INVESTIGATION_STATUS.REVERSED]: Object.freeze([INVESTIGATION_STATUS.CLOSED]),
  [INVESTIGATION_STATUS.NO_FRAUD_FOUND]: Object.freeze([INVESTIGATION_STATUS.CLOSED]),
  [INVESTIGATION_STATUS.CLOSED]: Object.freeze([]),
});

export class InvestigationValidationError extends Error {
  constructor(message, code = "investigation_validation_failed") {
    super(message);
    this.name = "InvestigationValidationError";
    this.code = code;
  }
}

export class InvestigationNotFoundError extends Error {
  constructor(message = "The investigation was not found in the active tenant.") {
    super(message);
    this.name = "InvestigationNotFoundError";
    this.code = "investigation_not_found";
  }
}

export class InvestigationConflictError extends Error {
  constructor(message, code = "investigation_conflict") {
    super(message);
    this.name = "InvestigationConflictError";
    this.code = code;
  }
}

function normalizeEnumValue(value, allowedValues, fieldName) {
  if (typeof value !== "string") {
    throw new InvestigationValidationError(`${fieldName} must be a non-empty string.`);
  }

  const normalized = value.trim().toUpperCase().replace(/[\s-]+/g, "_");
  if (!Object.values(allowedValues).includes(normalized)) {
    throw new InvestigationValidationError(`Unsupported ${fieldName}: ${value}.`, `invalid_${fieldName}`);
  }

  return normalized;
}

function normalizeRequiredString(value, fieldName, maxLength = null) {
  if (typeof value !== "string" || !value.trim()) {
    throw new InvestigationValidationError(`${fieldName} is required.`);
  }

  const normalized = value.trim();
  if (maxLength && normalized.length > maxLength) {
    throw new InvestigationValidationError(`${fieldName} must be at most ${maxLength} characters.`);
  }

  return normalized;
}

function normalizeOptionalString(value, fieldName, maxLength = null) {
  if (value === null || value === undefined || value === "") {
    return null;
  }

  return normalizeRequiredString(value, fieldName, maxLength);
}

function normalizeEvidenceType(value) {
  return normalizeRequiredString(value, "evidenceType", 64).toUpperCase().replace(/[\s-]+/g, "_");
}

function mapInvestigation(row) {
  if (!row) {
    return null;
  }

  return {
    investigationId: row.investigation_id,
    tenantId: row.tenant_id,
    claimId: row.claim_id,
    assignedInvestigator: row.assigned_investigator,
    assignedBy: row.assigned_by,
    status: row.status,
    priority: row.priority,
    recordVersion: Number(row.record_version || 1),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    closedAt: row.closed_at,
    fraudConfirmedAt: row.fraud_confirmed_at,
    reversedAt: row.reversed_at ?? null,
  };
}

function mapNote(row) {
  return {
    noteId: row.note_id,
    investigationId: row.investigation_id,
    tenantId: row.tenant_id,
    author: row.author,
    text: row.note_text,
    noteType: row.note_type,
    timestamp: row.created_at,
  };
}

function mapEvidence(row) {
  return {
    evidenceId: row.evidence_id,
    investigationId: row.investigation_id,
    tenantId: row.tenant_id,
    filename: row.filename,
    description: row.description,
    uploadedBy: row.uploaded_by,
    uploadedAt: row.uploaded_at,
    evidenceType: row.evidence_type,
    contentType: row.content_type ?? null,
    byteSize: row.byte_size == null ? null : Number(row.byte_size),
    contentSha256: row.content_sha256 ?? null,
  };
}

function mapActivity(row) {
  const parse = (value) => {
    if (value == null || typeof value === "object") return value;
    try { return JSON.parse(value); } catch { return null; }
  };
  return {
    activityEventId: row.activity_event_id,
    investigationId: row.investigation_id,
    actorId: row.actor_id,
    action: row.action,
    before: parse(row.before_summary),
    after: parse(row.after_summary),
    correlationId: row.correlation_id || null,
    occurredAt: row.occurred_at,
  };
}

function requirePool(pool) {
  if (!pool || typeof pool.execute !== "function") {
    throw new Error("A mysql2 pool with execute support is required for investigation repository.");
  }
}

async function withTransaction(pool, operation) {
  if (typeof pool.getConnection !== "function") return operation(pool);
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

async function loadInvestigation(executor, tenantId, investigationId, { forUpdate = false } = {}) {
  const [rows] = await executor.execute(
    `SELECT investigation_id, tenant_id, claim_id, assigned_investigator, assigned_by,
            status, priority, record_version, created_at, updated_at, closed_at,
            fraud_confirmed_at, reversed_at
     FROM investigations
     WHERE investigation_id = ? AND tenant_id = ?
     LIMIT 1${forUpdate ? " FOR UPDATE" : ""}`,
    [investigationId, tenantId],
  );
  return mapInvestigation(rows?.[0] || null);
}

async function recordActivity(executor, {
  tenantId, investigationId, actorId, action, before = null, after = null,
  correlationId = null,
}) {
  const activityEventId = crypto.randomUUID();
  await executor.execute(
    `INSERT INTO investigation_activity_events
       (activity_event_id, tenant_id, investigation_id, actor_id, action,
        before_summary, after_summary, correlation_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [activityEventId, tenantId, investigationId, actorId, action,
      before == null ? null : JSON.stringify(before), after == null ? null : JSON.stringify(after),
      correlationId],
  );
  return activityEventId;
}

function requireExpectedVersion(value, noun = "investigation") {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new InvestigationValidationError(
      `A current ${noun} record version is required.`,
      noun === "claim" ? "claim_version_required" : "record_version_required",
    );
  }
  return parsed;
}

function assertCurrentVersion(investigation, expectedRecordVersion) {
  const expected = requireExpectedVersion(expectedRecordVersion);
  if (investigation.recordVersion !== expected) {
    throw new InvestigationConflictError(
      "The investigation changed after it was loaded. Refresh and retry the update.",
      "stale_record_version",
    );
  }
  return expected;
}

export function normalizeInvestigationStatus(status) {
  return normalizeEnumValue(status, INVESTIGATION_STATUS, "status");
}

export function normalizeInvestigationPriority(priority) {
  return normalizeEnumValue(priority, INVESTIGATION_PRIORITY, "priority");
}

export function normalizeInvestigationNoteType(noteType) {
  return normalizeEnumValue(noteType, INVESTIGATION_NOTE_TYPE, "noteType");
}

export function canTransitionInvestigationStatus(currentStatus, nextStatus) {
  const normalizedCurrent = normalizeInvestigationStatus(currentStatus);
  const normalizedNext = normalizeInvestigationStatus(nextStatus);
  return allowedStatusTransitions[normalizedCurrent].includes(normalizedNext);
}

export function assertInvestigationStatusTransition(currentStatus, nextStatus) {
  if (!canTransitionInvestigationStatus(currentStatus, nextStatus)) {
    throw new InvestigationValidationError(
      `Investigation status cannot transition from ${currentStatus} to ${nextStatus}.`,
      "invalid_status_transition",
    );
  }
}

export function isFraudConfirmationPermitted(investigation) {
  return Boolean(
    investigation &&
      investigation.status === INVESTIGATION_STATUS.CONFIRMED_FRAUD &&
      !investigation.fraudConfirmedAt,
  );
}

export function createInvestigationRepository(pool, { dataPlaneContext = null, allowLegacyTenantContext = false } = {}) {
  requirePool(pool);
  if (!dataPlaneContext && !allowLegacyTenantContext) repositoryTenantId(null);
  const canonicalTenantId = () => repositoryTenantId(dataPlaneContext, { allowLegacyTenantContext });

  return {
    async createInvestigation({
      claimId,
      assignedInvestigator = null,
      assignedBy,
      priority = INVESTIGATION_PRIORITY.NORMAL,
      expectedClaimVersion,
      correlationId = null,
    }) {
      const tenantId = canonicalTenantId();
      const normalizedClaimId = normalizeRequiredString(claimId, "claimId", 128);
      const normalizedAssignedBy = normalizeRequiredString(assignedBy, "assignedBy", 255);
      const normalizedAssignedInvestigator = normalizeOptionalString(
        assignedInvestigator,
        "assignedInvestigator",
        255,
      );
      const normalizedPriority = normalizeInvestigationPriority(priority);
      const claimVersion = requireExpectedVersion(expectedClaimVersion, "claim");

      return withTransaction(pool, async (executor) => {
        const [claimRows] = await executor.execute(
          "SELECT claim_id, current_claim_version FROM claims WHERE claim_id = ? AND tenant_id = ? LIMIT 1 FOR UPDATE",
          [normalizedClaimId, tenantId],
        );
        if (!claimRows?.[0]) {
          throw new InvestigationNotFoundError("The claim was not found in the active tenant.");
        }
        if (Number(claimRows[0].current_claim_version) !== claimVersion) {
          throw new InvestigationConflictError(
            "The claim changed after it was loaded. Refresh and retry investigation creation.",
            "stale_claim_version",
          );
        }

        const investigationId = crypto.randomUUID();
        try {
          await executor.execute(
            `INSERT INTO investigations
               (investigation_id, tenant_id, claim_id, assigned_investigator, assigned_by,
                status, priority, record_version)
             VALUES (?, ?, ?, ?, ?, ?, ?, 1)`,
            [investigationId, tenantId, normalizedClaimId, normalizedAssignedInvestigator,
              normalizedAssignedBy, INVESTIGATION_STATUS.OPEN, normalizedPriority],
          );
        } catch (error) {
          if (error?.code === "ER_DUP_ENTRY") {
            throw new InvestigationConflictError(
              "This claim already has an investigation.",
              "investigation_already_exists",
            );
          }
          throw error;
        }
        await recordActivity(executor, {
          tenantId,
          investigationId,
          actorId: normalizedAssignedBy,
          action: "investigation.created",
          after: {
            claimId: normalizedClaimId,
            assignedInvestigator: normalizedAssignedInvestigator,
            priority: normalizedPriority,
            claimVersion,
            recordVersion: 1,
          },
          correlationId,
        });
        return loadInvestigation(executor, tenantId, investigationId);
      });
    },

    async getInvestigationById(investigationId) {
      const tenantId = canonicalTenantId();
      const normalizedInvestigationId = normalizeRequiredString(investigationId, "investigationId", 64);
      return loadInvestigation(pool, tenantId, normalizedInvestigationId);
    },

    async getInvestigationDetails(investigationId) {
      const investigation = await this.getInvestigationById(investigationId);
      if (!investigation) {
        return null;
      }

      const [noteRows, evidenceRows, activityRows] = await Promise.all([
        pool.execute(
          `
            SELECT note_id, investigation_id, tenant_id, author, note_text, note_type, created_at
            FROM investigation_notes
            WHERE investigation_id = ? AND tenant_id = ?
            ORDER BY created_at ASC
          `,
          [investigation.investigationId, investigation.tenantId],
        ),
        pool.execute(
          `
            SELECT evidence_id, investigation_id, tenant_id, filename, description,
              uploaded_by, uploaded_at, evidence_type, content_type, byte_size,
              content_sha256, storage_object_key
            FROM investigation_evidence
            WHERE investigation_id = ? AND tenant_id = ?
            ORDER BY uploaded_at ASC
          `,
          [investigation.investigationId, investigation.tenantId],
        ),
        pool.execute(
          `SELECT activity_event_id, investigation_id, actor_id, action,
                  before_summary, after_summary, correlation_id, occurred_at
           FROM investigation_activity_events
           WHERE investigation_id = ? AND tenant_id = ?
           ORDER BY occurred_at ASC, activity_event_id ASC`,
          [investigation.investigationId, investigation.tenantId],
        ),
      ]);

      return {
        ...investigation,
        notes: (noteRows[0] || []).map(mapNote),
        evidence: (evidenceRows[0] || []).map(mapEvidence),
        activity: (activityRows[0] || []).map(mapActivity),
      };
    },

    async updateInvestigation({
      investigationId,
      status = undefined,
      priority = undefined,
      assignedInvestigator = undefined,
      expectedRecordVersion,
      actorId,
      correlationId = null,
    }) {
      const tenantId = canonicalTenantId();
      const normalizedInvestigationId = normalizeRequiredString(investigationId, "investigationId", 64);
      const normalizedActorId = normalizeRequiredString(actorId, "actorId", 255);
      if (status === undefined && priority === undefined && assignedInvestigator === undefined) {
        throw new InvestigationValidationError("status, priority, or assignedInvestigator must be provided.");
      }

      return withTransaction(pool, async (executor) => {
        const investigation = await loadInvestigation(executor, tenantId, normalizedInvestigationId, { forUpdate: true });
        if (!investigation) throw new InvestigationNotFoundError();
        const expected = assertCurrentVersion(investigation, expectedRecordVersion);
        const nextStatus = status === undefined ? investigation.status : normalizeInvestigationStatus(status);
        const nextPriority = priority === undefined ? investigation.priority : normalizeInvestigationPriority(priority);
        const nextAssignedInvestigator = assignedInvestigator === undefined
          ? investigation.assignedInvestigator
          : normalizeOptionalString(assignedInvestigator, "assignedInvestigator", 255);
        if (status !== undefined && nextStatus !== investigation.status) {
          assertInvestigationStatusTransition(investigation.status, nextStatus);
        }
        const [result] = await executor.execute(
          `UPDATE investigations
           SET status = ?, priority = ?, assigned_investigator = ?,
               record_version = record_version + 1,
               closed_at = CASE WHEN ? = 'CLOSED' THEN COALESCE(closed_at, CURRENT_TIMESTAMP(3)) ELSE closed_at END
           WHERE investigation_id = ? AND tenant_id = ? AND record_version = ?`,
          [nextStatus, nextPriority, nextAssignedInvestigator, nextStatus,
            normalizedInvestigationId, tenantId, expected],
        );
        if (Number(result.affectedRows || 0) !== 1) {
          throw new InvestigationConflictError(
            "The investigation changed after it was loaded. Refresh and retry the update.",
            "stale_record_version",
          );
        }
        const changes = {};
        if (nextStatus !== investigation.status) changes.status = { from: investigation.status, to: nextStatus };
        if (nextPriority !== investigation.priority) changes.priority = { from: investigation.priority, to: nextPriority };
        if (nextAssignedInvestigator !== investigation.assignedInvestigator) {
          changes.assignedInvestigator = { from: investigation.assignedInvestigator, to: nextAssignedInvestigator };
        }
        await recordActivity(executor, {
          tenantId,
          investigationId: normalizedInvestigationId,
          actorId: normalizedActorId,
          action: Object.hasOwn(changes, "assignedInvestigator") ? "investigation.assignment_changed" : "investigation.updated",
          before: { recordVersion: expected },
          after: { recordVersion: expected + 1, changes },
          correlationId,
        });
        return loadInvestigation(executor, tenantId, normalizedInvestigationId);
      });
    },

    async addNote({
      investigationId,
      author,
      text,
      noteType = INVESTIGATION_NOTE_TYPE.INTERNAL_NOTE,
      expectedRecordVersion,
      correlationId = null,
    }) {
      const tenantId = canonicalTenantId();
      const normalizedInvestigationId = normalizeRequiredString(investigationId, "investigationId", 64);
      const normalizedAuthor = normalizeRequiredString(author, "author", 255);
      const normalizedText = normalizeRequiredString(text, "text");
      const normalizedNoteType = normalizeInvestigationNoteType(noteType);
      if (normalizedText.length > 20_000) {
        throw new InvestigationValidationError("text must be at most 20000 characters.");
      }

      return withTransaction(pool, async (executor) => {
        const investigation = await loadInvestigation(executor, tenantId, normalizedInvestigationId, { forUpdate: true });
        if (!investigation) throw new InvestigationNotFoundError();
        const expected = assertCurrentVersion(investigation, expectedRecordVersion);
        const noteId = crypto.randomUUID();
        await executor.execute(
          `INSERT INTO investigation_notes
             (note_id, investigation_id, tenant_id, author, note_text, note_type)
           VALUES (?, ?, ?, ?, ?, ?)`,
          [noteId, normalizedInvestigationId, tenantId, normalizedAuthor, normalizedText, normalizedNoteType],
        );
        const [updated] = await executor.execute(
          `UPDATE investigations SET record_version = record_version + 1
           WHERE investigation_id = ? AND tenant_id = ? AND record_version = ?`,
          [normalizedInvestigationId, tenantId, expected],
        );
        if (Number(updated.affectedRows || 0) !== 1) {
          throw new InvestigationConflictError("The investigation changed after it was loaded.", "stale_record_version");
        }
        await recordActivity(executor, {
          tenantId,
          investigationId: normalizedInvestigationId,
          actorId: normalizedAuthor,
          action: "investigation.note_added",
          after: { noteId, noteType: normalizedNoteType, recordVersion: expected + 1 },
          correlationId,
        });
        const current = await loadInvestigation(executor, tenantId, normalizedInvestigationId);
        return {
          note: {
            noteId,
            investigationId: normalizedInvestigationId,
            tenantId,
            author: normalizedAuthor,
            text: normalizedText,
            noteType: normalizedNoteType,
            timestamp: new Date().toISOString(),
          },
          investigation: current,
        };
      });
    },

    async registerEvidence({
      evidenceId,
      investigationId,
      filename,
      description = null,
      uploadedBy,
      evidenceType,
      contentType,
      byteSize,
      contentSha256,
      storageObjectKey,
      expectedRecordVersion,
      correlationId = null,
    }) {
      const tenantId = canonicalTenantId();
      const normalizedEvidenceId = normalizeRequiredString(evidenceId, "evidenceId", 64);
      const normalizedInvestigationId = normalizeRequiredString(investigationId, "investigationId", 64);
      const normalizedFilename = normalizeRequiredString(filename, "filename", 512);
      const normalizedDescription = normalizeOptionalString(description, "description");
      const normalizedUploadedBy = normalizeRequiredString(uploadedBy, "uploadedBy", 255);
      const normalizedEvidenceType = normalizeEvidenceType(evidenceType);
      const normalizedContentType = normalizeRequiredString(contentType, "contentType", 128);
      const normalizedByteSize = Number(byteSize);
      const normalizedHash = normalizeRequiredString(contentSha256, "contentSha256", 64);
      const normalizedObjectKey = normalizeRequiredString(storageObjectKey, "storageObjectKey", 1024);
      if (!Number.isInteger(normalizedByteSize) || normalizedByteSize < 1 || normalizedByteSize > 10 * 1024 * 1024
        || !/^[0-9a-f]{64}$/.test(normalizedHash)) {
        throw new InvestigationValidationError("The persisted evidence metadata is invalid.");
      }

      return withTransaction(pool, async (executor) => {
        const investigation = await loadInvestigation(executor, tenantId, normalizedInvestigationId, { forUpdate: true });
        if (!investigation) throw new InvestigationNotFoundError();
        const expected = assertCurrentVersion(investigation, expectedRecordVersion);
        await executor.execute(
          `INSERT INTO investigation_evidence
             (evidence_id, investigation_id, tenant_id, filename, description, uploaded_by,
              evidence_type, content_type, byte_size, content_sha256, storage_object_key)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [normalizedEvidenceId, normalizedInvestigationId, tenantId, normalizedFilename,
            normalizedDescription, normalizedUploadedBy, normalizedEvidenceType, normalizedContentType,
            normalizedByteSize, normalizedHash, normalizedObjectKey],
        );
        const [updated] = await executor.execute(
          `UPDATE investigations SET record_version = record_version + 1
           WHERE investigation_id = ? AND tenant_id = ? AND record_version = ?`,
          [normalizedInvestigationId, tenantId, expected],
        );
        if (Number(updated.affectedRows || 0) !== 1) {
          throw new InvestigationConflictError("The investigation changed after it was loaded.", "stale_record_version");
        }
        await recordActivity(executor, {
          tenantId,
          investigationId: normalizedInvestigationId,
          actorId: normalizedUploadedBy,
          action: "investigation.evidence_uploaded",
          after: {
            evidenceId: normalizedEvidenceId,
            evidenceType: normalizedEvidenceType,
            contentType: normalizedContentType,
            byteSize: normalizedByteSize,
            contentSha256: normalizedHash,
            recordVersion: expected + 1,
          },
          correlationId,
        });
        const current = await loadInvestigation(executor, tenantId, normalizedInvestigationId);
        return {
          evidence: {
            evidenceId: normalizedEvidenceId,
            investigationId: normalizedInvestigationId,
            tenantId,
            filename: normalizedFilename,
            description: normalizedDescription,
            uploadedBy: normalizedUploadedBy,
            uploadedAt: new Date().toISOString(),
            evidenceType: normalizedEvidenceType,
            contentType: normalizedContentType,
            byteSize: normalizedByteSize,
            contentSha256: normalizedHash,
          },
          investigation: current,
        };
      });
    },

    async markFraudPublished(investigationId) {
      const investigation = await this.getInvestigationById(investigationId);
      if (!investigation) {
        throw new InvestigationNotFoundError();
      }

      if (investigation.status !== INVESTIGATION_STATUS.CONFIRMED_FRAUD) {
        throw new InvestigationConflictError(
          "Only investigations with CONFIRMED_FRAUD status may publish a fraud decision.",
          "confirmation_status_not_permitted",
        );
      }

      if (investigation.fraudConfirmedAt) {
        throw new InvestigationConflictError(
          "This investigation has already published a fraud decision.",
          "fraud_already_confirmed",
        );
      }

      const [result] = await pool.execute(
        `
          UPDATE investigations
          SET fraud_confirmed_at = CURRENT_TIMESTAMP(3)
          WHERE investigation_id = ? AND tenant_id = ? AND fraud_confirmed_at IS NULL
        `,
        [investigation.investigationId, investigation.tenantId],
      );

      if (result?.affectedRows !== 1) {
        throw new InvestigationConflictError(
          "This investigation has already published a fraud decision.",
          "fraud_already_confirmed",
        );
      }

      return true;
    },
  };
}
