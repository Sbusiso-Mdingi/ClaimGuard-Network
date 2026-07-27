import { createClaimWakeupPublisher } from "./claim-wakeup-publisher.js";

export function createClaimIngestionService({
  claimIngestionRepository = null,
  wakeupPublisher = undefined,
  logger,
} = {}) {
  const resolvedWakeupPublisher = wakeupPublisher === undefined
    ? createClaimWakeupPublisher({ logger })
    : wakeupPublisher;

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

      let wakeup = {
        status: summary.processing?.asynchronous ? "not_configured" : "not_required",
        messageId: null,
      };
      if (summary.processing?.asynchronous && summary.processing?.jobId && resolvedWakeupPublisher?.publish) {
        wakeup = await resolvedWakeupPublisher.publish({
          jobId: summary.processing.jobId,
          correlationId: summary.processing.correlationId || requestId,
        });
      }

      logger?.("info", "claims_ingested", {
        requestId,
        source,
        received: summary.received,
        inserted: summary.inserted,
        updated: summary.updated,
        referenceRecords: schemes.length + members.length + providers.length,
        jobId: summary.processing?.jobId || null,
        processingStatus: summary.processing?.status || null,
        wakeupStatus: wakeup.status,
      });

      return {
        ...summary,
        processing: {
          ...summary.processing,
          wakeup,
        },
      };
    },
  };
}
