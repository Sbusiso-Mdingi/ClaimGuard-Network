export function createFraudReversalService({
  ledgerRepository = null,
  sharedFraudRegistryRepository = null,
  logger,
} = {}) {
  return {
    isLedgerConfigured() {
      return Boolean(ledgerRepository && typeof ledgerRepository.createReversedFraudEntry === "function");
    },

    isRegistryConfigured() {
      return Boolean(
        sharedFraudRegistryRepository &&
          typeof sharedFraudRegistryRepository.getActiveRegistryFindingForInvestigation === "function",
      );
    },

    async reverseFraud({ payload, investigation, requestId = null }) {
      const originalRegistryEntry =
        await sharedFraudRegistryRepository.getActiveRegistryFindingForInvestigation({
          investigationId: payload.investigationId,
          tenantId: investigation.tenantId,
        });

      if (!originalRegistryEntry) {
        return {
          ok: false,
          status: 409,
          body: {
            available: false,
            message: "No active registry finding exists for this investigation.",
          },
        };
      }

      const reversalLedgerEntry = await ledgerRepository.createReversedFraudEntry({
        claimId: payload.claimId,
        investigatorId: payload.investigatorId,
        reason: payload.reason,
        schemeId: payload?.schemeId || null,
        notes: payload?.notes || null,
        originalLedgerHash: originalRegistryEntry.ledgerHash,
      });

      const reversalRegistryEntry = await sharedFraudRegistryRepository.publishFraudReversal({
        ledgerEntry: reversalLedgerEntry,
        investigation,
        originalRegistryEntry,
        investigatorReference: payload.investigatorId,
      });

      logger?.("info", "fraud_reversed", {
        requestId,
        claimId: payload.claimId,
        investigatorId: payload.investigatorId,
        investigationId: payload.investigationId,
        originalRegistryEntryId: originalRegistryEntry.registryEntryId,
        reversalRegistryEntryId: reversalRegistryEntry.registryEntryId,
        ledgerSequenceNumber: reversalLedgerEntry.sequenceNumber,
      });

      return {
        ok: true,
        entry: reversalLedgerEntry,
        registryEntry: reversalRegistryEntry,
      };
    },
  };
}
