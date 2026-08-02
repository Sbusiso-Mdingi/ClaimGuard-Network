import crypto from "node:crypto";

import { validateEvidenceUpload } from "../investigation-evidence-storage.js";

export function createInvestigationService({ investigationRepository = null, evidenceStorage = null } = {}) {
  function hasMethod(name) {
    return Boolean(investigationRepository && typeof investigationRepository[name] === "function");
  }

  return {
    hasMethod,

    async listInvestigations(filters = {}) {
      return investigationRepository.listInvestigations(filters);
    },

    async createInvestigation({
      claimId, assignedInvestigator = null, assignedBy, priority, expectedClaimVersion, correlationId = null,
    }) {
      return investigationRepository.createInvestigation({
        claimId,
        assignedInvestigator,
        assignedBy,
        priority,
        expectedClaimVersion,
        correlationId,
      });
    },

    async getInvestigationById(investigationId) {
      return investigationRepository.getInvestigationById(investigationId);
    },

    async getInvestigationDetails(investigationId) {
      return investigationRepository.getInvestigationDetails(investigationId);
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
      return investigationRepository.updateInvestigation({
        investigationId,
        status,
        priority,
        assignedInvestigator,
        expectedRecordVersion,
        actorId,
        correlationId,
      });
    },

    async addNote({ investigationId, author, text, noteType, expectedRecordVersion, correlationId = null }) {
      return investigationRepository.addNote({
        investigationId,
        author,
        text,
        noteType,
        expectedRecordVersion,
        correlationId,
      });
    },

    async uploadEvidence({
      tenantId,
      investigationId,
      filename,
      description,
      uploadedBy,
      evidenceType,
      contentType,
      contentBase64,
      expectedRecordVersion,
      correlationId = null,
    }) {
      if (!evidenceStorage?.store || !evidenceStorage?.delete) {
        const error = new Error("Secure evidence storage is not configured.");
        error.code = "EVIDENCE_STORAGE_UNAVAILABLE";
        error.status = 503;
        throw error;
      }
      const validated = validateEvidenceUpload({ filename, contentType, contentBase64 });
      const evidenceId = crypto.randomUUID();
      const stored = await evidenceStorage.store({
        tenantId,
        investigationId,
        evidenceId,
        ...validated,
      });
      try {
        return await investigationRepository.registerEvidence({
          evidenceId,
          investigationId,
          filename: validated.filename,
          description,
          uploadedBy,
          evidenceType,
          contentType: validated.contentType,
          byteSize: validated.byteSize,
          contentSha256: validated.contentSha256,
          storageObjectKey: stored.objectKey,
          expectedRecordVersion,
          correlationId,
        });
      } catch (error) {
        await evidenceStorage.delete(stored.objectKey).catch(() => {});
        throw error;
      }
    },

    async markFraudPublished(investigationId) {
      return investigationRepository.markFraudPublished(investigationId);
    },
  };
}
