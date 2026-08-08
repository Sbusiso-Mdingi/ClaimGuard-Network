import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";

import {
  applyMigrations,
  AssessmentContextRepositoryError,
  claimCorrectionImpactReview,
  completeCorrectionImpactReview,
  createMysqlConnection,
  createOperationalRepositories,
  executeMemberCorrection,
  executeProviderCorrection,
  getCorrectionImpactReview,
  listCorrectionImpactReviewEvents,
  listCorrectionImpactReviews,
  listMemberVersions,
  listProviderVersions,
} from "../src/index.js";
import {
  legacyDataPlaneContext,
  legacyFixture,
} from "../test-support/legacy-first-access-fixture.js";

const databaseUrl = process.env.OPERATIONAL_TEST_MYSQL_URL || "";

async function inTransaction(pool, operation) {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const result = await operation(connection);
    await connection.commit();
    return result;
  } catch (error) {
    try { await connection.rollback(); } catch { /* preserve original */ }
    throw error;
  } finally {
    connection.release();
  }
}

async function countRows(pool, table) {
  const [rows] = await pool.execute(`SELECT COUNT(*) AS total FROM ${table}`);
  return Number(rows[0].total);
}

test(
  "real MySQL corrections are idempotent, stale-writer guarded, version-readable and review-governed",
  { skip: !databaseUrl },
  async () => {
    const pool = createMysqlConnection(databaseUrl);
    try {
      await applyMigrations(pool, undefined, { applicationVersion: "assessment-correction-test" });
      const repositories = createOperationalRepositories(legacyDataPlaneContext(), pool);
      const suffix = `RC${crypto.randomUUID().replaceAll("-", "").slice(0, 10)}`;
      const fixture = legacyFixture(suffix);
      await repositories.claims.ingestClaims({
        claims: fixture.claims,
        schemes: fixture.schemes,
        members: fixture.members,
        providers: fixture.providers,
        source: "assessment-correction-mysql-test",
        correlationId: `ingest-${suffix}`,
      });

      const governanceBefore = {
        cases: await countRows(pool, "investigation_cases"),
        transitions: await countRows(pool, "case_transition_events"),
        registry: await countRows(pool, "shared_fraud_registry_entries"),
      };
      const member = {
        ...fixture.members[0],
        identity_number: `${fixture.members[0].identity_number}-CORRECTED`,
      };
      const memberKey = `member-correction-${suffix}`;
      const memberValues = {
        tenantId: "tenant_default",
        member,
        expectedVersion: 1,
        idempotencyKey: memberKey,
        actorId: "user:correction-submitter",
        reasonCode: "IDENTITY_CORRECTION",
        reasonSummary: "Verified member identity correction.",
        sourceReference: `evidence:${suffix}`,
        source: "api:correction:correction-submitter",
        correlationId: `member-${suffix}`,
      };

      const rollbackTables = [
        "member_versions",
        "correction_events",
        "correction_impact_reviews",
        "correction_impact_review_events",
        "correction_operations",
        "assessment_versions",
        "claim_processing_outbox",
      ];
      const rollbackBefore = Object.fromEntries(await Promise.all(
        rollbackTables.map(async (table) => [table, await countRows(pool, table)]),
      ));
      await assert.rejects(
        () => inTransaction(pool, async (connection) => {
          await executeMemberCorrection(connection, {
            ...memberValues,
            idempotencyKey: `member-rollback-${suffix}`,
            correlationId: `member-rollback-${suffix}`,
          });
          throw new Error("injected correction transaction failure");
        }),
        /injected correction transaction failure/,
      );
      for (const table of rollbackTables) {
        assert.equal(await countRows(pool, table), rollbackBefore[table], `${table} must roll back`);
      }
      const [rolledBackMemberRows] = await pool.execute(
        "SELECT current_member_version FROM members WHERE tenant_id = ? AND member_id = ?",
        ["tenant_default", member.member_id],
      );
      assert.equal(Number(rolledBackMemberRows[0].current_member_version), 1);

      const concurrent = await Promise.allSettled([
        inTransaction(pool, (connection) => executeMemberCorrection(connection, memberValues)),
        inTransaction(pool, (connection) => executeMemberCorrection(connection, {
          ...memberValues,
          correlationId: `member-concurrent-retry-${suffix}`,
        })),
      ]);
      assert.deepEqual(concurrent.map(({ status }) => status), ["fulfilled", "fulfilled"]);
      const concurrentResults = concurrent.map(({ value }) => value);
      const firstMember = concurrentResults.find(({ replayed }) => replayed === false);
      const concurrentReplay = concurrentResults.find(({ replayed }) => replayed === true);
      assert.ok(firstMember);
      assert.ok(concurrentReplay);
      assert.deepEqual({ ...concurrentReplay, replayed: false }, firstMember);
      assert.equal(firstMember.replayed, false);
      assert.equal(firstMember.changed, true);
      assert.equal(firstMember.version, 2);
      assert.match(firstMember.operationId, /^[0-9a-f]{64}$/);
      assert.match(firstMember.correctionEventId, /^[0-9a-f-]{36}$/);
      assert.equal(firstMember.assessmentImpact, "IDENTITY_REVIEW_REQUIRED");
      assert.equal(firstMember.replacementAssessments.length, 1);

      const replayedMember = await inTransaction(
        pool,
        (connection) => executeMemberCorrection(connection, {
          ...memberValues,
          correlationId: `member-retry-${suffix}`,
        }),
      );
      assert.equal(replayedMember.replayed, true);
      assert.deepEqual(
        { ...replayedMember, replayed: false },
        firstMember,
      );

      await assert.rejects(
        () => inTransaction(
          pool,
          (connection) => executeMemberCorrection(connection, {
            ...memberValues,
            member: { ...member, last_name: "Different intent" },
          }),
        ),
        (error) => error instanceof AssessmentContextRepositoryError
          && error.code === "CORRECTION_IDEMPOTENCY_MISMATCH",
      );
      await assert.rejects(
        () => inTransaction(
          pool,
          (connection) => executeMemberCorrection(connection, {
            ...memberValues,
            idempotencyKey: `stale-member-${suffix}`,
          }),
        ),
        (error) => error instanceof AssessmentContextRepositoryError
          && error.code === "MEMBER_STALE_VERSION"
          && error.details.currentVersion === 2,
      );

      const memberVersions = await listMemberVersions(pool, {
        tenantId: "tenant_default",
        memberId: member.member_id,
      });
      assert.deepEqual(memberVersions.map((entry) => entry.version), [2, 1]);
      assert.equal(memberVersions[0].isCurrent, true);
      assert.equal(Object.hasOwn(memberVersions[0], "bankingDetail"), false);

      const pendingReviews = await listCorrectionImpactReviews(pool, {
        tenantId: "tenant_default",
        status: "PENDING",
      });
      const review = pendingReviews.find(
        (entry) => entry.correctionEventId === firstMember.correctionEventId,
      );
      assert.ok(review);
      assert.equal(review.stateVersion, 1);
      assert.equal(review.correctionActorId, "user:correction-submitter");

      await assert.rejects(
        () => getCorrectionImpactReview(pool, {
          tenantId: "tenant_foreign",
          reviewId: review.reviewId,
        }),
        (error) => error instanceof AssessmentContextRepositoryError
          && error.code === "CORRECTION_REVIEW_NOT_FOUND",
      );
      await assert.rejects(
        () => inTransaction(
          pool,
          (connection) => claimCorrectionImpactReview(connection, {
            tenantId: "tenant_default",
            reviewId: review.reviewId,
            expectedStateVersion: 1,
            actorId: "user:correction-submitter",
            correlationId: `review-self-${suffix}`,
          }),
        ),
        (error) => error instanceof AssessmentContextRepositoryError
          && error.code === "CORRECTION_REVIEWER_NOT_INDEPENDENT",
      );

      const claimed = await inTransaction(
        pool,
        (connection) => claimCorrectionImpactReview(connection, {
          tenantId: "tenant_default",
          reviewId: review.reviewId,
          expectedStateVersion: 1,
          actorId: "user:impact-reviewer",
          correlationId: `review-claim-${suffix}`,
        }),
      );
      assert.equal(claimed.status, "IN_REVIEW");
      assert.equal(claimed.stateVersion, 2);

      await assert.rejects(
        () => inTransaction(
          pool,
          (connection) => claimCorrectionImpactReview(connection, {
            tenantId: "tenant_default",
            reviewId: review.reviewId,
            expectedStateVersion: 1,
            actorId: "user:other-reviewer",
            correlationId: `review-stale-${suffix}`,
          }),
        ),
        (error) => error instanceof AssessmentContextRepositoryError
          && error.code === "CORRECTION_REVIEW_VERSION_CONFLICT",
      );
      await assert.rejects(
        () => inTransaction(
          pool,
          (connection) => completeCorrectionImpactReview(connection, {
            tenantId: "tenant_default",
            reviewId: review.reviewId,
            expectedStateVersion: 2,
            actorId: "user:other-reviewer",
            reviewResult: { disposition: "FOLLOW_UP_REQUIRED", summary: "Escalate." },
            correlationId: `review-wrong-actor-${suffix}`,
          }),
        ),
        (error) => error instanceof AssessmentContextRepositoryError
          && error.code === "CORRECTION_REVIEW_STATE_CONFLICT",
      );

      const completed = await inTransaction(
        pool,
        (connection) => completeCorrectionImpactReview(connection, {
          tenantId: "tenant_default",
          reviewId: review.reviewId,
          expectedStateVersion: 2,
          actorId: "user:impact-reviewer",
          reviewResult: {
            disposition: "FOLLOW_UP_REQUIRED",
            summary: "Identity evidence requires governed follow-up.",
            evidenceReferences: [`evidence:${suffix}`],
          },
          correlationId: `review-complete-${suffix}`,
        }),
      );
      assert.equal(completed.status, "COMPLETED");
      assert.equal(completed.stateVersion, 3);
      assert.equal(completed.reviewResult.disposition, "FOLLOW_UP_REQUIRED");
      assert.deepEqual(completed.events.map((event) => ({
        type: event.eventType,
        before: event.stateVersionBefore,
        after: event.stateVersionAfter,
        actor: event.actorId,
      })), [
        { type: "CREATED", before: null, after: 1, actor: "user:correction-submitter" },
        { type: "CLAIMED", before: 1, after: 2, actor: "user:impact-reviewer" },
        { type: "COMPLETED", before: 2, after: 3, actor: "user:impact-reviewer" },
      ]);
      const reviewEvents = await listCorrectionImpactReviewEvents(pool, {
        tenantId: "tenant_default",
        reviewId: review.reviewId,
      });
      assert.deepEqual(reviewEvents, completed.events);
      await assert.rejects(
        () => pool.execute(
          "UPDATE correction_impact_review_events SET event_type = 'CLAIMED' WHERE review_event_id = ?",
          [reviewEvents[0].reviewEventId],
        ),
        /CORRECTION_REVIEW_EVENT_IMMUTABLE/,
      );
      await assert.rejects(
        () => pool.execute(
          "DELETE FROM correction_impact_review_events WHERE review_event_id = ?",
          [reviewEvents[0].reviewEventId],
        ),
        /CORRECTION_REVIEW_EVENT_IMMUTABLE/,
      );

      const provider = fixture.providers[0];
      const providerKey = `provider-noop-${suffix}`;
      const providerValues = {
        tenantId: "tenant_default",
        provider,
        expectedVersion: 1,
        idempotencyKey: providerKey,
        actorId: "user:correction-submitter",
        reasonCode: "PROVIDER_CORRECTION",
        reasonSummary: "Provider correction command.",
        sourceReference: null,
        source: "api:correction:correction-submitter",
        correlationId: `provider-${suffix}`,
      };
      const providerNoop = await inTransaction(
        pool,
        (connection) => executeProviderCorrection(connection, providerValues),
      );
      assert.equal(providerNoop.changed, false);
      assert.equal(providerNoop.version, 1);
      assert.equal(providerNoop.correctionEventId, null);
      const providerReplay = await inTransaction(
        pool,
        (connection) => executeProviderCorrection(connection, providerValues),
      );
      assert.equal(providerReplay.replayed, true);
      assert.equal(providerReplay.operationId, providerNoop.operationId);

      const changedProvider = await inTransaction(
        pool,
        (connection) => executeProviderCorrection(connection, {
          ...providerValues,
          provider: { ...provider, specialty: "UPDATED_GENERAL" },
          idempotencyKey: `provider-change-${suffix}`,
        }),
      );
      assert.equal(changedProvider.changed, true);
      assert.equal(changedProvider.version, 2);
      await assert.rejects(
        () => inTransaction(
          pool,
          (connection) => executeProviderCorrection(connection, {
            ...providerValues,
            idempotencyKey: `provider-stale-${suffix}`,
          }),
        ),
        (error) => error instanceof AssessmentContextRepositoryError
          && error.code === "PROVIDER_STALE_VERSION",
      );
      const providerVersions = await listProviderVersions(pool, {
        tenantId: "tenant_default",
        providerId: provider.provider_id,
      });
      assert.deepEqual(providerVersions.map((entry) => entry.version), [2, 1]);
      assert.equal(Object.hasOwn(providerVersions[0], "bankingDetail"), false);

      assert.deepEqual({
        cases: await countRows(pool, "investigation_cases"),
        transitions: await countRows(pool, "case_transition_events"),
        registry: await countRows(pool, "shared_fraud_registry_entries"),
      }, governanceBefore);
    } finally {
      await pool.end();
    }
  },
);
