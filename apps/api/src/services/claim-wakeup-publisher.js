import { DefaultAzureCredential } from "@azure/identity";
import { QueueClient } from "@azure/storage-queue";

function requiredText(value, field, maximum = 256) {
  const rendered = String(value || "").trim();
  if (!rendered) throw new TypeError(`${field} is required.`);
  if (rendered.length > maximum) throw new TypeError(`${field} must not exceed ${maximum} characters.`);
  return rendered;
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export class ClaimWakeupDeliveryError extends Error {
  constructor(message = "The claim-scoring wake-up could not be delivered.", cause = null) {
    super(message, cause ? { cause } : undefined);
    this.name = "ClaimWakeupDeliveryError";
    this.code = "CLAIM_SCORING_WAKEUP_UNAVAILABLE";
    this.status = 503;
  }
}

export function createClaimWakeupPublisher({
  queueClient = null,
  queueUrl = process.env.CLAIM_SCORING_QUEUE_URL,
  credential = null,
  maximumAttempts = 3,
  logger = null,
} = {}) {
  const resolvedQueueUrl = String(queueUrl || "").trim();
  if (!queueClient && !resolvedQueueUrl) return null;

  const client = queueClient || new QueueClient(
    resolvedQueueUrl,
    credential || new DefaultAzureCredential({
      managedIdentityClientId: process.env.AZURE_CLIENT_ID || undefined,
    }),
  );

  return Object.freeze({
    async publish({ jobId, correlationId = null } = {}) {
      const canonicalJobId = requiredText(jobId, "jobId", 64);
      const canonicalCorrelationId = correlationId ? requiredText(correlationId, "correlationId", 128) : null;
      const body = JSON.stringify({
        schema_version: 1,
        outbox_job_id: canonicalJobId,
        correlation_id: canonicalCorrelationId,
        emitted_at: new Date().toISOString(),
      });

      let lastError = null;
      for (let attempt = 1; attempt <= maximumAttempts; attempt += 1) {
        try {
          const response = await client.sendMessage(body);
          logger?.("info", "claim_scoring_wakeup_published", {
            jobId: canonicalJobId,
            correlationId: canonicalCorrelationId,
            queueMessageId: response.messageId || null,
            attempt,
          });
          return {
            status: "published",
            messageId: response.messageId || null,
            attempt,
          };
        } catch (error) {
          lastError = error;
          logger?.("warning", "claim_scoring_wakeup_publish_failed", {
            jobId: canonicalJobId,
            correlationId: canonicalCorrelationId,
            attempt,
            failureCategory: error?.code || error?.name || "queue_failure",
          });
          if (attempt < maximumAttempts) await delay(100 * (2 ** (attempt - 1)));
        }
      }

      throw new ClaimWakeupDeliveryError(undefined, lastError);
    },
  });
}
