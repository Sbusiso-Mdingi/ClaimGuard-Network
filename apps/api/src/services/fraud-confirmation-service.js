export const LEGACY_FRAUD_CONFIRMATION_ERROR = Object.freeze({
  code: "LEGACY_FRAUD_CONFIRMATION_DISABLED",
  status: 409,
  message: "Direct legacy fraud confirmation is disabled. Complete the investigation and use the governed case outcome-review workflow.",
});

// Retained temporarily as a compatibility export for callers that imported the
// old constant name. The error now describes the disabled legacy command; an
// actual network-notice activation attempt uses NETWORK_NOTICE_GOVERNANCE_REQUIRED.
export const DIRECT_REGISTRY_PUBLICATION_ERROR = LEGACY_FRAUD_CONFIRMATION_ERROR;

export class LegacyFraudConfirmationDisabledError extends Error {
  constructor() {
    super(LEGACY_FRAUD_CONFIRMATION_ERROR.message);
    this.name = "LegacyFraudConfirmationDisabledError";
    this.code = LEGACY_FRAUD_CONFIRMATION_ERROR.code;
    this.status = LEGACY_FRAUD_CONFIRMATION_ERROR.status;
  }
}

export const DirectRegistryPublicationDisabledError = LegacyFraudConfirmationDisabledError;

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
        errorCode: LEGACY_FRAUD_CONFIRMATION_ERROR.code,
      });

      // Historical persistence remains available only to isolated compatibility
      // tests. Supported API paths use fixed governed case actions. Separate
      // shared-registry approval and activation remain deferred to PR 5.
      throw new LegacyFraudConfirmationDisabledError();
    },
  };
}
