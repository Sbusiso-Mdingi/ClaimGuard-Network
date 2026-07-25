import assert from "node:assert/strict";
import test from "node:test";

import { createBackendApp } from "../src/backend.js";

function headers() {
  return {
    "x-claimguard-user": "scheme-user",
    "x-claimguard-role": "scheme_user",
    "x-claimguard-user-tenant": "tenant_default",
  };
}

function enrichedClaim() {
  return {
    claimId: "C-ENRICHED-1",
    currentClaimVersion: 3,
    schemeId: "scheme_a",
    memberId: "member-1",
    providerId: "provider-1",
    serviceDate: "2026-07-24",
    billedAmount: 18_500,
    billingCode: "GP03",
    submittedAt: "2026-07-24T23:54:13.000Z",
    updatedAt: "2026-07-25T00:00:00.000Z",
    status: "FLAGGED",
    processingStatus: "scored",
    processing: {
      status: "scored",
      jobId: "job-1",
      attemptCount: 1,
      maxAttempts: 5,
      failureCode: null,
      lastError: null,
      completedAt: "2026-07-25T00:00:00.000Z",
    },
    riskScore: 91,
    riskLevel: "High",
    triggeredRules: ["BASELINE_FRAUD", "MODEL_REVIEW_RECOMMENDED"],
    evidence: ["Baseline model classified the claim as FRAUD at 91.00%."],
    detection: {
      status: "scored",
      claimVersion: 3,
      scoredAt: "2026-07-25T00:00:00.000Z",
      riskScore: 91,
      riskLevel: "High",
      reviewRecommended: true,
      triggeredRules: ["BASELINE_FRAUD", "MODEL_REVIEW_RECOMMENDED"],
      evidence: ["Baseline model classified the claim as FRAUD at 91.00%."],
      analysisMode: "PROSPECTIVE_APPROVED_MODEL",
      detectionStrategyId: 29,
      strategyType: "approved_model",
      modelDeploymentId: "claimguard-claim-fraud-ensemble:1.1.0",
      sourceJobId: "job-1",
      requestId: "request-1",
      ensembleId: "claimguard-claim-fraud-ensemble",
      ensembleVersion: "1.1.0",
      featureSchemaVersion: "claims-v1",
      resultSchemaVersion: "claimguard.claim-detection-result.v1",
      score: {
        baselineFraudProbability: 0.91,
        compositeReviewRecommended: true,
      },
    },
    investigation: null,
  };
}

test("claims list and detail endpoints preserve enriched processing and detection fields", async () => {
  const claim = enrichedClaim();
  const repository = {
    async listClaims({ page, pageSize }) {
      assert.equal(page, "1");
      assert.equal(pageSize, "25");
      return {
        claims: [claim],
        pagination: {
          page: 1,
          pageSize: 25,
          requestedPageSize: 25,
          maxPageSize: 100,
          total: 1,
          totalPages: 1,
          hasNextPage: false,
        },
      };
    },
    async getClaimById(claimId) {
      return claimId === claim.claimId ? claim : null;
    },
  };

  const app = createBackendApp({ claimReadRepository: repository });

  const listResponse = await app.request("http://localhost/claims?page=1&pageSize=25", {
    headers: headers(),
  });
  const listPayload = await listResponse.json();

  assert.equal(listResponse.status, 200);
  assert.equal(listPayload.available, true);
  assert.equal(listPayload.claims[0].processingStatus, "scored");
  assert.equal(listPayload.claims[0].processing.jobId, "job-1");
  assert.equal(listPayload.claims[0].detection.strategyType, "approved_model");
  assert.equal(listPayload.claims[0].detection.modelDeploymentId, "claimguard-claim-fraud-ensemble:1.1.0");
  assert.equal(listPayload.claims[0].riskScore, 91);
  assert.deepEqual(listPayload.claims[0].triggeredRules, ["BASELINE_FRAUD", "MODEL_REVIEW_RECOMMENDED"]);

  const detailResponse = await app.request(`http://localhost/claims/${claim.claimId}`, {
    headers: headers(),
  });
  const detailPayload = await detailResponse.json();

  assert.equal(detailResponse.status, 200);
  assert.equal(detailPayload.available, true);
  assert.deepEqual(detailPayload.claim, claim);
});
