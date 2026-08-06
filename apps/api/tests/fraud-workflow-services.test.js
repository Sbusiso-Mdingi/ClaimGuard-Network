import assert from "node:assert/strict";
import test from "node:test";

import {
  createFraudConfirmationService,
  LEGACY_FRAUD_CONFIRMATION_ERROR,
} from "../src/services/fraud-confirmation-service.js";
import {
  createFraudReversalService,
  LEGACY_FRAUD_REVERSAL_ERROR,
} from "../src/services/fraud-reversal-service.js";

const input = {
  tenantId: "tenant-alpha",
  investigationId: "inv-1",
  reason: "Historical action request",
  actorId: "authenticated-user",
  actorRole: "investigator",
  correlationId: "request-1",
  idempotencyKey: "key-1",
};

test("supported confirmation service blocks before invoking the legacy repository", async () => {
  const calls = [];
  const logs = [];
  const service = createFraudConfirmationService({
    fraudWorkflowRepository: {
      async confirmFraud(value) {
        calls.push(value);
        throw new Error("Legacy repository must be unreachable.");
      },
    },
    logger(level, event, details) {
      logs.push({ level, event, details });
    },
  });

  assert.equal(service.isConfigured(), true);
  await assert.rejects(
    service.confirmFraud(input),
    (error) => error.code === LEGACY_FRAUD_CONFIRMATION_ERROR.code
      && error.status === LEGACY_FRAUD_CONFIRMATION_ERROR.status
      && error.message === LEGACY_FRAUD_CONFIRMATION_ERROR.message,
  );
  assert.deepEqual(calls, []);
  assert.equal(logs[0].event, "legacy_fraud_confirmation_blocked");
  assert.equal(logs[0].details.errorCode, "LEGACY_FRAUD_CONFIRMATION_DISABLED");
  assert.equal(JSON.stringify(logs[0]).includes("patient"), false);
});

test("supported reversal service blocks before invoking the legacy repository", async () => {
  const calls = [];
  const logs = [];
  const service = createFraudReversalService({
    fraudWorkflowRepository: {
      async reverseFraud(value) {
        calls.push(value);
        throw new Error("Legacy repository must be unreachable.");
      },
    },
    logger(level, event, details) {
      logs.push({ level, event, details });
    },
  });

  assert.equal(service.isLedgerConfigured(), true);
  assert.equal(service.isRegistryConfigured(), true);
  await assert.rejects(
    service.reverseFraud({ ...input, correlationId: "request-2" }),
    (error) => error.code === LEGACY_FRAUD_REVERSAL_ERROR.code
      && error.status === LEGACY_FRAUD_REVERSAL_ERROR.status
      && error.message === LEGACY_FRAUD_REVERSAL_ERROR.message,
  );
  assert.deepEqual(calls, []);
  assert.equal(logs[0].event, "legacy_fraud_reversal_blocked");
  assert.equal(logs[0].details.errorCode, "LEGACY_FRAUD_REVERSAL_DISABLED");
});
