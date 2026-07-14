import crypto from "node:crypto";

import { getActiveTenantId } from "./tenant-context-store.js";

export const INVESTIGATION_STATUS = Object.freeze({
  OPEN: "OPEN",
  UNDER_REVIEW: "UNDER_REVIEW",
  AWAITING_EVIDENCE: "AWAITING_EVIDENCE",
  CONFIRMED_FRAUD: "CONFIRMED_FRAUD",
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
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    closedAt: row.closed_at,
    fraudConfirmedAt: row.fraud_confirmed_at,
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
  };
}

function requirePool(pool) {
  if (!pool || typeof pool.execute !== "function") {
    throw new Error("A mysql2 pool with execute support is required for investigation repository.");
  }
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

export function createInvestigationRepository(pool) {
  requirePool(pool);

  return {
    async createInvestigation({ claimId, assignedInvestigator = null, assignedBy, priority = INVESTIGATION_PRIORITY.NORMAL }) {
      const tenantId = getActiveTenantId();
      const normalizedClaimId = normalizeRequiredString(claimId, "claimId", 32);
      const normalizedAssignedBy = normalizeRequiredString(assignedBy, "assignedBy", 255);
      const normalizedAssignedInvestigator = normalizeOptionalString(
        assignedInvestigator,
        "assignedInvestigator",
        255,
      );
      const normalizedPriority = normalizeInvestigationPriority(priority);

      const [claimRows] = await pool.execute(
        "SELECT claim_id FROM claims WHERE claim_id = ? AND tenant_id = ? LIMIT 1",
        [normalizedClaimId, tenantId],
      );

      if (!claimRows?.[0]) {
        throw new InvestigationNotFoundError("The claim was not found in the active tenant.");
      }

      const investigationId = crypto.randomUUID();
      const now = new Date().toISOString();
      await pool.execute(
        `
          INSERT INTO investigations (
            investigation_id, tenant_id, claim_id, assigned_investigator, assigned_by, status, priority
          ) VALUES (?, ?, ?, ?, ?, ?, ?)
        `,
        [
          investigationId,
          tenantId,
          normalizedClaimId,
          normalizedAssignedInvestigator,
          normalizedAssignedBy,
          INVESTIGATION_STATUS.OPEN,
          normalizedPriority,
        ],
      );

      return {
        investigationId,
        tenantId,
        claimId: normalizedClaimId,
        assignedInvestigator: normalizedAssignedInvestigator,
        assignedBy: normalizedAssignedBy,
        status: INVESTIGATION_STATUS.OPEN,
        priority: normalizedPriority,
        createdAt: now,
        updatedAt: now,
        closedAt: null,
        fraudConfirmedAt: null,
      };
    },

    async getInvestigationById(investigationId) {
      const tenantId = getActiveTenantId();
      const normalizedInvestigationId = normalizeRequiredString(investigationId, "investigationId", 64);
      const [rows] = await pool.execute(
        `
          SELECT
            investigation_id, tenant_id, claim_id, assigned_investigator, assigned_by,
            status, priority, created_at, updated_at, closed_at, fraud_confirmed_at
          FROM investigations
          WHERE investigation_id = ? AND tenant_id = ?
          LIMIT 1
        `,
        [normalizedInvestigationId, tenantId],
      );

      return mapInvestigation(rows?.[0] ?? null);
    },

    async getInvestigationDetails(investigationId) {
      const investigation = await this.getInvestigationById(investigationId);
      if (!investigation) {
        return null;
      }

      const [noteRows, evidenceRows] = await Promise.all([
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
              uploaded_by, uploaded_at, evidence_type
            FROM investigation_evidence
            WHERE investigation_id = ? AND tenant_id = ?
            ORDER BY uploaded_at ASC
          `,
          [investigation.investigationId, investigation.tenantId],
        ),
      ]);

      return {
        ...investigation,
        notes: (noteRows[0] || []).map(mapNote),
        evidence: (evidenceRows[0] || []).map(mapEvidence),
      };
    },

    async updateInvestigation({ investigationId, status = undefined, priority = undefined }) {
      const investigation = await this.getInvestigationById(investigationId);
      if (!investigation) {
        throw new InvestigationNotFoundError();
      }

      if (status === undefined && priority === undefined) {
        throw new InvestigationValidationError("status or priority must be provided.");
      }

      const nextStatus = status === undefined ? investigation.status : normalizeInvestigationStatus(status);
      const nextPriority = priority === undefined ? investigation.priority : normalizeInvestigationPriority(priority);

      if (status !== undefined) {
        assertInvestigationStatusTransition(investigation.status, nextStatus);
      }

      await pool.execute(
        `
          UPDATE investigations
          SET
            status = ?,
            priority = ?,
            closed_at = CASE
              WHEN ? = 'CLOSED' THEN COALESCE(closed_at, CURRENT_TIMESTAMP(3))
              ELSE closed_at
            END
          WHERE investigation_id = ? AND tenant_id = ?
        `,
        [nextStatus, nextPriority, nextStatus, investigation.investigationId, investigation.tenantId],
      );

      const now = new Date().toISOString();
      return {
        ...investigation,
        status: nextStatus,
        priority: nextPriority,
        updatedAt: now,
        closedAt:
          nextStatus === INVESTIGATION_STATUS.CLOSED
            ? investigation.closedAt || now
            : investigation.closedAt,
      };
    },

    async addNote({ investigationId, author, text, noteType = INVESTIGATION_NOTE_TYPE.INTERNAL_NOTE }) {
      const normalizedInvestigationId = normalizeRequiredString(investigationId, "investigationId", 64);
      const normalizedAuthor = normalizeRequiredString(author, "author", 255);
      const normalizedText = normalizeRequiredString(text, "text");
      const normalizedNoteType = normalizeInvestigationNoteType(noteType);
      const investigation = await this.getInvestigationById(normalizedInvestigationId);

      if (!investigation) {
        throw new InvestigationNotFoundError();
      }

      const noteId = crypto.randomUUID();
      const timestamp = new Date().toISOString();

      await pool.execute(
        `
          INSERT INTO investigation_notes (
            note_id, investigation_id, tenant_id, author, note_text, note_type
          ) VALUES (?, ?, ?, ?, ?, ?)
        `,
        [
          noteId,
          normalizedInvestigationId,
          investigation.tenantId,
          normalizedAuthor,
          normalizedText,
          normalizedNoteType,
        ],
      );

      return {
        noteId,
        investigationId: normalizedInvestigationId,
        tenantId: investigation.tenantId,
        author: normalizedAuthor,
        text: normalizedText,
        noteType: normalizedNoteType,
        timestamp,
      };
    },

    async registerEvidence({ investigationId, filename, description = null, uploadedBy, evidenceType }) {
      const normalizedInvestigationId = normalizeRequiredString(investigationId, "investigationId", 64);
      const normalizedFilename = normalizeRequiredString(filename, "filename", 512);
      const normalizedDescription = normalizeOptionalString(description, "description");
      const normalizedUploadedBy = normalizeRequiredString(uploadedBy, "uploadedBy", 255);
      const normalizedEvidenceType = normalizeEvidenceType(evidenceType);
      const investigation = await this.getInvestigationById(normalizedInvestigationId);

      if (!investigation) {
        throw new InvestigationNotFoundError();
      }

      const evidenceId = crypto.randomUUID();
      const uploadedAt = new Date().toISOString();

      await pool.execute(
        `
          INSERT INTO investigation_evidence (
            evidence_id, investigation_id, tenant_id, filename, description, uploaded_by, evidence_type
          ) VALUES (?, ?, ?, ?, ?, ?, ?)
        `,
        [
          evidenceId,
          normalizedInvestigationId,
          investigation.tenantId,
          normalizedFilename,
          normalizedDescription,
          normalizedUploadedBy,
          normalizedEvidenceType,
        ],
      );

      return {
        evidenceId,
        investigationId: normalizedInvestigationId,
        tenantId: investigation.tenantId,
        filename: normalizedFilename,
        description: normalizedDescription,
        uploadedBy: normalizedUploadedBy,
        uploadedAt,
        evidenceType: normalizedEvidenceType,
      };
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
