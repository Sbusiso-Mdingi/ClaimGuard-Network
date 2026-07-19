export function createClaimIngestionService({
  claimIngestionRepository = null,
  logger,
} = {}) {
  return {
    isConfigured() {
      return Boolean(claimIngestionRepository && typeof claimIngestionRepository.ingestClaims === "function");
    },

    async ingest({ claims, schemes = [], members = [], providers = [], source = "api", requestId = null }) {
      const summary = await claimIngestionRepository.ingestClaims({
        claims,
        schemes,
        members,
        providers,
        source,
        correlationId: requestId,
      });

      logger?.("info", "claims_ingested", {
        requestId,
        source,
        received: summary.received,
        inserted: summary.inserted,
        updated: summary.updated,
        referenceRecords: schemes.length + members.length + providers.length,
        jobId: summary.processing?.jobId || null,
        processingStatus: summary.processing?.status || null,
      });

      return summary;
    },
  };
}
