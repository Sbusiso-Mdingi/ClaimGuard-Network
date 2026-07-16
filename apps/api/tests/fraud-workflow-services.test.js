import assert from "node:assert/strict";
import test from "node:test";

import { createFraudConfirmationService } from "../src/services/fraud-confirmation-service.js";
import { createFraudReversalService } from "../src/services/fraud-reversal-service.js";

const repositoryResult = {
  entry: { sequenceNumber: 7 },
  registryEntry: { registryEntryId: "registry-7" },
  replayed: false,
};

test("confirmation service delegates the complete canonical workflow input once", async () => {
  const calls = [];
  const logs = [];
  const service = createFraudConfirmationService({
    fraudWorkflowRepository: {
      async confirmFraud(input) {
        calls.push(input);
        return repositoryResult;
      },
    },
    logger(level, event, details) {
      logs.push({ level, event, details });
    },
  });
  const input = {
    tenantId: "tenant-alpha",
    investigationId: "inv-1",
    reason: "Confirmed",
    actorId: "authenticated-user",
    actorRole: "investigator",
    correlationId: "request-1",
    idempotencyKey: "key-1",
  };

  assert.equal(service.isConfigured(), true);
  assert.equal(await service.confirmFraud(input), repositoryResult);
  assert.deepEqual(calls, [input]);
  assert.equal(logs[0].event, "fraud_confirmed");
  assert.equal(logs[0].details.actorId, "authenticated-user");
});

test("reversal service preserves replay state and delegates only to the atomic repository", async () => {
  const calls = [];
  const service = createFraudReversalService({
    fraudWorkflowRepository: {
      async reverseFraud(input) {
        calls.push(input);
        return { ...repositoryResult, replayed: true };
      },
    },
  });
  const input = {
    tenantId: "tenant-alpha",
    investigationId: "inv-1",
    reason: "Reversed",
    actorId: "authenticated-user",
    actorRole: "investigator",
    correlationId: "request-2",
    idempotencyKey: "key-2",
  };

  const result = await service.reverseFraud(input);
  assert.equal(service.isLedgerConfigured(), true);
  assert.equal(service.isRegistryConfigured(), true);
  assert.equal(result.replayed, true);
  assert.deepEqual(calls, [input]);
});
