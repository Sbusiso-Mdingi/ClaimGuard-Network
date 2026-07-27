import { DefaultAzureCredential } from "@azure/identity";

function requiredText(value, field, maximum = 256) {
  const rendered = String(value || "").trim();
  if (!rendered) throw new TypeError(`${field} is required.`);
  if (rendered.length > maximum) throw new TypeError(`${field} must not exceed ${maximum} characters.`);
  return rendered;
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function escapeXml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function messageIdFromXml(xml) {
  const match = /<MessageId>([^<]+)<\/MessageId>/.exec(String(xml || ""));
  return match?.[1] || null;
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
  queueUrl = process.env.CLAIM_SCORING_QUEUE_URL,
  credential = null,
  fetchImpl = globalThis.fetch,
  maximumAttempts = 3,
  logger = null,
} = {}) {
  const resolvedQueueUrl = String(queueUrl || "").replace(/\/+$/, "");
  if (!resolvedQueueUrl) return null;
  if (typeof fetchImpl !== "function") throw new TypeError("fetchImpl is required.");

  const resolvedCredential = credential || new DefaultAzureCredential({
    managedIdentityClientId: process.env.AZURE_CLIENT_ID || undefined,
  });

  return Object.freeze({
    async publish({ jobId, correlationId = null } = {}) {
      const canonicalJobId = requiredText(jobId, "jobId", 64);
      const canonicalCorrelationId = correlationId ? requiredText(correlationId, "correlationId", 128) : null;
      const message = JSON.stringify({
        schema_version: 1,
        outbox_job_id: canonicalJobId,
        correlation_id: canonicalCorrelationId,
        emitted_at: new Date().toISOString(),
      });
      const body = `<QueueMessage><MessageText>${escapeXml(message)}</MessageText></QueueMessage>`;

      let lastError = null;
      for (let attempt = 1; attempt <= maximumAttempts; attempt += 1) {
        try {
          const token = await resolvedCredential.getToken("https://storage.azure.com/.default");
          if (!token?.token) throw new Error("Azure Storage access token was unavailable.");
          const response = await fetchImpl(`${resolvedQueueUrl}/messages`, {
            method: "POST",
            headers: {
              Authorization: `Bearer ${token.token}`,
              "Content-Type": "application/xml",
              "x-ms-date": new Date().toUTCString(),
              "x-ms-version": "2023-11-03",
            },
            body,
          });
          const responseBody = await response.text();
          if (!response.ok) {
            const error = new Error(`Azure Queue returned HTTP ${response.status}.`);
            error.code = `AZURE_QUEUE_HTTP_${response.status}`;
            error.responseBody = responseBody.slice(0, 500);
            throw error;
          }
          const messageId = messageIdFromXml(responseBody);
          logger?.("info", "claim_scoring_wakeup_published", {
            jobId: canonicalJobId,
            correlationId: canonicalCorrelationId,
            queueMessageId: messageId,
            attempt,
          });
          return { status: "published", messageId, attempt };
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
