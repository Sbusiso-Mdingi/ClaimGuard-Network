import assert from "node:assert/strict";
import test from "node:test";

import {
  ClaimOwnershipConflictError,
  ClaimReferenceValidationError,
  createClaimIngestionRepository,
  ReferenceOwnershipConflictError,
  runWithTenantContext,
} from "../src/index.js";

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

function createFakePool({ tenantId = "tenant_default" } = {}) {
  const executions = [];
  let outboxRow = null;

  return {
    executions,
    async getConnection() {
      return {
        async beginTransaction() {},
        async execute(sql, params) {
          executions.push({ sql, params });
          if (/SELECT tenant_id, claim_version FROM claims/i.test(sql) || /SELECT tenant_id FROM claims/i.test(sql)) {
            return [[]];
          }
          if (/SELECT id, strategy_type, model_deployment_id FROM detection_strategies WHERE tenant_id = \? AND is_active = 1/i.test(sql)) {
            return [[{ id: 1, strategy_type: "deterministic_rules", model_deployment_id: null }]];
          }
          if (/SELECT tenant_id FROM schemes/i.test(sql)) {
            return [[{ tenant_id: tenantId }]];
          }
          if (/SELECT tenant_id, scheme_id FROM members/i.test(sql)) {
            return [[{ tenant_id: tenantId, scheme_id: "scheme_a" }]];
          }
          if (/SELECT tenant_id, scheme_id FROM providers/i.test(sql)) {
            return [[{ tenant_id: tenantId, scheme_id: "scheme_a" }]];
          }
          if (/INSERT INTO claim_processing_outbox/i.test(sql)) {
            const [id, tenant_id, job_type, aggregate_type, aggregate_id, correlation_id, idempotency_key, payload, max_attempts, detection_strategy_id, strategy_type, model_deployment_id] = params;
            outboxRow = {
              id,
              tenant_id,
              job_type,
              aggregate_type,
              aggregate_id,
              correlation_id,
              idempotency_key,
              payload,
              status: "pending",
              attempt_count: 0,
              max_attempts,
              detection_strategy_id,
              strategy_type,
              model_deployment_id,
            };
            return [{ affectedRows: 1 }];
          }
          if (/FROM claim_processing_outbox/i.test(sql)) {
            return [[outboxRow]];
          }
          return [{ affectedRows: 1 }];
        },
        async commit() {},
        async rollback() {},
        release() {},
      };
    },
  };
}

test("claim ingestion repository inserts claims through transaction", async () => {
  const pool = createFakePool();
  const repository = createClaimIngestionRepository(pool, { allowLegacyTenantContext: true });

  const result = await repository.ingestClaims({
    source: "upstream-connector",
    claims: [
      {
        claim_id: "C-100",
        scheme_id: "scheme_a",
        member_id: "M-1",
        provider_id: "P-1",
        service_date: "2025-01-15",
        ...modelClaimFields(),
        billing_code: "CONSULT",
        amount: 233.19,
      },
    ],
  });

  assert.equal(result.received, 1);
  assert.equal(result.inserted, 1);
  assert.equal(result.updated, 0);
  assert.equal(result.source, "upstream-connector");
  assert.equal(result.processing.status, "queued");
  assert.equal(result.processing.asynchronous, true);
  assert.equal(pool.executions.length, 9);
  assert.match(pool.executions[5].sql, /INSERT INTO claims/i);
  assert.equal(pool.executions[5].params.at(-1), "tenant_default");
  assert.match(pool.executions[7].sql, /INSERT INTO claim_processing_outbox/i);
  assert.equal(pool.executions[7].params[1], "tenant_default");
});

test("reference data and claims are accepted in one authoritative batch", async () => {
  const pool = createFakePool();
  const repository = createClaimIngestionRepository(pool, { allowLegacyTenantContext: true });

  const result = await repository.ingestClaims({
    source: "medical-aid-desktop",
    schemes: [{ scheme_id: "scheme_a", scheme_name: "Scheme A" }],
    members: [{
      member_id: "M-1", scheme_id: "scheme_a", first_name: "token:first", last_name: "token:last",
      date_of_birth: "1985-01-01", gender: "unspecified", identity_number: "token:identity",
      banking_detail: "token:member-bank", home_region: "Gauteng", home_lat: -26.2,
      home_lon: 28.0, join_date: "2020-01-01",
    }],
    providers: [{
      provider_id: "P-1", scheme_id: "scheme_a", practice_number: "practice-1", specialty: "GP",
      practice_name: "Practice 1", banking_detail: "token:provider-bank", practice_region: "Gauteng",
      practice_lat: -26.2, practice_lon: 28.0,
      provider_kind: "INDIVIDUAL", provider_category: "GENERAL_PRACTITIONER",
    }],
    claims: [{
      claim_id: "C-REFERENCE", scheme_id: "scheme_a", member_id: "M-1", provider_id: "P-1",
      service_date: "2026-07-19", billing_code: "CONSULT", amount: 450,
      ...modelClaimFields(),
    }],
  });

  assert.deepEqual(result.referenceData, {
    schemes: { received: 1, inserted: 0, updated: 1 },
    members: { received: 1, inserted: 1, updated: 0 },
    providers: { received: 1, inserted: 1, updated: 0 },
  });
  assert.equal(result.inserted, 1);
  assert.equal(result.processing.status, "queued");
  assert.equal(pool.executions.some(({ sql }) => /INSERT INTO members/i.test(sql)), true);
  assert.equal(pool.executions.some(({ sql }) => /INSERT INTO providers/i.test(sql)), true);
});

test("reference identifiers remain immutable across tenants", async () => {
  let rolledBack = false;
  const pool = {
    async getConnection() {
      return {
        async beginTransaction() {},
        async execute(sql) {
          if (/SELECT id, strategy_type, model_deployment_id FROM detection_strategies WHERE tenant_id = \? AND is_active = 1/i.test(sql)) {
            return [[{ id: 1, strategy_type: "deterministic_rules", model_deployment_id: null }]];
          }
          if (/SELECT tenant_id FROM schemes/i.test(sql)) return [[{ tenant_id: "tenant_beta" }]];
          throw new Error(`Unexpected SQL: ${sql}`);
        },
        async commit() {},
        async rollback() { rolledBack = true; },
        release() {},
      };
    },
  };
  const repository = createClaimIngestionRepository(pool, { allowLegacyTenantContext: true });

  await assert.rejects(
    () => runWithTenantContext({ tenant_id: "tenant_alpha" }, () => repository.ingestClaims({
      schemes: [{ scheme_id: "scheme_a", scheme_name: "Scheme A" }],
      claims: [{
        claim_id: "C-1", scheme_id: "scheme_a", member_id: "M-1", provider_id: "P-1",
        service_date: "2026-07-19", billing_code: "CONSULT", amount: 450,
        ...modelClaimFields(),
      }],
    })),
    ReferenceOwnershipConflictError,
  );
  assert.equal(rolledBack, true);
});

test("claim ingestion repository validates required fields", async () => {
  const pool = createFakePool();
  const repository = createClaimIngestionRepository(pool, { allowLegacyTenantContext: true });

  await assert.rejects(
    () =>
      repository.ingestClaims({
        claims: [
          {
            claim_id: "C-101",
            scheme_id: "scheme_a",
          },
        ],
      }),
    /missing required fields/i,
  );
});

test("claim ingestion repository persists tenant_id from active tenant context", async () => {
  const pool = createFakePool({ tenantId: "tenant_alpha" });
  const repository = createClaimIngestionRepository(pool, { allowLegacyTenantContext: true });

  await runWithTenantContext(
    {
      tenant_id: "tenant_alpha",
      tenant_slug: "alpha",
      scheme_id: null,
      source: "header",
    },
    async () => {
      await repository.ingestClaims({
        source: "api",
        claims: [
          {
            claim_id: "C-102",
            scheme_id: "scheme_a",
            member_id: "M-2",
            provider_id: "P-2",
            service_date: "2025-01-16",
            ...modelClaimFields(),
            billing_code: "XRAY",
            amount: 100.0,
          },
        ],
      });
    },
  );

  assert.equal(pool.executions.length, 9);
  assert.equal(pool.executions[5].params.at(-1), "tenant_alpha");
  assert.match(pool.executions[5].sql, /tenant_id/i);
  assert.equal(pool.executions[7].params[1], "tenant_alpha");
});

function createStatefulClaimPool({ failClaimInsert = false, failOutboxInsert = false } = {}) {
  const claims = new Map();
  const outbox = new Map();
  let rollbackCount = 0;

  return {
    claims,
    outbox,
    get rollbackCount() {
      return rollbackCount;
    },
    async getConnection() {
      let transactionSnapshot = null;
      let outboxSnapshot = null;
      return {
        async beginTransaction() {
          transactionSnapshot = new Map([...claims].map(([id, claim]) => [id, { ...claim }]));
          outboxSnapshot = new Map([...outbox].map(([id, job]) => [id, { ...job }]));
        },
        async execute(sql, params) {
          if (/SELECT tenant_id, claim_version FROM claims/i.test(sql) || /SELECT tenant_id FROM claims/i.test(sql)) {
            const claim = claims.get(params[0]);
            return [claim ? [{ tenant_id: claim.tenant_id, claim_version: claim.claim_version }] : []];
          }
          if (/SELECT id, strategy_type, model_deployment_id FROM detection_strategies WHERE tenant_id = \? AND is_active = 1/i.test(sql)) {
            return [[{ id: 1, strategy_type: "deterministic_rules", model_deployment_id: null }]];
          }
          if (/SELECT tenant_id FROM schemes/i.test(sql)) {
            return [[{ tenant_id: "tenant_alpha" }]];
          }
          if (/SELECT tenant_id, scheme_id FROM members/i.test(sql)) {
            return [[{ tenant_id: "tenant_alpha", scheme_id: "scheme_a" }]];
          }
          if (/SELECT tenant_id, scheme_id FROM providers/i.test(sql)) {
            return [[{ tenant_id: "tenant_alpha", scheme_id: "scheme_a" }]];
          }
          if (/INSERT INTO claims/i.test(sql)) {
            if (failClaimInsert) {
              throw new Error("claim insert failed");
            }
            const [
              claim_id, claim_version, scheme_id, member_id, provider_id, service_date,
              received_date, billing_code, amount, quantity, benefit_option,
              network_type, line_type, tariff_discipline, diagnosis_code,
              rendering_practitioner_id, rendering_practitioner_category,
              rendering_known_to_billing_provider, tenant_id,
            ] = params;
            if (claims.has(claim_id)) {
              const error = new Error("duplicate");
              error.code = "ER_DUP_ENTRY";
              throw error;
            }
            claims.set(claim_id, {
              claim_id, scheme_id, member_id, provider_id, service_date,
              received_date, billing_code, amount, quantity, benefit_option,
              network_type, line_type, tariff_discipline, diagnosis_code,
              rendering_practitioner_id, rendering_practitioner_category,
              rendering_known_to_billing_provider, tenant_id, claim_version,
            });
            return [{ affectedRows: 1 }];
          }
          if (/INSERT INTO claim_versions/i.test(sql)) {
             return [{ affectedRows: 1 }];
          }
          if (/UPDATE claims/i.test(sql)) {
            const [
              claim_version, scheme_id, member_id, provider_id, service_date, received_date,
              billing_code, amount, quantity, benefit_option, network_type,
              line_type, tariff_discipline, diagnosis_code,
              rendering_practitioner_id, rendering_practitioner_category,
              rendering_known_to_billing_provider, claim_id, tenant_id,
            ] = params;
            const existing = claims.get(claim_id);
            if (existing?.tenant_id === tenant_id) {
              claims.set(claim_id, {
                ...existing, scheme_id, member_id, provider_id, service_date,
                received_date, billing_code, amount, quantity, benefit_option,
                network_type, line_type, tariff_discipline, diagnosis_code,
                rendering_practitioner_id, rendering_practitioner_category,
                rendering_known_to_billing_provider, claim_version,
              });
              return [{ affectedRows: 1 }];
            }
            return [{ affectedRows: 0 }];
          }
          if (/INSERT INTO claim_processing_outbox/i.test(sql)) {
            if (failOutboxInsert) {
              throw new Error("outbox insert failed");
            }
            const [id, tenant_id, job_type, aggregate_type, aggregate_id, correlation_id, idempotency_key, payload, max_attempts, detection_strategy_id, strategy_type, model_deployment_id] = params;
            const key = `${tenant_id}:${idempotency_key}`;
            if (!outbox.has(key)) {
              outbox.set(key, {
                id,
                tenant_id,
                job_type,
                aggregate_type,
                aggregate_id,
                correlation_id,
                idempotency_key,
                payload,
                status: "pending",
                attempt_count: 0,
                max_attempts,
                detection_strategy_id,
                strategy_type,
                model_deployment_id,
              });
              return [{ affectedRows: 1 }];
            }
            return [{ affectedRows: 0 }];
          }
          if (/FROM claim_processing_outbox/i.test(sql)) {
            return [[outbox.get(`${params[0]}:${params[1]}`)].filter(Boolean)];
          }
          throw new Error(`Unexpected SQL: ${sql}`);
        },
        async commit() {
          transactionSnapshot = null;
        },
        async rollback() {
          rollbackCount += 1;
          claims.clear();
          for (const [id, claim] of transactionSnapshot || []) claims.set(id, claim);
          outbox.clear();
          for (const [id, job] of outboxSnapshot || []) outbox.set(id, job);
        },
        release() {},
      };
    },
  };
}

function claimInput(amount) {
  return {
    claim_id: "C-IMMUTABLE",
    scheme_id: "scheme_a",
    member_id: "M-1",
    provider_id: "P-1",
    service_date: "2026-07-16",
    ...modelClaimFields(),
    billing_code: "CONSULT",
    amount,
  };
}

test("claim ownership is immutable while same-tenant updates remain idempotent", async () => {
  const pool = createStatefulClaimPool();
  const repository = createClaimIngestionRepository(pool, { allowLegacyTenantContext: true });

  await runWithTenantContext({ tenant_id: "tenant_alpha" }, () =>
    repository.ingestClaims({ claims: [claimInput(100)] }),
  );
  const update = await runWithTenantContext({ tenant_id: "tenant_alpha" }, () =>
    repository.ingestClaims({ claims: [claimInput(125)] }),
  );

  await assert.rejects(
    () => runWithTenantContext({ tenant_id: "tenant_beta" }, () =>
      repository.ingestClaims({ claims: [claimInput(999)] }),
    ),
    ClaimOwnershipConflictError,
  );

  assert.equal(update.inserted, 0);
  assert.equal(update.updated, 1);
  assert.equal(pool.claims.get("C-IMMUTABLE").tenant_id, "tenant_alpha");
  assert.equal(pool.claims.get("C-IMMUTABLE").amount, 125);
  assert.equal(pool.outbox.size, 2);
  assert.equal(pool.rollbackCount, 1);
});

test("claim and outbox creation commit together and identical retries reuse one job", async () => {
  const pool = createStatefulClaimPool();
  const repository = createClaimIngestionRepository(pool, { allowLegacyTenantContext: true });

  const first = await runWithTenantContext({ tenant_id: "tenant_alpha" }, () =>
    repository.ingestClaims({ claims: [claimInput(100)], correlationId: "request-1" }),
  );
  const retry = await runWithTenantContext({ tenant_id: "tenant_alpha" }, () =>
    repository.ingestClaims({ claims: [claimInput(100)], correlationId: "request-2" }),
  );

  assert.equal(pool.claims.size, 1);
  assert.equal(pool.outbox.size, 1);
  assert.equal(first.processing.reused, false);
  assert.equal(retry.processing.reused, true);
  assert.equal(retry.processing.jobId, first.processing.jobId);
  assert.equal(retry.processing.correlationId, "request-1");
});

test("outbox enqueue failure rolls back the claim write", async () => {
  const pool = createStatefulClaimPool({ failOutboxInsert: true });
  const repository = createClaimIngestionRepository(pool, { allowLegacyTenantContext: true });

  await assert.rejects(
    () => runWithTenantContext({ tenant_id: "tenant_alpha" }, () =>
      repository.ingestClaims({ claims: [claimInput(100)] }),
    ),
    /outbox insert failed/,
  );

  assert.equal(pool.claims.size, 0);
  assert.equal(pool.outbox.size, 0);
  assert.equal(pool.rollbackCount, 1);
});

test("claim failure creates no outbox job", async () => {
  const pool = createStatefulClaimPool({ failClaimInsert: true });
  const repository = createClaimIngestionRepository(pool, { allowLegacyTenantContext: true });

  await assert.rejects(
    () => runWithTenantContext({ tenant_id: "tenant_alpha" }, () =>
      repository.ingestClaims({ claims: [claimInput(100)] }),
    ),
    /claim insert failed/,
  );

  assert.equal(pool.claims.size, 0);
  assert.equal(pool.outbox.size, 0);
});

test("ownership conflict rolls back without creating an outbox job", async () => {
  const pool = createStatefulClaimPool();
  const repository = createClaimIngestionRepository(pool, { allowLegacyTenantContext: true });
  await runWithTenantContext({ tenant_id: "tenant_alpha" }, () =>
    repository.ingestClaims({ claims: [claimInput(100)] }),
  );

  await assert.rejects(
    () => runWithTenantContext({ tenant_id: "tenant_beta" }, () =>
      repository.ingestClaims({ claims: [claimInput(100)] }),
    ),
    ClaimOwnershipConflictError,
  );

  assert.equal(pool.outbox.size, 1);
  assert.equal([...pool.outbox.values()][0].tenant_id, "tenant_alpha");
});

test("claim references cannot cross tenant or scheme boundaries", async () => {
  const pool = createStatefulClaimPool();
  const repository = createClaimIngestionRepository(pool, { allowLegacyTenantContext: true });

  await assert.rejects(
    () => runWithTenantContext({ tenant_id: "tenant_beta" }, () =>
      repository.ingestClaims({
        claims: [{ ...claimInput(100), claim_id: "C-CROSS-TENANT" }],
      }),
    ),
    ClaimReferenceValidationError,
  );

  assert.equal(pool.claims.size, 0);
  assert.equal(pool.outbox.size, 0);
  assert.equal(pool.rollbackCount, 1);
});
