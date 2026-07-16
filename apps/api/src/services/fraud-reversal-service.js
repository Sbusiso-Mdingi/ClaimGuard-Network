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
      const result = await fraudWorkflowRepository.reverseFraud(input);
      logger?.("info", result.replayed ? "fraud_reversal_replayed" : "fraud_reversed", {
        requestId: input.correlationId,
        investigationId: input.investigationId,
        actorId: input.actorId,
        actorRole: input.actorRole,
        ledgerSequenceNumber: result.entry.sequenceNumber,
        registryEntryId: result.registryEntry.registryEntryId,
      });
      return result;
    },
  };
}
