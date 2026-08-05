import assert from "node:assert/strict";
import test from "node:test";

import {
  LEGACY_FRAUD_REVERSAL_ERROR,
  createFraudReversalService,
} from "../src/services/fraud-reversal-service.js";

test("supported legacy reversal fails closed before the historical repository write", async () => {
  const events = [];
  let repositoryCalls = 0;
  const service = createFraudReversalService({
    fraudWorkflowRepository: {
      async reverseFraud() {
        repositoryCalls += 1;
        throw new Error("supported code must not invoke the historical reversal repository");
      },
    },
    logger(level, event, details) {
      events.push({ level, event, details });
    },
  });

  await assert.rejects(
    service.reverseFraud({
      investigationId: "investigation-1",
      actorId: "investigator-1",
      actorRole: "investigator",
      correlationId: "request-1",
    }),
    (error) => {
      assert.equal(error.code, LEGACY_FRAUD_REVERSAL_ERROR.code);
      assert.equal(error.status, LEGACY_FRAUD_REVERSAL_ERROR.status);
      return true;
    },
  );

  assert.equal(repositoryCalls, 0);
  assert.equal(events.length, 1);
  assert.equal(events[0].level, "warn");
  assert.equal(events[0].event, "legacy_fraud_reversal_blocked");
  assert.equal(events[0].details.errorCode, "LEGACY_FRAUD_REVERSAL_DISABLED");
  assert.equal(events[0].details.investigationId, "investigation-1");
});