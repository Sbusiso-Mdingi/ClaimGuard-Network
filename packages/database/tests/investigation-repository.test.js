import assert from "node:assert/strict";
import test from "node:test";

import {
  createInvestigationRepository,
  INVESTIGATION_STATUS,
  InvestigationConflictError,
  InvestigationNotFoundError,
  InvestigationValidationError,
  runWithTenantContext,
} from "../src/index.js";

function tenantContext(tenantId) {
  return {
    tenant_id: tenantId,
    tenant_slug: tenantId.replace("tenant_", ""),
    scheme_id: null,
    source: "test",
  };
}

function createFakePool({ claims = [], rejectVersionedUpdate = false } = {}) {
  const claimRows = new Map(claims.map((claim) => [`${claim.tenant_id}:${claim.claim_id}`, claim]));
  const investigations = new Map();
  const notes = [];
  const evidence = [];
  const activity = [];

  return {
    investigations,
    notes,
    evidence,
    activity,
    async execute(sql, params = []) {
      const statement = String(sql).replace(/\s+/g, " ").trim();

      if (statement.includes("SELECT claim_id, current_claim_version FROM claims")) {
        const [claimId, tenantId] = params;
        const claim = claimRows.get(`${tenantId}:${claimId}`);
        return [claim ? [{ claim_id: claim.claim_id, current_claim_version: claim.current_claim_version || 1 }] : []];
      }

      if (statement.includes("INSERT INTO investigations")) {
        const [investigationId, tenantId, claimId, assignedInvestigator, assignedBy, status, priority] = params;
        const timestamp = new Date().toISOString();
        investigations.set(investigationId, {
          investigation_id: investigationId,
          tenant_id: tenantId,
          claim_id: claimId,
          assigned_investigator: assignedInvestigator,
          assigned_by: assignedBy,
          status,
          priority,
          record_version: 1,
          created_at: timestamp,
          updated_at: timestamp,
          closed_at: null,
          fraud_confirmed_at: null,
        });
        return [{ affectedRows: 1 }];
      }

      if (statement.includes("INSERT INTO investigation_activity_events")) {
        const [activityEventId, tenantId, investigationId, actorId, action, beforeSummary, afterSummary, correlationId] = params;
        activity.push({
          activity_event_id: activityEventId,
          tenant_id: tenantId,
          investigation_id: investigationId,
          actor_id: actorId,
          action,
          before_summary: beforeSummary,
          after_summary: afterSummary,
          correlation_id: correlationId,
          occurred_at: new Date().toISOString(),
        });
        return [{ affectedRows: 1 }];
      }

      if (statement.includes("FROM investigation_notes")) {
        const [investigationId, tenantId] = params;
        return [
          notes
            .filter((note) => note.investigation_id === investigationId && note.tenant_id === tenantId)
            .map((note) => ({ ...note })),
        ];
      }

      if (statement.includes("FROM investigation_evidence")) {
        const [investigationId, tenantId] = params;
        return [
          evidence
            .filter((item) => item.investigation_id === investigationId && item.tenant_id === tenantId)
            .map((item) => ({ ...item })),
        ];
      }

      if (statement.includes("FROM investigation_activity_events")) {
        const [investigationId, tenantId] = params;
        return [activity.filter((item) => item.investigation_id === investigationId && item.tenant_id === tenantId)];
      }

      if (statement.includes("FROM investigations")) {
        const [investigationId, tenantId] = params;
        const investigation = investigations.get(investigationId);
        return [
          investigation && investigation.tenant_id === tenantId ? [{ ...investigation }] : [],
        ];
      }

      if (statement.includes("UPDATE investigations") && statement.includes("SET fraud_confirmed_at")) {
        const [investigationId, tenantId] = params;
        const investigation = investigations.get(investigationId);
        if (!investigation || investigation.tenant_id !== tenantId || investigation.fraud_confirmed_at) {
          return [{ affectedRows: 0 }];
        }

        investigation.fraud_confirmed_at = new Date().toISOString();
        investigation.updated_at = investigation.fraud_confirmed_at;
        return [{ affectedRows: 1 }];
      }

      if (statement.includes("UPDATE investigations")) {
        if (statement.includes("SET record_version = record_version + 1")) {
          const [investigationId, tenantId, expectedRecordVersion] = params;
          const investigation = investigations.get(investigationId);
          if (!investigation || investigation.tenant_id !== tenantId || rejectVersionedUpdate
            || investigation.record_version !== expectedRecordVersion) {
            return [{ affectedRows: 0 }];
          }
          investigation.record_version += 1;
          investigation.updated_at = new Date(new Date(investigation.updated_at).getTime() + 1).toISOString();
          return [{ affectedRows: 1 }];
        }
        const [status, priority, assignedInvestigator, _closedStatus, investigationId, tenantId, expectedRecordVersion] = params;
        const investigation = investigations.get(investigationId);
        if (!investigation || investigation.tenant_id !== tenantId || rejectVersionedUpdate
          || investigation.record_version !== expectedRecordVersion) {
          return [{ affectedRows: 0 }];
        }

        investigation.status = status;
        investigation.priority = priority;
        investigation.assigned_investigator = assignedInvestigator;
        investigation.record_version += 1;
        investigation.updated_at = new Date(new Date(investigation.updated_at).getTime() + 1).toISOString();
        if (status === INVESTIGATION_STATUS.CLOSED && !investigation.closed_at) {
          investigation.closed_at = investigation.updated_at;
        }
        return [{ affectedRows: 1 }];
      }

      if (statement.includes("INSERT INTO investigation_notes")) {
        const [noteId, investigationId, tenantId, author, text, noteType] = params;
        notes.push({
          note_id: noteId,
          investigation_id: investigationId,
          tenant_id: tenantId,
          author,
          note_text: text,
          note_type: noteType,
          created_at: new Date().toISOString(),
        });
        return [{ affectedRows: 1 }];
      }

      if (statement.includes("INSERT INTO investigation_evidence")) {
        const [evidenceId, investigationId, tenantId, filename, description, uploadedBy, evidenceType,
          contentType, byteSize, contentSha256, storageObjectKey] = params;
        evidence.push({
          evidence_id: evidenceId,
          investigation_id: investigationId,
          tenant_id: tenantId,
          filename,
          description,
          uploaded_by: uploadedBy,
          uploaded_at: new Date().toISOString(),
          evidence_type: evidenceType,
          content_type: contentType,
          byte_size: byteSize,
          content_sha256: contentSha256,
          storage_object_key: storageObjectKey,
        });
        return [{ affectedRows: 1 }];
      }

      throw new Error(`Unexpected investigation repository query: ${statement}`);
    },
  };
}

async function createTestInvestigation(repository, overrides = {}) {
  return repository.createInvestigation({
    claimId: "claim-alpha-1",
    assignedInvestigator: "investigator-alpha",
    assignedBy: "analyst-alpha",
    priority: "high",
    expectedClaimVersion: 1,
    ...overrides,
  });
}

test("investigation repository creates an OPEN investigation for an active-tenant claim", async () => {
  const pool = createFakePool({
    claims: [{ claim_id: "claim-alpha-1", tenant_id: "tenant_alpha" }],
  });
  const repository = createInvestigationRepository(pool, { allowLegacyTenantContext: true });

  await runWithTenantContext(tenantContext("tenant_alpha"), async () => {
    const investigation = await createTestInvestigation(repository);

    assert.equal(investigation.tenantId, "tenant_alpha");
    assert.equal(investigation.claimId, "claim-alpha-1");
    assert.equal(investigation.assignedInvestigator, "investigator-alpha");
    assert.equal(investigation.assignedBy, "analyst-alpha");
    assert.equal(investigation.status, INVESTIGATION_STATUS.OPEN);
    assert.equal(investigation.priority, "HIGH");
    assert.equal(investigation.recordVersion, 1);
    assert.ok(investigation.createdAt);
    assert.ok(investigation.updatedAt);
  });
});

test("investigation repository permits the defined investigation workflow transitions", async () => {
  const pool = createFakePool({
    claims: [{ claim_id: "claim-alpha-1", tenant_id: "tenant_alpha" }],
  });
  const repository = createInvestigationRepository(pool, { allowLegacyTenantContext: true });

  await runWithTenantContext(tenantContext("tenant_alpha"), async () => {
    const created = await createTestInvestigation(repository);
    const underReview = await repository.updateInvestigation({
      investigationId: created.investigationId,
      status: "under review",
      expectedRecordVersion: 1,
      actorId: "investigator-alpha",
    });
    const awaitingEvidence = await repository.updateInvestigation({
      investigationId: created.investigationId,
      status: "AWAITING_EVIDENCE",
      expectedRecordVersion: 2,
      actorId: "investigator-alpha",
    });
    const resumedReview = await repository.updateInvestigation({
      investigationId: created.investigationId,
      status: "UNDER_REVIEW",
      expectedRecordVersion: 3,
      actorId: "investigator-alpha",
    });
    const confirmed = await repository.updateInvestigation({
      investigationId: created.investigationId,
      status: "CONFIRMED_FRAUD",
      expectedRecordVersion: 4,
      actorId: "investigator-alpha",
    });

    assert.equal(underReview.status, INVESTIGATION_STATUS.UNDER_REVIEW);
    assert.equal(awaitingEvidence.status, INVESTIGATION_STATUS.AWAITING_EVIDENCE);
    assert.equal(resumedReview.status, INVESTIGATION_STATUS.UNDER_REVIEW);
    assert.equal(confirmed.status, INVESTIGATION_STATUS.CONFIRMED_FRAUD);
  });
});

test("investigation repository rejects invalid status transitions", async () => {
  const pool = createFakePool({
    claims: [{ claim_id: "claim-alpha-1", tenant_id: "tenant_alpha" }],
  });
  const repository = createInvestigationRepository(pool, { allowLegacyTenantContext: true });

  await runWithTenantContext(tenantContext("tenant_alpha"), async () => {
    const created = await createTestInvestigation(repository);

    await assert.rejects(
      () =>
        repository.updateInvestigation({
          investigationId: created.investigationId,
          status: INVESTIGATION_STATUS.CONFIRMED_FRAUD,
          expectedRecordVersion: created.recordVersion,
          actorId: "investigator-alpha",
        }),
      (error) => error instanceof InvestigationValidationError && error.code === "invalid_status_transition",
    );
  });
});

test("investigation repository rejects stale versions before and during a conditional update", async () => {
  const pool = createFakePool({
    claims: [{ claim_id: "claim-alpha-1", tenant_id: "tenant_alpha" }],
  });
  const repository = createInvestigationRepository(pool, { allowLegacyTenantContext: true });

  await runWithTenantContext(tenantContext("tenant_alpha"), async () => {
    const created = await createTestInvestigation(repository);
    await repository.updateInvestigation({
      investigationId: created.investigationId,
      priority: "CRITICAL",
      expectedRecordVersion: created.recordVersion,
      actorId: "analyst-alpha",
    });
    await assert.rejects(
      () => repository.updateInvestigation({
        investigationId: created.investigationId,
        priority: "LOW",
        expectedRecordVersion: created.recordVersion,
        actorId: "analyst-alpha",
      }),
      (error) => error instanceof InvestigationConflictError && error.code === "stale_record_version",
    );
  });

  const racingPool = createFakePool({
    claims: [{ claim_id: "claim-alpha-1", tenant_id: "tenant_alpha" }],
    rejectVersionedUpdate: true,
  });
  const racingRepository = createInvestigationRepository(racingPool, { allowLegacyTenantContext: true });
  await runWithTenantContext(tenantContext("tenant_alpha"), async () => {
    const created = await createTestInvestigation(racingRepository);
    await assert.rejects(
      () => racingRepository.updateInvestigation({
        investigationId: created.investigationId,
        priority: "CRITICAL",
        expectedRecordVersion: created.recordVersion,
        actorId: "analyst-alpha",
      }),
      (error) => error instanceof InvestigationConflictError && error.code === "stale_record_version",
    );
  });
});

test("investigation repository stores note and evidence metadata with the investigation", async () => {
  const pool = createFakePool({
    claims: [{ claim_id: "claim-alpha-1", tenant_id: "tenant_alpha" }],
  });
  const repository = createInvestigationRepository(pool, { allowLegacyTenantContext: true });

  await runWithTenantContext(tenantContext("tenant_alpha"), async () => {
    const created = await createTestInvestigation(repository);
    const noteResult = await repository.addNote({
      investigationId: created.investigationId,
      author: "analyst-alpha",
      text: "Provider invoice and member interview disagree.",
      noteType: "medical review",
      expectedRecordVersion: created.recordVersion,
    });
    const evidenceResult = await repository.registerEvidence({
      evidenceId: "evidence-alpha-1",
      investigationId: created.investigationId,
      filename: "member-interview.pdf",
      description: "Interview record supplied by the member.",
      uploadedBy: "investigator-alpha",
      evidenceType: "interview transcript",
      contentType: "application/pdf",
      byteSize: 128,
      contentSha256: "a".repeat(64),
      storageObjectKey: "tenant_alpha/investigations/evidence-alpha-1",
      expectedRecordVersion: noteResult.investigation.recordVersion,
    });
    const details = await repository.getInvestigationDetails(created.investigationId);

    assert.equal(noteResult.note.noteType, "MEDICAL_REVIEW");
    assert.equal(evidenceResult.evidence.evidenceType, "INTERVIEW_TRANSCRIPT");
    assert.equal(evidenceResult.evidence.contentSha256, "a".repeat(64));
    assert.equal(details.notes.length, 1);
    assert.equal(details.notes[0].text, "Provider invoice and member interview disagree.");
    assert.equal(details.evidence.length, 1);
    assert.equal(details.evidence[0].filename, "member-interview.pdf");
    assert.equal(details.evidence[0].uploadedBy, "investigator-alpha");
    assert.equal(details.activity.length, 3);
  });
});

test("investigation repository prevents another tenant from reading or attaching records", async () => {
  const pool = createFakePool({
    claims: [{ claim_id: "claim-alpha-1", tenant_id: "tenant_alpha" }],
  });
  const repository = createInvestigationRepository(pool, { allowLegacyTenantContext: true });
  let investigationId;

  await runWithTenantContext(tenantContext("tenant_alpha"), async () => {
    investigationId = (await createTestInvestigation(repository)).investigationId;
  });

  await runWithTenantContext(tenantContext("tenant_beta"), async () => {
    assert.equal(await repository.getInvestigationById(investigationId), null);

    await assert.rejects(
      () =>
        repository.addNote({
          investigationId,
          author: "analyst-beta",
          text: "This tenant must not be able to add a note.",
          expectedRecordVersion: 1,
        }),
      InvestigationNotFoundError,
    );
    await assert.rejects(
      () =>
        repository.registerEvidence({
          evidenceId: "foreign-evidence",
          investigationId,
          filename: "foreign.pdf",
          uploadedBy: "investigator-beta",
          evidenceType: "document",
          contentType: "application/pdf",
          byteSize: 32,
          contentSha256: "b".repeat(64),
          storageObjectKey: "tenant_beta/foreign-evidence",
          expectedRecordVersion: 1,
        }),
      InvestigationNotFoundError,
    );
  });

  assert.equal(pool.notes.length, 0);
  assert.equal(pool.evidence.length, 0);
});
