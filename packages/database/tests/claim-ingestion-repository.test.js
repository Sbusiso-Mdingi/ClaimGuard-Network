import assert from "node:assert/strict";
import test from "node:test";

import {
  ClaimModelSelectionUnavailableError,
  ClaimOwnershipConflictError,
  ClaimReferenceValidationError,
  createClaimIngestionRepository,
  ReferenceOwnershipConflictError,
  runWithTenantContext,
} from "../src/index.js";
import { createClaimIngestionMemoryPool } from "../test-support/claim-ingestion-memory-pool.js";

function modelClaimFields() {
  return {
    received_date: "2026-07-20",
    quantity: 1,
    benefit_option: "COMPREHENSIVE",
    network_type: "IN_NETWORK",
    line_type: "PROFESSIONAL",
    tariff_discipline: "MEDICAL",
    diagnosis_code: "Z00.0",
    rendering_practitioner_id: null,
    rendering_practitioner_category: "NONE",
    rendering_known_to_billing_provider: false,
  };
}

function claimInput({
  claimId = "C-100",
  amount = 233.19,
  schemeId = "scheme_a",
  memberId = "M-1",
  providerId = "P-1",
} = {}) {
  return {
    claim_id: claimId,
    scheme_id: schemeId,
    member_id: memberId,
    provider_id: providerId,
    service_date: "2026-07-20",
    billing_code: "CONSULT",
    amount,
    ...modelClaimFields(),
  };
}

test(
  "new claims create immutable version one and a prospective scoring job",
  async () => {
    const pool = createClaimIngestionMemoryPool();
    const repository = createClaimIngestionRepository(pool, {
      allowLegacyTenantContext: true,
    });

    const result = await repository.ingestClaims({
      source: "upstream-connector",
      correlationId: "request-100",
      claims: [claimInput()],
    });

    assert.equal(result.received, 1);
    assert.equal(result.inserted, 1);
    assert.equal(result.updated, 0);
    assert.equal(result.unchanged, 0);
    assert.equal(result.versioned, 1);
    assert.equal(result.processing.status, "queued");
    assert.equal(result.processing.asynchronous, true);
    assert.equal(result.processing.reused, false);

    const claim = pool.claims.get("C-100");
    assert.equal(claim.current_claim_version, 1);
    assert.equal(claim.tenant_id, "tenant_default");

    const version = pool.claimVersions.get("tenant_default:C-100:1");
    assert.equal(version.version_reason, "initial_submission");
    assert.match(version.payload_hash, /^[a-f0-9]{64}$/);

    assert.equal(pool.assessments.size, 1);
    assert.equal(pool.outbox.size, 1);
    const job = [...pool.outbox.values()][0];
    assert.equal(job.job_type, "claim_detection");
    assert.equal(job.strategy_type, "deterministic_rules");
    assert.equal(job.detection_strategy_id, 1);
    assert.equal(result.processing.assessmentId, job.assessment_id);
    assert.equal(pool.assessments.get(job.assessment_id).provenance_status, "COMPLETE");
    assert.deepEqual(JSON.parse(job.payload), {
      schema_version: 3,
      dataset_scope: "assessment_version",
      assessment_id: job.assessment_id,
      source: "upstream-connector",
      targets: [{ claim_id: "C-100", claim_version: 1 }],
    });

    const lockIndex = pool.executions.findIndex(({ sql }) =>
      sql.includes("FROM claim_processing_outbox WHERE id = ? LIMIT 1 FOR UPDATE"));
    const deleteIndex = pool.executions.findIndex(({ sql }) =>
      sql.startsWith("DELETE FROM claim_processing_outbox"));
    const assessmentIndex = pool.executions.findIndex(({ sql }) =>
      sql.startsWith("INSERT INTO assessment_versions"));
    const pinnedJobIndex = pool.executions.findIndex(({ sql }) =>
      sql.startsWith("INSERT INTO claim_processing_outbox")
      && sql.includes("id, assessment_id, tenant_id"));

    assert.ok(lockIndex >= 0);
    assert.ok(deleteIndex > lockIndex);
    assert.ok(assessmentIndex > deleteIndex);
    assert.ok(pinnedJobIndex > assessmentIndex);
    assert.equal(pool.commitCount, 1);
  },
);

test(
  "ingestion rejects an active model that is no longer approved",
  async () => {
    const pool = createClaimIngestionMemoryPool({
      activeStrategy: {
        id: 2,
        strategy_type: "approved_model",
        model_deployment_id: "retired-model:1.0.0",
      },
    });
    const repository = createClaimIngestionRepository(pool, {
      allowLegacyTenantContext: true,
      approvedModelDeploymentIds: "current-model:2.0.0",
    });

    await assert.rejects(
      () => repository.ingestClaims({
        source: "upstream-connector",
        claims: [claimInput()],
      }),
      (error) => (
        error instanceof ClaimModelSelectionUnavailableError
        && error.code === "CLAIM_MODEL_SELECTION_UNAVAILABLE"
        && error.status === 409
      ),
    );
    assert.equal(pool.claims.size, 0);
    assert.equal(pool.outbox.size, 0);
    assert.equal(pool.rollbackCount, 1);
  },
);

test(
  "reference data and claims are committed in one authoritative batch",
  async () => {
    const pool = createClaimIngestionMemoryPool({ seedReferences: false });
    const repository = createClaimIngestionRepository(pool, {
      allowLegacyTenantContext: true,
    });

    const result = await repository.ingestClaims({
      source: "medical-aid-desktop",
      schemes: [{ scheme_id: "scheme_a", scheme_name: "Scheme A" }],
      members: [{
        member_id: "M-1",
        scheme_id: "scheme_a",
        first_name: "token:first",
        last_name: "token:last",
        date_of_birth: "1985-01-01",
        gender: "unspecified",
        identity_number: "token:identity",
        banking_detail: "token:member-bank",
        home_region: "Gauteng",
        home_lat: -26.2,
        home_lon: 28,
        join_date: "2020-01-01",
      }],
      providers: [{
        provider_id: "P-1",
        scheme_id: "scheme_a",
        practice_number: "practice-1",
        specialty: "GP",
        practice_name: "Practice 1",
        banking_detail: "token:provider-bank",
        practice_region: "Gauteng",
        practice_lat: -26.2,
        practice_lon: 28,
        provider_kind: "INDIVIDUAL",
        provider_category: "GENERAL_PRACTITIONER",
      }],
      claims: [claimInput({ claimId: "C-REFERENCE" })],
    });

    assert.deepEqual(result.referenceData, {
      schemes: { received: 1, inserted: 1, updated: 0 },
      members: { received: 1, inserted: 1, updated: 0 },
      providers: { received: 1, inserted: 1, updated: 0 },
    });
    assert.equal(result.inserted, 1);
    assert.equal(result.processing.status, "queued");
    assert.equal(pool.references.schemes.get("scheme_a").tenant_id, "tenant_default");
    assert.deepEqual(pool.medicalSchemes.get("tenant_default:scheme_a"), {
      tenant_id: "tenant_default",
      scheme_id: "scheme_a",
      scheme_name: "Scheme A",
      is_primary: 1,
    });
    assert.equal(pool.memberVersions.size, 1);
    assert.equal(pool.providerVersions.size, 1);
    assert.equal(pool.assessments.size, 1);
    assert.equal(pool.commitCount, 1);
  },
);

test(
  "ingestion fails closed when the tenant has no active detection strategy",
  async () => {
    const pool = createClaimIngestionMemoryPool({ activeStrategy: null });
    const repository = createClaimIngestionRepository(pool, {
      allowLegacyTenantContext: true,
    });
    await assert.rejects(
      () => repository.ingestClaims({ claims: [claimInput()] }),
      /no active detection strategy/i,
    );
    assert.equal(pool.claims.size, 0);
    assert.equal(pool.claimVersions.size, 0);
    assert.equal(pool.outbox.size, 0);
    assert.equal(pool.rollbackCount, 1);
  },
);

test(
  "required claim fields are validated before opening a transaction",
  async () => {
    const pool = createClaimIngestionMemoryPool();
    const repository = createClaimIngestionRepository(pool, {
      allowLegacyTenantContext: true,
    });
    await assert.rejects(
      () => repository.ingestClaims({
        claims: [{ claim_id: "C-INCOMPLETE", scheme_id: "scheme_a" }],
      }),
      /member_id is required/i,
    );
    assert.equal(pool.executions.length, 0);
  },
);

test(
  "reference identifiers remain immutable across tenants",
  async () => {
    const pool = createClaimIngestionMemoryPool({ tenantId: "tenant_beta" });
    const repository = createClaimIngestionRepository(pool, {
      allowLegacyTenantContext: true,
    });
    await assert.rejects(
      () => runWithTenantContext(
        { tenant_id: "tenant_alpha" },
        () => repository.ingestClaims({
          schemes: [{ scheme_id: "scheme_a", scheme_name: "Scheme A" }],
          claims: [claimInput()],
        }),
      ),
      ReferenceOwnershipConflictError,
    );
    assert.equal(pool.rollbackCount, 1);
    assert.equal(pool.claims.size, 0);
  },
);

test(
  "identical retries create no artificial claim version or second job",
  async () => {
    const pool = createClaimIngestionMemoryPool({ tenantId: "tenant_alpha" });
    const repository = createClaimIngestionRepository(pool, {
      allowLegacyTenantContext: true,
    });

    const first = await runWithTenantContext(
      { tenant_id: "tenant_alpha" },
      () => repository.ingestClaims({
        source: "api",
        correlationId: "request-1",
        claims: [claimInput({ claimId: "C-IDEMPOTENT" })],
      }),
    );
    const retry = await runWithTenantContext(
      { tenant_id: "tenant_alpha" },
      () => repository.ingestClaims({
        source: "api",
        correlationId: "request-2",
        claims: [claimInput({ claimId: "C-IDEMPOTENT" })],
      }),
    );

    assert.equal(first.inserted, 1);
    assert.equal(first.versioned, 1);
    assert.equal(retry.inserted, 0);
    assert.equal(retry.updated, 0);
    assert.equal(retry.unchanged, 1);
    assert.equal(retry.versioned, 0);
    assert.deepEqual(retry.processing, {
      status: "not_queued",
      asynchronous: false,
      jobId: null,
      correlationId: "request-2",
      reused: false,
      skipped: true,
      reason: "no_claim_changes",
    });
    assert.equal(pool.claimVersions.size, 1);
    assert.equal(pool.assessments.size, 1);
    assert.equal(pool.outbox.size, 1);
  },
);

test(
  "changed claims create an immutable amendment and a second prospective job",
  async () => {
    const pool = createClaimIngestionMemoryPool({ tenantId: "tenant_alpha" });
    const repository = createClaimIngestionRepository(pool, {
      allowLegacyTenantContext: true,
    });

    await runWithTenantContext(
      { tenant_id: "tenant_alpha" },
      () => repository.ingestClaims({
        claims: [claimInput({ claimId: "C-AMENDMENT", amount: 100 })],
      }),
    );
    const amendment = await runWithTenantContext(
      { tenant_id: "tenant_alpha" },
      () => repository.ingestClaims({
        claims: [claimInput({ claimId: "C-AMENDMENT", amount: 125 })],
      }),
    );

    assert.equal(amendment.inserted, 0);
    assert.equal(amendment.updated, 1);
    assert.equal(amendment.unchanged, 0);
    assert.equal(amendment.versioned, 1);
    assert.equal(pool.claims.get("C-AMENDMENT").current_claim_version, 2);
    assert.equal(pool.claims.get("C-AMENDMENT").amount, "125.00");
    assert.equal(pool.claimVersions.size, 2);
    assert.equal(
      pool.claimVersions.get("tenant_alpha:C-AMENDMENT:2").version_reason,
      "claim_amendment",
    );
    assert.equal(pool.assessments.size, 2);
    assert.equal(pool.outbox.size, 2);
    const targets = [...pool.outbox.values()]
      .map((row) => JSON.parse(row.payload).targets[0])
      .sort((left, right) => left.claim_version - right.claim_version);
    assert.deepEqual(targets, [
      { claim_id: "C-AMENDMENT", claim_version: 1 },
      { claim_id: "C-AMENDMENT", claim_version: 2 },
    ]);
  },
);

test(
  "claim identifiers cannot be reassigned to another tenant",
  async () => {
    const pool = createClaimIngestionMemoryPool({ tenantId: "tenant_alpha" });
    const repository = createClaimIngestionRepository(pool, {
      allowLegacyTenantContext: true,
    });

    await runWithTenantContext(
      { tenant_id: "tenant_alpha" },
      () => repository.ingestClaims({ claims: [claimInput({ claimId: "C-OWNED" })] }),
    );
    pool.setReferenceTenant("tenant_beta");
    await assert.rejects(
      () => runWithTenantContext(
        { tenant_id: "tenant_beta" },
        () => repository.ingestClaims({
          claims: [claimInput({ claimId: "C-OWNED", amount: 999 })],
        }),
      ),
      ClaimOwnershipConflictError,
    );
    assert.equal(pool.claims.get("C-OWNED").tenant_id, "tenant_alpha");
    assert.equal(pool.claims.get("C-OWNED").amount, "233.19");
    assert.equal(pool.outbox.size, 1);
    assert.equal(pool.rollbackCount, 1);
  },
);

test(
  "outbox enqueue failure rolls back the claim and its immutable version",
  async () => {
    const pool = createClaimIngestionMemoryPool({
      tenantId: "tenant_alpha",
      failOutboxInsert: true,
    });
    const repository = createClaimIngestionRepository(pool, {
      allowLegacyTenantContext: true,
    });
    await assert.rejects(
      () => runWithTenantContext(
        { tenant_id: "tenant_alpha" },
        () => repository.ingestClaims({ claims: [claimInput()] }),
      ),
      /outbox insert failed/i,
    );
    assert.equal(pool.claims.size, 0);
    assert.equal(pool.claimVersions.size, 0);
    assert.equal(pool.assessments.size, 0);
    assert.equal(pool.outbox.size, 0);
    assert.equal(pool.rollbackCount, 1);
  },
);

test(
  "claim insert failure creates neither a claim version nor an outbox job",
  async () => {
    const pool = createClaimIngestionMemoryPool({
      tenantId: "tenant_alpha",
      failClaimInsert: true,
    });
    const repository = createClaimIngestionRepository(pool, {
      allowLegacyTenantContext: true,
    });
    await assert.rejects(
      () => runWithTenantContext(
        { tenant_id: "tenant_alpha" },
        () => repository.ingestClaims({ claims: [claimInput()] }),
      ),
      /claim insert failed/i,
    );
    assert.equal(pool.claims.size, 0);
    assert.equal(pool.claimVersions.size, 0);
    assert.equal(pool.outbox.size, 0);
    assert.equal(pool.rollbackCount, 1);
  },
);

test(
  "claim references cannot cross tenant boundaries",
  async () => {
    const pool = createClaimIngestionMemoryPool({ tenantId: "tenant_alpha" });
    const repository = createClaimIngestionRepository(pool, {
      allowLegacyTenantContext: true,
    });
    await assert.rejects(
      () => runWithTenantContext(
        { tenant_id: "tenant_beta" },
        () => repository.ingestClaims({
          claims: [claimInput({ claimId: "C-CROSS-TENANT" })],
        }),
      ),
      ClaimReferenceValidationError,
    );
    assert.equal(pool.claims.size, 0);
    assert.equal(pool.claimVersions.size, 0);
    assert.equal(pool.outbox.size, 0);
    assert.equal(pool.rollbackCount, 1);
  },
);
