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

    isLedgerConfigured() {
      return this.isConfigured();
    },

    isRegistryConfigured() {
      return this.isConfigured();
    },

    async confirmFraud(input) {
      logger?.("warn", "legacy_fraud_confirmation_blocked", {
        requestId: input?.correlationId || null,
        investigationId: input?.investigationId || null,
        actorId: input?.actorId || null,
        errorCode: DIRECT_REGISTRY_PUBLICATION_ERROR.code,
      });

      // The historical repository remains available only for isolated legacy
      // unit compatibility. Supported API paths must not invoke it: PR 2 uses
      // fixed governed case actions and PR 3 will add separate sharing approval.
      throw new DirectRegistryPublicationDisabledError();
    },
  };
}
