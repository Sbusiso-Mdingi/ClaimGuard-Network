import assert from "node:assert/strict";
import test from "node:test";

import {
  createInvestigationRepository,
  INVESTIGATION_STATUS,
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

function createFakePool({ claims = [] } = {}) {
  const claimRows = new Map(claims.map((claim) => [`${claim.tenant_id}:${claim.claim_id}`, claim]));
  const investigations = new Map();
  const notes = [];
  const evidence = [];

  return {
    investigations,
    notes,
    evidence,
    async execute(sql, params = []) {
      const statement = String(sql).replace(/\s+/g, " ").trim();

      if (statement.includes("SELECT claim_id FROM claims")) {
        const [claimId, tenantId] = params;
        const claim = claimRows.get(`${tenantId}:${claimId}`);
        return [claim ? [{ claim_id: claim.claim_id }] : []];
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
          created_at: timestamp,
          updated_at: timestamp,
          closed_at: null,
          fraud_confirmed_at: null,
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
        const [status, priority, _closedStatus, investigationId, tenantId] = params;
        const investigation = investigations.get(investigationId);
        if (!investigation || investigation.tenant_id !== tenantId) {
          return [{ affectedRows: 0 }];
        }

        investigation.status = status;
        investigation.priority = priority;
        investigation.updated_at = new Date().toISOString();
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
        const [evidenceId, investigationId, tenantId, filename, description, uploadedBy, evidenceType] = params;
        evidence.push({
          evidence_id: evidenceId,
          investigation_id: investigationId,
          tenant_id: tenantId,
          filename,
          description,
          uploaded_by: uploadedBy,
          uploaded_at: new Date().toISOString(),
          evidence_type: evidenceType,
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
    ...overrides,
  });
}

test("investigation repository creates an OPEN investigation for an active-tenant claim", async () => {
  const pool = createFakePool({
    claims: [{ claim_id: "claim-alpha-1", tenant_id: "tenant_alpha" }],
  });
  const repository = createInvestigationRepository(pool);

  await runWithTenantContext(tenantContext("tenant_alpha"), async () => {
    const investigation = await createTestInvestigation(repository);

    assert.equal(investigation.tenantId, "tenant_alpha");
    assert.equal(investigation.claimId, "claim-alpha-1");
    assert.equal(investigation.assignedInvestigator, "investigator-alpha");
    assert.equal(investigation.assignedBy, "analyst-alpha");
    assert.equal(investigation.status, INVESTIGATION_STATUS.OPEN);
    assert.equal(investigation.priority, "HIGH");
    assert.ok(investigation.createdAt);
    assert.ok(investigation.updatedAt);
  });
});

test("investigation repository permits the defined investigation workflow transitions", async () => {
  const pool = createFakePool({
    claims: [{ claim_id: "claim-alpha-1", tenant_id: "tenant_alpha" }],
  });
  const repository = createInvestigationRepository(pool);

  await runWithTenantContext(tenantContext("tenant_alpha"), async () => {
    const created = await createTestInvestigation(repository);
    const underReview = await repository.updateInvestigation({
      investigationId: created.investigationId,
      status: "under review",
    });
    const awaitingEvidence = await repository.updateInvestigation({
      investigationId: created.investigationId,
      status: "AWAITING_EVIDENCE",
    });
    const resumedReview = await repository.updateInvestigation({
      investigationId: created.investigationId,
      status: "UNDER_REVIEW",
    });
    const confirmed = await repository.updateInvestigation({
      investigationId: created.investigationId,
      status: "CONFIRMED_FRAUD",
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
  const repository = createInvestigationRepository(pool);

  await runWithTenantContext(tenantContext("tenant_alpha"), async () => {
    const created = await createTestInvestigation(repository);

    await assert.rejects(
      () =>
        repository.updateInvestigation({
          investigationId: created.investigationId,
          status: INVESTIGATION_STATUS.CONFIRMED_FRAUD,
        }),
      (error) => error instanceof InvestigationValidationError && error.code === "invalid_status_transition",
    );
  });
});

test("investigation repository stores note and evidence metadata with the investigation", async () => {
  const pool = createFakePool({
    claims: [{ claim_id: "claim-alpha-1", tenant_id: "tenant_alpha" }],
  });
  const repository = createInvestigationRepository(pool);

  await runWithTenantContext(tenantContext("tenant_alpha"), async () => {
    const created = await createTestInvestigation(repository);
    const note = await repository.addNote({
      investigationId: created.investigationId,
      author: "analyst-alpha",
      text: "Provider invoice and member interview disagree.",
      noteType: "medical review",
    });
    const registeredEvidence = await repository.registerEvidence({
      investigationId: created.investigationId,
      filename: "member-interview.pdf",
      description: "Interview record supplied by the member.",
      uploadedBy: "investigator-alpha",
      evidenceType: "interview transcript",
    });
    const details = await repository.getInvestigationDetails(created.investigationId);

    assert.equal(note.noteType, "MEDICAL_REVIEW");
    assert.equal(registeredEvidence.evidenceType, "INTERVIEW_TRANSCRIPT");
    assert.equal(details.notes.length, 1);
    assert.equal(details.notes[0].text, "Provider invoice and member interview disagree.");
    assert.equal(details.evidence.length, 1);
    assert.equal(details.evidence[0].filename, "member-interview.pdf");
    assert.equal(details.evidence[0].uploadedBy, "investigator-alpha");
  });
});

test("investigation repository prevents another tenant from reading or attaching records", async () => {
  const pool = createFakePool({
    claims: [{ claim_id: "claim-alpha-1", tenant_id: "tenant_alpha" }],
  });
  const repository = createInvestigationRepository(pool);
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
        }),
      InvestigationNotFoundError,
    );
    await assert.rejects(
      () =>
        repository.registerEvidence({
          investigationId,
          filename: "foreign.pdf",
          uploadedBy: "investigator-beta",
          evidenceType: "document",
        }),
      InvestigationNotFoundError,
    );
  });

  assert.equal(pool.notes.length, 0);
  assert.equal(pool.evidence.length, 0);
});
