export const LEGACY_FRAUD_REVERSAL_ERROR = Object.freeze({
  code: "LEGACY_FRAUD_REVERSAL_DISABLED",
  status: 409,
  message: "Direct legacy fraud reversal is disabled. Use the governed case appeal or review action.",
});

export class LegacyFraudReversalDisabledError extends Error {
  constructor() {
    super(LEGACY_FRAUD_REVERSAL_ERROR.message);
    this.name = "LegacyFraudReversalDisabledError";
    this.code = LEGACY_FRAUD_REVERSAL_ERROR.code;
    this.status = LEGACY_FRAUD_REVERSAL_ERROR.status;
  }
}

export function createFraudReversalService({ fraudWorkflowRepository = null, logger } = {}) {
  return {
    isConfigured() {
      return Boolean(fraudWorkflowRepository && typeof fraudWorkflowRepository.reverseFraud === "function");
    },

    isLedgerConfigured() {
      return this.isConfigured();
    },

    isRegistryConfigured() {
      return this.isConfigured();
    },

    async reverseFraud(input) {
      logger?.("warn", "legacy_fraud_reversal_blocked", {
        requestId: input?.correlationId || null,
        investigationId: input?.investigationId || null,
        actorId: input?.actorId || null,
        errorCode: LEGACY_FRAUD_REVERSAL_ERROR.code,
      });

      // Historical reversal persistence remains isolated for legacy unit
      // compatibility. Supported callers use the governed appeal/review action.
      throw new LegacyFraudReversalDisabledError();
    },
  };
}
