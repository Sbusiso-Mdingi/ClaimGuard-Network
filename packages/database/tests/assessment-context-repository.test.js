import assert from "node:assert/strict";
import test from "node:test";

import {
  AssessmentContextRepositoryError,
  claimCorrectionImpactReview,
  completeCorrectionImpactReview,
  executeProviderCorrection,
  getCorrectionImpactReview,
  listCorrectionImpactReviewEvents,
  listCorrectionImpactReviews,
  persistMemberVersion,
  requestAssessmentReassessment,
} from "../src/index.js";
import { sha256CanonicalJson } from "../src/assessment-context-policy.js";

function normalizedSql(value) {
  return String(value).replace(/\s+/g, " ").trim();
}

function scriptedExecutor(steps) {
  const pending = [...steps];
  const calls = [];
  return {
    calls,
    async execute(sql, params = []) {
      const statement = normalizedSql(sql);
      calls.push({ sql: statement, params });
      const step = pending.shift();
      assert.ok(step, `Unexpected SQL: ${statement}`);
      assert.match(statement, step.pattern);
      if (typeof step.result === "function") return step.result({ statement, params, calls });
      return step.result ?? [{ affectedRows: 1 }, []];
    },
    assertDone() {
      assert.equal(pending.length, 0, `Unconsumed SQL steps: ${pending.length}`);
    },
  };
}

const provider = Object.freeze({
  provider_id: "provider-1",
  scheme_id: "scheme-1",
  practice_number: "practice-1",
  specialty: "General",
  practice_name: "Updated Practice",
  banking_detail: "token:provider-bank",
  practice_region: "Gauteng",
  practice_lat: -26.2,
  practice_lon: 28,
  provider_kind: "PRACTICE",
  provider_category: "GENERAL",
});

const currentProvider = Object.freeze({
  tenant_id: "tenant-alpha",
  provider_id: provider.provider_id,
  current_provider_version: 1,
  scheme_id: provider.scheme_id,
  practice_number: provider.practice_number,
  specialty: provider.specialty,
  practice_name: "Original Practice",
  banking_detail: provider.banking_detail,
  practice_region: provider.practice_region,
  practice_lat: provider.practice_lat,
  practice_lon: provider.practice_lon,
  provider_kind: provider.provider_kind,
  provider_category: provider.provider_category,
});

function providerCorrectionValues(overrides = {}) {
  return {
    tenantId: "tenant-alpha",
    provider,
    expectedVersion: 1,
    idempotencyKey: "provider-correction-1",
    actorId: "user:submitter",
    reasonCode: "PROVIDER_CORRECTION",
    reasonSummary: "Correct the practice display name.",
    sourceReference: "evidence:provider-1",
    source: "api:correction:submitter",
    correlationId: "request-provider-1",
    ...overrides,
  };
}

test("provider correction locks its entity before idempotency and replays the authoritative result", async () => {
  let persistedOperation;
  const first = scriptedExecutor([
    { pattern: /^SELECT provider_id FROM providers .* FOR UPDATE$/u, result: [[{ provider_id: "provider-1" }], []] },
    { pattern: /FROM correction_operations/u, result: [[], []] },
    { pattern: /^SELECT tenant_id, provider_id, current_provider_version/u, result: [[currentProvider], []] },
    { pattern: /^INSERT INTO provider_versions/u },
    { pattern: /^UPDATE providers/u },
    { pattern: /^INSERT INTO correction_events/u },
    {
      pattern: /^INSERT INTO correction_operations/u,
      result: ({ params }) => {
        persistedOperation = {
          operation_id: params[0],
          intent_hash: params[3],
          entity_type: params[4],
          entity_id: params[5],
          expected_version: params[6],
          correction_event_id: params[7],
          result_payload: params[8],
        };
        return [{ affectedRows: 1 }, []];
      },
    },
  ]);

  const created = await executeProviderCorrection(first, providerCorrectionValues());

  assert.equal(created.replayed, false);
  assert.equal(created.changed, true);
  assert.equal(created.version, 2);
  assert.equal(created.assessmentImpact, "NO_REASSESSMENT");
  assert.equal(created.replacementAssessments.length, 0);
  assert.match(created.correctionEventId, /^[0-9a-f-]{36}$/u);
  assert.match(created.operationId, /^[0-9a-f]{64}$/u);
  assert.match(first.calls[0].sql, /^SELECT provider_id FROM providers/u);
  assert.deepEqual(first.calls[0].params, ["tenant-alpha", "provider-1"]);
  assert.match(first.calls[1].sql, /FROM correction_operations/u);
  first.assertDone();

  const replayExecutor = scriptedExecutor([
    { pattern: /^SELECT provider_id FROM providers .* FOR UPDATE$/u, result: [[{ provider_id: "provider-1" }], []] },
    { pattern: /FROM correction_operations/u, result: [[persistedOperation], []] },
  ]);
  const replay = await executeProviderCorrection(
    replayExecutor,
    providerCorrectionValues({ correlationId: "request-provider-retry" }),
  );

  assert.deepEqual({ ...replay, replayed: false }, created);
  replayExecutor.assertDone();

  const conflictExecutor = scriptedExecutor([
    { pattern: /^SELECT provider_id FROM providers .* FOR UPDATE$/u, result: [[{ provider_id: "provider-1" }], []] },
    { pattern: /FROM correction_operations/u, result: [[persistedOperation], []] },
  ]);
  await assert.rejects(
    () => executeProviderCorrection(conflictExecutor, providerCorrectionValues({
      provider: { ...provider, specialty: "Different intent" },
    })),
    (error) => error instanceof AssessmentContextRepositoryError
      && error.code === "CORRECTION_IDEMPOTENCY_MISMATCH",
  );
  conflictExecutor.assertDone();
});

test("member identity corrections append review creation evidence", async () => {
  const current = {
    tenant_id: "tenant-alpha",
    member_id: "member-1",
    current_member_version: 1,
    scheme_id: "scheme-1",
    first_name: "René",
    last_name: "Member",
    date_of_birth: "1990-01-01",
    gender: "X",
    identity_number: "old-identity",
    banking_detail: "token:member-bank",
    home_region: "Gauteng",
    home_lat: -26.2,
    home_lon: 28,
    join_date: "2020-01-01",
  };
  const next = { ...current, identity_number: "corrected-identity" };
  let correctionEventId;
  let reviewId;
  const executor = scriptedExecutor([
    { pattern: /^SELECT tenant_id, member_id, current_member_version/u, result: [[current], []] },
    { pattern: /^INSERT INTO member_versions/u },
    { pattern: /^UPDATE members/u },
    {
      pattern: /^INSERT INTO correction_events/u,
      result: ({ params }) => {
        correctionEventId = params[0];
        return [{ affectedRows: 1 }, []];
      },
    },
    { pattern: /^SELECT a\.assessment_id/u, result: [[], []] },
    {
      pattern: /^INSERT INTO correction_impact_reviews/u,
      result: ({ params }) => {
        reviewId = params[0];
        return [{ affectedRows: 1 }, []];
      },
    },
    {
      pattern: /^INSERT INTO correction_impact_review_events/u,
      result: ({ params }) => {
        assert.equal(params[2], reviewId);
        assert.equal(params[3], "CREATED");
        assert.equal(params[7], 1);
        assert.equal(params[8], "user:submitter");
        return [{ affectedRows: 1 }, []];
      },
    },
  ]);

  const result = await persistMemberVersion(executor, {
    tenantId: "tenant-alpha",
    member: next,
    expectedVersion: 1,
    actorId: "user:submitter",
    reasonCode: "IDENTITY_CORRECTION",
    reasonSummary: "Verified identity correction.",
    correlationId: "request-member-1",
    correctionIdempotencyKey: "event-key-1",
    correctionIntentHash: "a".repeat(64),
  });

  assert.equal(result.correctionEventId, correctionEventId);
  assert.equal(result.classification.requiresHumanReview, true);
  assert.equal(result.version, 2);
  executor.assertDone();
});

function reviewRow(overrides = {}) {
  return {
    review_id: "review-1",
    correction_event_id: "correction-1",
    entity_type: "MEMBER",
    entity_id: "member-1",
    affected_assessment_id: "assessment-1",
    affected_signal_id: null,
    affected_case_id: null,
    review_reason: "IDENTITY_CORRECTION: Verify impact.",
    review_status: "PENDING",
    state_version: 1,
    assigned_to: null,
    created_at: "2026-08-01T00:00:00.000Z",
    reviewed_at: null,
    reviewed_by: null,
    review_result: null,
    previous_version: 1,
    new_version: 2,
    changed_fields: JSON.stringify(["identity_number"]),
    assessment_impact: "IDENTITY_REVIEW_REQUIRED",
    correction_actor_id: "user:submitter",
    ...overrides,
  };
}

function eventRow({ type, before, after, actor }) {
  return {
    review_event_id: `event-${after}`,
    review_id: "review-1",
    event_type: type,
    review_status_before: before === null ? null : before === 1 ? "PENDING" : "IN_REVIEW",
    review_status_after: after === 1 ? "PENDING" : after === 2 ? "IN_REVIEW" : "COMPLETED",
    state_version_before: before,
    state_version_after: after,
    actor_id: actor,
    correlation_id: `request-${after}`,
    event_payload: JSON.stringify({}),
    created_at: `2026-08-01T00:0${after}:00.000Z`,
  };
}

test("correction impact review enforces independence and returns immutable event history", async () => {
  const selfReview = scriptedExecutor([
    { pattern: /FROM correction_impact_reviews r JOIN correction_events e .* FOR UPDATE$/u, result: [[reviewRow()], []] },
  ]);
  await assert.rejects(
    () => claimCorrectionImpactReview(selfReview, {
      tenantId: "tenant-alpha",
      reviewId: "review-1",
      expectedStateVersion: 1,
      actorId: "user:submitter",
    }),
    (error) => error instanceof AssessmentContextRepositoryError
      && error.code === "CORRECTION_REVIEWER_NOT_INDEPENDENT"
      && error.status === 403,
  );
  selfReview.assertDone();

  const createdEvent = eventRow({ type: "CREATED", before: null, after: 1, actor: "user:submitter" });
  const claimedEvent = eventRow({ type: "CLAIMED", before: 1, after: 2, actor: "user:reviewer" });
  const claimExecutor = scriptedExecutor([
    { pattern: /FROM correction_impact_reviews r JOIN correction_events e .* FOR UPDATE$/u, result: [[reviewRow()], []] },
    { pattern: /^UPDATE correction_impact_reviews/u },
    { pattern: /^INSERT INTO correction_impact_review_events/u },
    {
      pattern: /FROM correction_impact_reviews r JOIN correction_events e .* LIMIT 1$/u,
      result: [[reviewRow({ review_status: "IN_REVIEW", state_version: 2, assigned_to: "user:reviewer" })], []],
    },
    { pattern: /FROM correction_impact_review_events/u, result: [[createdEvent, claimedEvent], []] },
  ]);
  const claimed = await claimCorrectionImpactReview(claimExecutor, {
    tenantId: "tenant-alpha",
    reviewId: "review-1",
    expectedStateVersion: 1,
    actorId: "user:reviewer",
    correlationId: "request-claim",
  });
  assert.equal(claimed.status, "IN_REVIEW");
  assert.deepEqual(claimed.events.map(({ eventType }) => eventType), ["CREATED", "CLAIMED"]);
  claimExecutor.assertDone();

  const completedEvent = eventRow({ type: "COMPLETED", before: 2, after: 3, actor: "user:reviewer" });
  const completeExecutor = scriptedExecutor([
    {
      pattern: /FROM correction_impact_reviews r JOIN correction_events e .* FOR UPDATE$/u,
      result: [[reviewRow({ review_status: "IN_REVIEW", state_version: 2, assigned_to: "user:reviewer" })], []],
    },
    { pattern: /^UPDATE correction_impact_reviews/u },
    { pattern: /^INSERT INTO correction_impact_review_events/u },
    {
      pattern: /FROM correction_impact_reviews r JOIN correction_events e .* LIMIT 1$/u,
      result: [[reviewRow({
        review_status: "COMPLETED",
        state_version: 3,
        assigned_to: "user:reviewer",
        reviewed_by: "user:reviewer",
        review_result: JSON.stringify({
          disposition: "FOLLOW_UP_REQUIRED",
          summary: "Independent follow-up is required.",
          evidenceReferences: ["evidence-1"],
        }),
      })], []],
    },
    { pattern: /FROM correction_impact_review_events/u, result: [[createdEvent, claimedEvent, completedEvent], []] },
  ]);
  const completed = await completeCorrectionImpactReview(completeExecutor, {
    tenantId: "tenant-alpha",
    reviewId: "review-1",
    expectedStateVersion: 2,
    actorId: "user:reviewer",
    correlationId: "request-complete",
    reviewResult: {
      disposition: "FOLLOW_UP_REQUIRED",
      summary: "Independent follow-up is required.",
      evidenceReferences: ["evidence-1"],
    },
  });
  assert.equal(completed.status, "COMPLETED");
  assert.equal(completed.events.length, 3);
  completeExecutor.assertDone();
});

test("correction review reads are tenant scoped and validation fails before mutation", async () => {
  const listExecutor = scriptedExecutor([
    { pattern: /FROM correction_impact_reviews r JOIN correction_events e .* WHERE/u, result: [[reviewRow()], []] },
  ]);
  const listed = await listCorrectionImpactReviews(listExecutor, {
    tenantId: "tenant-alpha",
    status: "pending",
    limit: 500,
  });
  assert.equal(listed.length, 1);
  assert.equal(listed[0].correctionActorId, "user:submitter");
  assert.equal(listExecutor.calls[0].params[0], "tenant-alpha");
  listExecutor.assertDone();

  await assert.rejects(
    () => listCorrectionImpactReviews({ execute: async () => assert.fail("must not query") }, {
      tenantId: "tenant-alpha",
      status: "invalid",
    }),
    (error) => error.code === "CORRECTION_REVIEW_STATUS_INVALID",
  );

  const notFoundExecutor = scriptedExecutor([
    { pattern: /FROM correction_impact_reviews r JOIN correction_events e .* LIMIT 1$/u, result: [[], []] },
  ]);
  await assert.rejects(
    () => getCorrectionImpactReview(notFoundExecutor, {
      tenantId: "tenant-foreign",
      reviewId: "review-1",
    }),
    (error) => error.code === "CORRECTION_REVIEW_NOT_FOUND",
  );
  notFoundExecutor.assertDone();

  for (const reviewResult of [null, { disposition: "invalid", summary: "x" }, {
    disposition: "FOLLOW_UP_REQUIRED",
    summary: "",
  }, {
    disposition: "FOLLOW_UP_REQUIRED",
    summary: "x",
    evidenceReferences: ["x".repeat(256)],
  }]) {
    await assert.rejects(
      () => completeCorrectionImpactReview({ execute: async () => assert.fail("must not query") }, {
        tenantId: "tenant-alpha",
        reviewId: "review-1",
        expectedStateVersion: 2,
        actorId: "user:reviewer",
        reviewResult,
      }),
      (error) => error.code === "CORRECTION_REVIEW_RESULT_INVALID",
    );
  }
});

const sourceAssessment = Object.freeze({
  assessment_id: "assessment-source",
  tenant_id: "tenant-alpha",
  claim_id: "claim-1",
  claim_version: 1,
  member_id: "member-1",
  member_version: 2,
  provider_id: "provider-1",
  provider_version: 3,
  detection_strategy_id: 17,
  strategy_type: "deterministic_rules",
  model_deployment_id: null,
  provenance_status: "COMPLETE",
});

test("explicit reassessment creates one pinned assessment job and replays it", async () => {
  let assessmentId;
  let jobId;
  let persistedOperation;
  const executor = scriptedExecutor([
    { pattern: /^SELECT assessment_id, tenant_id, claim_id/u, result: [[sourceAssessment], []] },
    { pattern: /FROM reassessment_operations/u, result: [[], []] },
    {
      pattern: /^SELECT claim_id, claim_version, member_id, provider_id, claim_payload/u,
      result: [[{
        claim_id: "claim-1",
        claim_version: 1,
        member_id: "member-1",
        provider_id: "provider-1",
        claim_payload: JSON.stringify({ claim_id: "claim-1", amount: 100 }),
      }], []],
    },
    { pattern: /FROM member_versions mv/u, result: [[{
      member_id: "member-1", member_version: 2, scheme_id: "scheme-1",
      first_name: "René", last_name: "Member", date_of_birth: "1990-01-01",
      gender: "X", identity_number: "identity-1", banking_detail: "secret",
      home_region: "Gauteng", home_lat: -26.2, home_lon: 28, join_date: "2020-01-01",
    }], []] },
    { pattern: /FROM provider_versions pv/u, result: [[{
      provider_id: "provider-1", provider_version: 3, scheme_id: "scheme-1",
      practice_number: "practice-1", specialty: "General", practice_name: "Practice",
      banking_detail: "secret", practice_region: "Gauteng", practice_lat: -26.2,
      practice_lon: 28, provider_kind: "PRACTICE", provider_category: "GENERAL",
    }], []] },
    {
      pattern: /^INSERT INTO assessment_versions/u,
      result: ({ params }) => {
        assessmentId = params[0];
        assert.equal(params[17], "assessment-source");
        assert.doesNotMatch(params[15], /secret/u);
        return [{ affectedRows: 1 }, []];
      },
    },
    {
      pattern: /^INSERT INTO claim_processing_outbox/u,
      result: ({ params }) => {
        jobId = params[0];
        assert.equal(params[1], assessmentId);
        return [{ affectedRows: 1 }, []];
      },
    },
    {
      pattern: /^SELECT id, assessment_id, correlation_id, status FROM claim_processing_outbox/u,
      result: () => [[{
        id: jobId,
        assessment_id: assessmentId,
        correlation_id: "request-reassess",
        status: "pending",
      }], []],
    },
    {
      pattern: /^INSERT INTO reassessment_operations/u,
      result: ({ params }) => {
        persistedOperation = {
          operation_id: params[0],
          intent_hash: params[3],
          assessment_id: params[4],
          result_payload: params[5],
        };
        return [{ affectedRows: 1 }, []];
      },
    },
  ]);

  const created = await requestAssessmentReassessment(executor, {
    tenantId: "tenant-alpha",
    sourceAssessmentId: "assessment-source",
    idempotencyKey: "reassessment-1",
    createdBy: "user:requester",
    source: "api:reassessment:requester",
    correlationId: "request-reassess",
  });
  assert.deepEqual(created, {
    operationId: persistedOperation.operation_id,
    sourceAssessmentId: "assessment-source",
    assessmentId,
    jobId,
    status: "pending",
    replayed: false,
  });
  executor.assertDone();

  const replayExecutor = scriptedExecutor([
    { pattern: /^SELECT assessment_id, tenant_id, claim_id/u, result: [[sourceAssessment], []] },
    { pattern: /FROM reassessment_operations/u, result: [[persistedOperation], []] },
  ]);
  const replay = await requestAssessmentReassessment(replayExecutor, {
    tenantId: "tenant-alpha",
    sourceAssessmentId: "assessment-source",
    idempotencyKey: "reassessment-1",
    createdBy: "user:requester",
    source: "api:reassessment:requester",
    correlationId: "request-retry",
  });
  assert.deepEqual({ ...replay, replayed: false }, created);
  replayExecutor.assertDone();
});

test("reassessment validation and persisted provenance fail closed", async () => {
  await assert.rejects(
    () => requestAssessmentReassessment({ execute: async () => assert.fail("must not query") }, {
      tenantId: "tenant-alpha",
      sourceAssessmentId: "assessment-source",
      idempotencyKey: " ",
    }),
    (error) => error.code === "MISSING_IDEMPOTENCY_KEY",
  );

  const missing = scriptedExecutor([
    { pattern: /^SELECT assessment_id, tenant_id, claim_id/u, result: [[], []] },
  ]);
  await assert.rejects(
    () => requestAssessmentReassessment(missing, {
      tenantId: "tenant-alpha",
      sourceAssessmentId: "missing",
      idempotencyKey: "reassessment-missing",
    }),
    (error) => error.code === "ASSESSMENT_NOT_FOUND",
  );
  missing.assertDone();

  const incomplete = scriptedExecutor([
    {
      pattern: /^SELECT assessment_id, tenant_id, claim_id/u,
      result: [[{ ...sourceAssessment, provenance_status: "LEGACY_PARTIAL" }], []],
    },
  ]);
  await assert.rejects(
    () => requestAssessmentReassessment(incomplete, {
      tenantId: "tenant-alpha",
      sourceAssessmentId: "assessment-source",
      idempotencyKey: "reassessment-incomplete",
    }),
    (error) => error.code === "ASSESSMENT_REASSESSMENT_PROVENANCE_INCOMPLETE",
  );
  incomplete.assertDone();

  const mismatch = scriptedExecutor([
    { pattern: /^SELECT assessment_id, tenant_id, claim_id/u, result: [[sourceAssessment], []] },
    { pattern: /FROM reassessment_operations/u, result: [[{
      operation_id: "operation-1",
      intent_hash: sha256CanonicalJson({
        tenantId: "tenant-alpha",
        operation: "EXPLICIT_REASSESSMENT",
        sourceAssessmentId: "assessment-other",
      }),
      assessment_id: "assessment-other",
      result_payload: JSON.stringify({
        sourceAssessmentId: "assessment-other",
        assessmentId: "replacement-other",
        jobId: "job-other",
      }),
    }], []] },
  ]);
  await assert.rejects(
    () => requestAssessmentReassessment(mismatch, {
      tenantId: "tenant-alpha",
      sourceAssessmentId: "assessment-source",
      idempotencyKey: "reassessment-conflict",
    }),
    (error) => error.code === "ASSESSMENT_REASSESSMENT_IDEMPOTENCY_MISMATCH",
  );
  mismatch.assertDone();
});

test("review event projection parses immutable payloads", async () => {
  const executor = scriptedExecutor([
    { pattern: /FROM correction_impact_review_events/u, result: [[{
      ...eventRow({ type: "CREATED", before: null, after: 1, actor: "user:submitter" }),
      event_payload: Buffer.from(JSON.stringify({ correctionEventId: "correction-1" })),
    }], []] },
  ]);
  const events = await listCorrectionImpactReviewEvents(executor, {
    tenantId: "tenant-alpha",
    reviewId: "review-1",
  });
  assert.deepEqual(events[0].payload, { correctionEventId: "correction-1" });
  executor.assertDone();
});
