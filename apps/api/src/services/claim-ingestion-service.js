export function createClaimIngestionService({
  claimIngestionRepository = null,
  logger,
} = {}) {
  return {
    isConfigured() {
      return Boolean(claimIngestionRepository && typeof claimIngestionRepository.ingestClaims === "function");
    },

    async ingest({ claims, source = "api", requestId = null }) {
      const summary = await claimIngestionRepository.ingestClaims({
        claims,
        source,
        correlationId: requestId,
      });

      logger?.("info", "claims_ingested", {
        requestId,
        source,
        received: summary.received,
        inserted: summary.inserted,
        updated: summary.updated,
        jobId: summary.processing?.jobId || null,
        processingStatus: summary.processing?.status || null,
      });

      return summary;
    },
  };
}
