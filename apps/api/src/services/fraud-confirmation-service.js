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

export function createFraudConfirmationService({ fraudWorkflowRepository = null, logger } = {}) {
  return {
    isConfigured() {
      return Boolean(fraudWorkflowRepository && typeof fraudWorkflowRepository.confirmFraud === "function");
    },

    // Retained as an API compatibility alias for availability checks.
    isLedgerConfigured() {
      return this.isConfigured();
    },

    async confirmFraud(input) {
      logger?.("warn", "direct_registry_publication_blocked", {
        requestId: input?.correlationId,
        investigationId: input?.investigationId,
        actorId: input?.actorId,
        actorRole: input?.actorRole,
        errorCode: DIRECT_REGISTRY_PUBLICATION_ERROR.code,
      });

      throw new DirectRegistryPublicationDisabledError();
    },
  };
}
