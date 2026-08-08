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
        actorId: "user:correction-reviewer",
        reasonCode: "IDENTITY_CORRECTION",
        reasonSummary: "Verified member identity correction.",
        sourceReference: `evidence:${suffix}`,
        source: "api:correction:correction-reviewer",
        correlationId: `member-${suffix}`,
      };

      const firstMember = await inTransaction(
        pool,
        (connection) => executeMemberCorrection(connection, memberValues),
      );
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

      const claimed = await inTransaction(
        pool,
        (connection) => claimCorrectionImpactReview(connection, {
          tenantId: "tenant_default",
          reviewId: review.reviewId,
          expectedStateVersion: 1,
          actorId: "user:correction-reviewer",
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
          actorId: "user:correction-reviewer",
          reviewResult: {
            disposition: "FOLLOW_UP_REQUIRED",
            summary: "Identity evidence requires governed follow-up.",
            evidenceReferences: [`evidence:${suffix}`],
          },
        }),
      );
      assert.equal(completed.status, "COMPLETED");
      assert.equal(completed.stateVersion, 3);
      assert.equal(completed.reviewResult.disposition, "FOLLOW_UP_REQUIRED");

      const provider = fixture.providers[0];
      const providerKey = `provider-noop-${suffix}`;
      const providerValues = {
        tenantId: "tenant_default",
        provider,
        expectedVersion: 1,
        idempotencyKey: providerKey,
        actorId: "user:correction-reviewer",
        reasonCode: "PROVIDER_CORRECTION",
        reasonSummary: "Provider correction command.",
        sourceReference: null,
        source: "api:correction:correction-reviewer",
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
