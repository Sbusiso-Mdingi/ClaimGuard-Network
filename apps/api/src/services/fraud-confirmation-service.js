export const DIRECT_REGISTRY_PUBLICATION_ERROR = Object.freeze({
  code: "NETWORK_NOTICE_GOVERNANCE_REQUIRED",
  status: 409,
  message: "Direct investigator publication is disabled. Independent outcome review and sharing-authority approval are required.",
});

export class DirectRegistryPublicationDisabledError extends Error {
  constructor() {
    super(DIRECT_REGISTRY_PUBLICATION_ERROR.message);
    this.name = "DirectRegistryPublicationDisabledError";
    this.code = DIRECT_REGISTRY_PUBLICATION_ERROR.code;
    this.status = DIRECT_REGISTRY_PUBLICATION_ERROR.status;
  }
}

function isGovernanceRejection(error) {
  return error?.code === DIRECT_REGISTRY_PUBLICATION_ERROR.code
    || String(error?.message || "").includes(DIRECT_REGISTRY_PUBLICATION_ERROR.code);
}

export function createFraudConfirmationService({ fraudWorkflowRepository = null, logger } = {}) {
  return {
    isConfigured() {
      return Boolean(fraudWorkflowRepository && typeof fraudWorkflowRepository.confirmFraud === "function");
    },

    isLedgerConfigured() {
      return this.isConfigured();
    },

    isRegistryConfigured() {
      return this.isConfigured();
    },

    async confirmFraud(input) {
      if (!this.isConfigured()) {
        throw new Error("Fraud workflow repository is not configured.");
      }

      try {
        // Compatibility adapter only. Migration 0016 independently prevents
        // this legacy repository from committing an ACTIVE registry row, so
        // the transaction fails closed and rolls back all coupled writes.
        return await fraudWorkflowRepository.confirmFraud(input);
      } catch (error) {
        if (!isGovernanceRejection(error)) throw error;

        logger?.("warn", "direct_registry_publication_blocked", {
          requestId: input?.correlationId,
          investigationId: input?.investigationId,
          actorId: input?.actorId,
          actorRole: input?.actorRole,
          errorCode: DIRECT_REGISTRY_PUBLICATION_ERROR.code,
        });
        throw new DirectRegistryPublicationDisabledError();
      }
    },
  };
}
