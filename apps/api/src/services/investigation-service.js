export function createInvestigationService({ investigationRepository = null } = {}) {
  function hasMethod(name) {
    return Boolean(investigationRepository && typeof investigationRepository[name] === "function");
  }

  return {
    hasMethod,

    async createInvestigation({ claimId, assignedInvestigator = null, assignedBy, priority }) {
      return investigationRepository.createInvestigation({
        claimId,
        assignedInvestigator,
        assignedBy,
        priority,
      });
    },

    async getInvestigationById(investigationId) {
      return investigationRepository.getInvestigationById(investigationId);
    },

    async getInvestigationDetails(investigationId) {
      return investigationRepository.getInvestigationDetails(investigationId);
    },

    async updateInvestigation({ investigationId, status = undefined, priority = undefined }) {
      return investigationRepository.updateInvestigation({
        investigationId,
        status,
        priority,
      });
    },

    async addNote({ investigationId, author, text, noteType }) {
      return investigationRepository.addNote({
        investigationId,
        author,
        text,
        noteType,
      });
    },

    async registerEvidence({ investigationId, filename, description, uploadedBy, evidenceType }) {
      return investigationRepository.registerEvidence({
        investigationId,
        filename,
        description,
        uploadedBy,
        evidenceType,
      });
    },

    async markFraudPublished(investigationId) {
      return investigationRepository.markFraudPublished(investigationId);
    },
  };
}
