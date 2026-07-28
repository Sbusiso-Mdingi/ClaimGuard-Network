import assert from "node:assert/strict";
import test from "node:test";

import {
  assertCanaryResponse,
  parseCanaryMarker,
  parseResponseBody,
  selectExecTarget,
} from "./verify-ensemble2-canary.mjs";

const validResponse = Object.freeze({
  schemaVersion: "claimguard.claim-screening-response.v3",
  featureSchemaVersion: "claim-feature-schema-2026.2",
  deploymentId: "claimguard-claim-fraud-ensemble:2.1.1",
  modelId: "claimguard-claim-fraud-ensemble",
  modelVersion: "2.1.1",
  analysisMode: "PROSPECTIVE_CLAIM_SCREENING",
  tenantId: "canary-tenant",
  requestId: "canary-request",
  scores: [
    {
      claimId: "canary-claim",
      claimVersion: 1,
      fraudProbability: 0.25,
      predictedClass: "FRAUD",
      threshold: 0.049236234887246655,
      reviewRecommended: true,
    },
  ],
});

test("parseCanaryMarker extracts the bounded JSON response", () => {
  const output = [
    "Connecting to container...",
    `CLAIMGUARD_CANARY_RESULT=${JSON.stringify(validResponse)}`,
    "Command completed.",
  ].join("\n");
  assert.deepEqual(parseCanaryMarker(output), validResponse);
});

test("parseCanaryMarker rejects absent evidence", () => {
  assert.throws(
    () => parseCanaryMarker("Command completed without evidence."),
    /output marker is absent/,
  );
});

test("assertCanaryResponse accepts the exact 2.1.1 contract", () => {
  assert.doesNotThrow(() => assertCanaryResponse(validResponse));
});

test("assertCanaryResponse fails closed on deployment drift", () => {
  assert.throws(
    () => assertCanaryResponse({
      ...validResponse,
      deploymentId: "claimguard-claim-fraud-baseline:1.0.0",
    }),
    /Deployment ID mismatch/,
  );
});

test("assertCanaryResponse rejects non-finite probability", () => {
  assert.throws(
    () => assertCanaryResponse({
      ...validResponse,
      scores: [{
        ...validResponse.scores[0],
        fraudProbability: Number.NaN,
      }],
    }),
    /Fraud probability must be finite/,
  );
});

test("parseResponseBody accepts an expected non-JSON 401 body", () => {
  assert.equal(parseResponseBody("", {
    url: "https://canary.example/v3/claim-screening",
    status: 401,
    allowNonJson: true,
  }), "");
});

test("parseResponseBody rejects non-JSON success evidence", () => {
  assert.throws(
    () => parseResponseBody("not-json", {
      url: "https://canary.example/health/ready",
      status: 200,
    }),
    /returned non-JSON content with status 200/,
  );
});

const healthyRevision = {
  name: "claimguard-ensemble-211-canary--test",
  properties: {
    active: true,
    healthState: "Healthy",
    provisioningState: "Provisioned",
    replicas: 1,
  },
};

const healthyReplica = {
  name: "claimguard-ensemble-211-canary--test-replica",
  properties: {
    runningState: "Running",
    containers: [
      {
        name: "model-service",
        ready: true,
        runningState: "Running",
        restartCount: 0,
      },
      {
        name: "http-auth",
        ready: true,
        runningState: "Running",
        restartCount: 0,
      },
    ],
  },
};

test("selectExecTarget selects one exact healthy revision and replica", () => {
  assert.deepEqual(selectExecTarget(
    [healthyRevision],
    { [healthyRevision.name]: [healthyReplica] },
  ), {
    revision: healthyRevision.name,
    replica: healthyReplica.name,
  });
});

test("selectExecTarget fails closed on ambiguous active revisions", () => {
  assert.throws(
    () => selectExecTarget(
      [healthyRevision, { ...healthyRevision, name: "second-revision" }],
      {},
    ),
    /Healthy active canary revision count mismatch/,
  );
});

test("selectExecTarget rejects a restarted model container", () => {
  const restarted = {
    ...healthyReplica,
    properties: {
      ...healthyReplica.properties,
      containers: healthyReplica.properties.containers.map((container) =>
        container.name === "model-service"
          ? { ...container, restartCount: 1 }
          : container),
    },
  };
  assert.throws(
    () => selectExecTarget(
      [healthyRevision],
      { [healthyRevision.name]: [restarted] },
    ),
    /Ready canary replica count mismatch/,
  );
});
