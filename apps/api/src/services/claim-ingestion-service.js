export function createClaimIngestionService({
  claimIngestionRepository = null,
  producerRuntimeTrigger = null,
  logger,
} = {}) {
  return {
    isConfigured() {
      return Boolean(claimIngestionRepository && typeof claimIngestionRepository.ingestClaims === "function");
    },

    async ingest({ claims, source = "api", tenantContext = null, requestId = null }) {
      const summary = await claimIngestionRepository.ingestClaims({
        claims,
        source,
      });

      logger?.("info", "claims_ingested", {
        requestId,
        source,
        received: summary.received,
        inserted: summary.inserted,
        updated: summary.updated,
      });

      if (producerRuntimeTrigger && typeof producerRuntimeTrigger.triggerAfterIngestion === "function") {
        const triggerStart = Date.now();
        await producerRuntimeTrigger.triggerAfterIngestion({
          claims,
          source,
          ingestion: summary,
          tenantContext,
        });
        logger?.("info", "producer_trigger_completed", {
          requestId,
          source,
          durationMs: Date.now() - triggerStart,
          claimCount: claims.length,
        });
      }

      return summary;
    },
  };
}
