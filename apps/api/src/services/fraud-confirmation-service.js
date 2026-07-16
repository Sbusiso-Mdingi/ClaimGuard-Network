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
      const result = await fraudWorkflowRepository.confirmFraud(input);
      logger?.("info", result.replayed ? "fraud_confirmation_replayed" : "fraud_confirmed", {
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
