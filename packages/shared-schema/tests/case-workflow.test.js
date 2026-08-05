import assert from "node:assert/strict";
import test from "node:test";

import {
  PROHIBITED_CASE_OUTCOME_CODES,
  PROHIBITED_CASE_REQUEST_FIELDS,
  caseActionSuccessResponseSchema,
  parseCaseActionRequest,
} from "../src/case-workflow.js";

const base = {
  expectedStateVersion: 2,
  reasonCode: "PROCESS_STEP_COMPLETE",
  reasonSummary: "The governed process step was completed.",
};

test("simple actions reject client-controlled trusted context", () => {
  for (const field of PROHIBITED_CASE_REQUEST_FIELDS) {
    assert.throws(() => parseCaseActionRequest("begin-triage", {
      ...base,
      [field]: field === "roles" ? ["platform_administrator"] : "spoofed",
    }));
  }
});

test("report completion requires a report and evidence or a valid no-evidence reason", () => {
  assert.doesNotThrow(() => parseCaseActionRequest("complete-investigation-report", {
    ...base,
    completionReason: "REPORT_COMPLETE",
    reportDigest: "sha256:abc",
    evidenceReferences: ["evidence-1"],
  }));
  assert.doesNotThrow(() => parseCaseActionRequest("complete-investigation-report", {
    ...base,
    completionReason: "REPORT_COMPLETE",
    reportReference: "report-1",
    noEvidenceReason: "No evidence was lawfully available; see the recorded process check.",
  }));
  assert.throws(() => parseCaseActionRequest("complete-investigation-report", {
    ...base,
    completionReason: "REPORT_COMPLETE",
  }));
});

test("outcome approval contract rejects legacy and network-notice codes", () => {
  const approval = {
    ...base,
    recordedReasons: ["Independent review completed."],
    identityMatchReviewResult: {
      reviewed: true,
      resultCode: "MATCH_REVIEWED",
      reviewReference: "identity-review-1",
    },
    supportingReportReference: "report-1",
    evidenceSetReference: "evidence-set-1",
    processCheckReferences: ["check-1"],
    processCheckComplete: true,
  };

  for (const outcomeCode of PROHIBITED_CASE_OUTCOME_CODES) {
    assert.throws(() => parseCaseActionRequest("approve-outcome", {
      ...approval,
      outcomeCode,
    }));
  }
  assert.doesNotThrow(() => parseCaseActionRequest("approve-outcome", {
    ...approval,
    outcomeCode: "CONFIGURED_NEUTRAL_OUTCOME",
  }));
});

test("success response contains bounded workflow metadata only", () => {
  const parsed = caseActionSuccessResponseSchema.parse({
    caseId: "case-1",
    state: "TRIAGE_PENDING",
    stateVersion: 2,
    transitionEventId: "event-1",
    operationId: "a".repeat(64),
    correlationId: "request-1",
    replayed: false,
  });
  assert.deepEqual(Object.keys(parsed).sort(), [
    "caseId",
    "correlationId",
    "operationId",
    "replayed",
    "state",
    "stateVersion",
    "transitionEventId",
  ]);
});
