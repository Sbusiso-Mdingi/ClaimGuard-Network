import assert from "node:assert/strict";
import test from "node:test";

import {
  createFraudConfirmationService,
  DIRECT_REGISTRY_PUBLICATION_ERROR,
} from "../src/services/fraud-confirmation-service.js";
import { createFraudReversalService } from "../src/services/fraud-reversal-service.js";

const repositoryResult = {
  entry: { sequenceNumber: 7 },
  registryEntry: { registryEntryId: "registry-7" },
  replayed: false,
};

test("confirmation service fails closed and never delegates direct registry publication", async () => {
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
    reason: "Report completed",
    actorId: "authenticated-user",
    actorRole: "investigator",
    correlationId: "request-1",
    idempotencyKey: "key-1",
  };

  assert.equal(service.isConfigured(), true);
  await assert.rejects(
    service.confirmFraud(input),
    (error) => {
      assert.equal(error.code, DIRECT_REGISTRY_PUBLICATION_ERROR.code);
      assert.equal(error.status, DIRECT_REGISTRY_PUBLICATION_ERROR.status);
      assert.equal(error.message, DIRECT_REGISTRY_PUBLICATION_ERROR.message);
      return true;
    },
  );
  assert.deepEqual(calls, []);
  assert.equal(logs[0].event, "direct_registry_publication_blocked");
  assert.equal(logs[0].details.errorCode, "NETWORK_NOTICE_GOVERNANCE_REQUIRED");
  assert.equal(JSON.stringify(logs[0]).includes("patient"), false);
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
