import assert from "node:assert/strict";
import test from "node:test";

import {
  ClaimWakeupDeliveryError,
  createClaimWakeupPublisher,
} from "../src/services/claim-wakeup-publisher.js";
import { createClaimIngestionService } from "../src/services/claim-ingestion-service.js";

test("claim wakeup publisher sends only a durable outbox reference", async () => {
  const requests = [];
  const publisher = createClaimWakeupPublisher({
    queueUrl: "https://example.queue.core.windows.net/claim-scoring",
    credential: {
      async getToken(scope) {
        assert.equal(scope, "https://storage.azure.com/.default");
        return { token: "test-token" };
      },
    },
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      return new Response(
        "<QueueMessagesList><QueueMessage><MessageId>message-1</MessageId></QueueMessage></QueueMessagesList>",
        { status: 201 },
      );
    },
  });

  const result = await publisher.publish({
    jobId: "job-1",
    correlationId: "request-1",
  });

  assert.equal(result.status, "published");
  assert.equal(result.messageId, "message-1");
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, "https://example.queue.core.windows.net/claim-scoring/messages");
  assert.equal(requests[0].options.headers.Authorization, "Bearer test-token");
  assert.match(requests[0].options.body, /outbox_job_id/);
  assert.doesNotMatch(requests[0].options.body, /member_id|provider_id|identity_number|banking_detail|claim_payload/);
});

test("claim wakeup publisher retries transient queue failures", async () => {
  let calls = 0;
  const publisher = createClaimWakeupPublisher({
    queueUrl: "https://example.queue.core.windows.net/claim-scoring",
    credential: { async getToken() { return { token: "test-token" }; } },
    fetchImpl: async () => {
      calls += 1;
      if (calls < 3) return new Response("temporary", { status: 503 });
      return new Response(
        "<QueueMessagesList><QueueMessage><MessageId>message-3</MessageId></QueueMessage></QueueMessagesList>",
        { status: 201 },
      );
    },
  });

  const result = await publisher.publish({ jobId: "job-3" });
  assert.equal(calls, 3);
  assert.equal(result.messageId, "message-3");
});

test("claim wakeup publisher fails closed after bounded attempts", async () => {
  const publisher = createClaimWakeupPublisher({
    queueUrl: "https://example.queue.core.windows.net/claim-scoring",
    credential: { async getToken() { return { token: "test-token" }; } },
    maximumAttempts: 2,
    fetchImpl: async () => new Response("unavailable", { status: 503 }),
  });

  await assert.rejects(
    () => publisher.publish({ jobId: "job-4" }),
    (error) => error instanceof ClaimWakeupDeliveryError
      && error.code === "CLAIM_SCORING_WAKEUP_UNAVAILABLE",
  );
});

test("ingestion publishes the committed job wakeup and returns its receipt", async () => {
  const published = [];
  const service = createClaimIngestionService({
    claimIngestionRepository: {
      async ingestClaims() {
        return {
          received: 1,
          inserted: 1,
          updated: 0,
          processing: {
            asynchronous: true,
            status: "queued",
            jobId: "job-5",
            correlationId: "request-5",
          },
        };
      },
    },
    wakeupPublisher: {
      async publish(message) {
        published.push(message);
        return { status: "published", messageId: "message-5" };
      },
    },
  });

  const result = await service.ingest({ claims: [{}], requestId: "request-5" });
  assert.deepEqual(published, [{ jobId: "job-5", correlationId: "request-5" }]);
  assert.deepEqual(result.processing.wakeup, {
    status: "published",
    messageId: "message-5",
  });
});
