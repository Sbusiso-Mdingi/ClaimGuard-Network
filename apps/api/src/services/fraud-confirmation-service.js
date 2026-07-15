export function createFraudConfirmationService({
  ledgerRepository = null,
  investigationService,
  sharedFraudRegistryRepository = null,
  logger,
} = {}) {
  return {
    isLedgerConfigured() {
      return Boolean(ledgerRepository && typeof ledgerRepository.createConfirmedFraudEntry === "function");
    },

    async confirmFraud({
      payload,
      investigation,
      requestId = null,
    }) {
      const entry = await ledgerRepository.createConfirmedFraudEntry({
        claimId: payload.claimId,
        investigatorId: payload.investigatorId,
        reason: payload.reason,
        schemeId: payload?.schemeId || null,
        reportVersion: payload?.reportVersion || null,
        notes: payload?.notes || null,
      });

      if (!investigationService.hasMethod("markFraudPublished")) {
        throw new Error("Investigation persistence does not support fraud publication tracking.");
      }
      await investigationService.markFraudPublished(payload.investigationId);

      let registryEntry = null;
      if (
        sharedFraudRegistryRepository &&
        typeof sharedFraudRegistryRepository.publishConfirmedFraud === "function" &&
        payload?.registryMetadata
      ) {
        try {
          registryEntry = await sharedFraudRegistryRepository.publishConfirmedFraud({
            ledgerEntry: entry,
            investigation,
            metadata: payload.registryMetadata,
          });

          logger?.("info", "fraud_registry_published", {
            requestId,
            registryEntryId: registryEntry.registryEntryId,
            investigationId: payload.investigationId,
            subjectToken: registryEntry.subjectToken,
          });
        } catch (registryError) {
          logger?.("error", "fraud_registry_publication_failed", {
            requestId,
            investigationId: payload.investigationId,
            message: registryError?.message || "Registry publication failed.",
          });
        }
      }

      logger?.("info", "fraud_confirmed", {
        requestId,
        claimId: payload.claimId,
        investigatorId: payload.investigatorId,
        schemeId: payload?.schemeId || null,
        reportVersion: payload?.reportVersion || null,
        ledgerSequenceNumber: entry.sequenceNumber,
      });

      return {
        entry,
        registryEntry,
      };
    },
  };
}
