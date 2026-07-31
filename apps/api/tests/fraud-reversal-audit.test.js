import assert from "node:assert/strict";
import test from "node:test";

import { createFraudReversalService } from "../src/services/fraud-reversal-service.js";

test("fraud reversal emits its independent audit action", async () => {
  const events = [];
  const service = createFraudReversalService({
    fraudWorkflowRepository: {
      async reverseFraud() {
        return {
          replayed: false,
          entry: { sequenceNumber: 7 },
          registryEntry: { registryEntryId: "registry-reversal-1" },
        };
      },
    },
    logger(level, event, details) {
      events.push({ level, event, details });
    },
  });

  await service.reverseFraud({
    investigationId: "investigation-1",
    actorId: "investigator-1",
    actorRole: "investigator",
    correlationId: "request-1",
  });

  assert.equal(events.length, 1);
  assert.equal(events[0].event, "fraud_reversed");
  assert.equal(events[0].details.auditAction, "investigations.reverse_fraud");
  assert.equal(events[0].details.investigationId, "investigation-1");
});
