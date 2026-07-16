import assert from "node:assert/strict";
import test from "node:test";

import {
  createFraudWorkflowRepository,
  FraudWorkflowConflictError,
  FraudWorkflowIdempotencyConflictError,
  FraudWorkflowNotFoundError,
  FraudWorkflowValidationError,
} from "../src/index.js";

function key(tenantId, investigationId) {
  return `${tenantId}:${investigationId}`;
}

function cloneState(state) {
  return structuredClone(state);
}

function createFakePool({
  failLedgerInsert = false,
  failConfirmationUpdate = false,
  failRegistryInsert = false,
  failReversalUpdate = false,
} = {}) {
  let transactionTail = Promise.resolve();
  const pool = {
    state: {
      investigations: new Map([
        [
          key("tenant_alpha", "inv-alpha"),
          {
            investigation_id: "inv-alpha",
            tenant_id: "tenant_alpha",
            claim_id: "claim-alpha",
            status: "CONFIRMED_FRAUD",
            fraud_confirmed_at: null,
            confirmation_operation_id: null,
            reversal_operation_id: null,
            reversed_at: null,
          },
        ],
        [
          key("tenant_beta", "inv-beta"),
          {
            investigation_id: "inv-beta",
            tenant_id: "tenant_beta",
            claim_id: "claim-beta",
            status: "CONFIRMED_FRAUD",
            fraud_confirmed_at: null,
            confirmation_operation_id: null,
            reversal_operation_id: null,
            reversed_at: null,
          },
        ],
      ]),
      claims: new Map([
        [
          key("tenant_alpha", "claim-alpha"),
          {
            claim_id: "claim-alpha",
            tenant_id: "tenant_alpha",
            provider_id: "provider-secret-123",
            scheme_id: "scheme-a",
            medical_scheme: "Alpha Medical Scheme",
          },
        ],
        [
          key("tenant_beta", "claim-beta"),
          {
            claim_id: "claim-beta",
            tenant_id: "tenant_beta",
            provider_id: "provider-beta",
            scheme_id: "scheme-b",
            medical_scheme: "Beta Medical Scheme",
          },
        ],
      ]),
      evidence: new Map([
        [key("tenant_alpha", "inv-alpha"), 1],
        [key("tenant_beta", "inv-beta"), 1],
      ]),
      operations: [],
      ledger: [],
      registries: [],
      allocator: 1,
      heads: new Map(),
    },
    failRegistryInsert,
    failLedgerInsert,
    failConfirmationUpdate,
    failReversalUpdate,
    async getConnection() {
      let working = null;
      let releaseTransaction = null;
      return {
        async beginTransaction() {
          const previousTransaction = transactionTail;
          transactionTail = new Promise((resolve) => {
            releaseTransaction = resolve;
          });
          await previousTransaction;
          working = cloneState(pool.state);
        },
        async commit() {
          pool.state = working;
          releaseTransaction?.();
        },
        async rollback() {
          working = null;
          releaseTransaction?.();
        },
        release() {},
        async execute(sql, params = []) {
          const statement = String(sql).replace(/\s+/g, " ").trim();

          if (statement.startsWith("SELECT investigation_id") && statement.includes("FROM investigations")) {
            const [investigationId, tenantId] = params;
            const investigation = working.investigations.get(key(tenantId, investigationId));
            return [investigation ? [{ ...investigation }] : []];
          }

          if (statement.includes("FROM fraud_workflow_operations")) {
            const [tenantId, operationType, investigationId, idempotencyKey] = params;
            return [
              working.operations.filter(
                (operation) =>
                  operation.tenant_id === tenantId &&
                  operation.operation_type === operationType &&
                  (operation.investigation_id === investigationId || operation.idempotency_key === idempotencyKey),
              ),
            ];
          }

          if (statement.includes("FROM claims c") && statement.includes("COUNT(e.evidence_id)")) {
            const [investigationId, claimId, tenantId] = params;
            const claim = working.claims.get(key(tenantId, claimId));
            return [
              claim
                ? [{ ...claim, evidence_count: working.evidence.get(key(tenantId, investigationId)) || 0 }]
                : [],
            ];
          }

          if (statement.startsWith("INSERT IGNORE INTO ledger_chain_heads")) {
            const [tenantId, genesis] = params;
            if (!working.heads.has(tenantId)) {
              working.heads.set(tenantId, { last_sequence_number: 0, last_entry_hash: genesis });
            }
            return [{ affectedRows: 1 }];
          }

          if (statement.includes("FROM ledger_sequence_allocator")) {
            return [[{ next_sequence: working.allocator }]];
          }

          if (statement.includes("FROM ledger_chain_heads")) {
            const [tenantId] = params;
            return [[{ ...working.heads.get(tenantId) }]];
          }

          if (statement.startsWith("INSERT INTO ledger_entries")) {
            if (pool.failLedgerInsert) {
              throw new Error("simulated ledger outage");
            }
            const [
              sequence_number,
              entry_type,
              previous_hash,
              entry_hash,
              payload,
              tenant_id,
              operation_id,
              operation_type,
              investigation_id,
              reversed_ledger_entry_id,
              actor_id,
              actor_role,
              correlation_id,
              workflow_version,
            ] = params;
            const id = working.ledger.length + 1;
            working.ledger.push({
              id,
              sequence_number,
              entry_type,
              previous_hash,
              entry_hash,
              payload: JSON.parse(payload),
              tenant_id,
              operation_id,
              operation_type,
              investigation_id,
              reversed_ledger_entry_id,
              actor_id,
              actor_role,
              correlation_id,
              workflow_version,
            });
            return [{ insertId: id, affectedRows: 1 }];
          }

          if (statement.startsWith("UPDATE ledger_sequence_allocator")) {
            working.allocator = params[0];
            return [{ affectedRows: 1 }];
          }

          if (statement.startsWith("UPDATE ledger_chain_heads")) {
            const [last_sequence_number, last_entry_hash, tenantId] = params;
            working.heads.set(tenantId, { last_sequence_number, last_entry_hash });
            return [{ affectedRows: 1 }];
          }

          if (statement.startsWith("UPDATE investigations") && statement.includes("SET fraud_confirmed_at")) {
            if (pool.failConfirmationUpdate) {
              return [{ affectedRows: 0 }];
            }
            const investigationId = params[8];
            const tenantId = params[9];
            const investigation = working.investigations.get(key(tenantId, investigationId));
            if (!investigation || investigation.status !== "CONFIRMED_FRAUD" || investigation.fraud_confirmed_at) {
              return [{ affectedRows: 0 }];
            }
            investigation.fraud_confirmed_at = params[0];
            investigation.confirmation_operation_id = params[1];
            investigation.confirmation_intent_hash = params[2];
            investigation.confirmation_ledger_entry_id = params[3];
            investigation.confirmed_by = params[4];
            investigation.confirmed_by_role = params[5];
            investigation.confirmation_correlation_id = params[6];
            investigation.registry_publication_required = 1;
            investigation.registry_publication_reason = "AUTHORITATIVE_PROVIDER_FINDING";
            return [{ affectedRows: 1 }];
          }

          if (statement.startsWith("INSERT INTO shared_fraud_registry_entries")) {
            if (pool.failRegistryInsert) {
              throw new Error("simulated registry outage");
            }
            const isReversal = statement.includes("'REVERSED'");
            const record = isReversal
              ? {
                  registry_entry_id: params[0], ledger_hash: params[1], investigation_id: params[2],
                  tenant_id: params[3], medical_scheme: params[4], fraud_subject_type: params[5],
                  subject_token: params[6], offence_category: params[7], finding_date: params[8],
                  investigator_reference: params[9], status: "REVERSED",
                  reverses_registry_entry_id: params[10], reversal_operation_id: params[11],
                }
              : {
                  registry_entry_id: params[0], ledger_hash: params[1], investigation_id: params[2],
                  tenant_id: params[3], medical_scheme: params[4], fraud_subject_type: params[5],
                  subject_token: params[6], offence_category: params[7], finding_date: params[8],
                  investigator_reference: params[9], status: "ACTIVE",
                  reverses_registry_entry_id: null, confirmation_operation_id: params[10],
                };
            working.registries.push(record);
            return [{ affectedRows: 1 }];
          }

          if (statement.startsWith("INSERT INTO fraud_workflow_operations")) {
            working.operations.push({
              operation_id: params[0], tenant_id: params[1], operation_type: params[2],
              investigation_id: params[3], idempotency_key: params[4], intent_hash: params[5],
              actor_id: params[6], actor_role: params[7], correlation_id: params[8],
              ledger_entry_id: params[9], registry_entry_id: params[10],
              result_payload: params[11], workflow_version: params[12],
            });
            return [{ affectedRows: 1 }];
          }

          if (statement.includes("FROM shared_fraud_registry_entries active")) {
            const [investigationId, tenantId] = params;
            const reversed = new Set(
              working.registries.filter((row) => row.status === "REVERSED").map((row) => row.reverses_registry_entry_id),
            );
            const row = working.registries.find(
              (item) =>
                item.investigation_id === investigationId && item.tenant_id === tenantId &&
                item.status === "ACTIVE" && !reversed.has(item.registry_entry_id),
            );
            return [row ? [{ ...row }] : []];
          }

          if (statement.includes("FROM ledger_entries") && statement.includes("entry_hash = ?")) {
            const [entryHash, tenantId, investigationId] = params;
            const row = working.ledger.find(
              (item) => item.entry_hash === entryHash && item.tenant_id === tenantId &&
                item.investigation_id === investigationId,
            );
            return [row ? [{ id: row.id, entry_hash: row.entry_hash }] : []];
          }

          if (statement.startsWith("UPDATE investigations") && statement.includes("SET status = 'REVERSED'")) {
            if (pool.failReversalUpdate) {
              return [{ affectedRows: 0 }];
            }
            const investigationId = params[9];
            const tenantId = params[10];
            const investigation = working.investigations.get(key(tenantId, investigationId));
            if (!investigation || investigation.status !== "CONFIRMED_FRAUD" || !investigation.fraud_confirmed_at) {
              return [{ affectedRows: 0 }];
            }
            investigation.status = "REVERSED";
            investigation.reversal_operation_id = params[0];
            investigation.reversal_intent_hash = params[1];
            investigation.reversal_ledger_entry_id = params[2];
            investigation.reversal_reason = params[3];
            investigation.reversed_by = params[4];
            investigation.reversed_by_role = params[5];
            investigation.reversed_at = params[6];
            investigation.reversal_correlation_id = params[7];
            return [{ affectedRows: 1 }];
          }

          throw new Error(`Unexpected fraud workflow query: ${statement}`);
        },
      };
    },
  };
  return pool;
}

function confirmationInput(overrides = {}) {
  return {
    tenantId: "tenant_alpha",
    investigationId: "inv-alpha",
    requestedClaimId: "claim-alpha",
    reason: "Persisted evidence confirms deliberate provider billing fraud.",
    actorId: "authenticated-investigator",
    actorRole: "investigator",
    correlationId: "request-1",
    idempotencyKey: "confirm-inv-alpha",
    ...overrides,
  };
}

test("confirmation commits one server-derived ledger, investigation, registry, and operation result", async () => {
  const pool = createFakePool();
  const repository = createFraudWorkflowRepository(pool);

  const result = await repository.confirmFraud(
    confirmationInput({
      investigatorId: "body-attacker",
      registryMetadata: { subjectToken: "raw-provider", medicalScheme: "Forged Scheme" },
    }),
  );

  assert.equal(result.replayed, false);
  assert.equal(pool.state.ledger.length, 1);
  assert.equal(pool.state.registries.length, 1);
  assert.equal(pool.state.operations.length, 1);
  assert.equal(pool.state.ledger[0].actor_id, "authenticated-investigator");
  assert.equal(pool.state.ledger[0].payload.actor.id, "authenticated-investigator");
  assert.equal(pool.state.registries[0].investigator_reference, "authenticated-investigator");
  assert.equal(pool.state.registries[0].medical_scheme, "Alpha Medical Scheme");
  assert.equal(pool.state.registries[0].fraud_subject_type, "PROVIDER");
  assert.equal(pool.state.registries[0].offence_category, "CONFIRMED_CLAIM_FRAUD");
  assert.notEqual(pool.state.registries[0].subject_token, "raw-provider");
  assert.equal(pool.state.registries[0].subject_token.length, 64);
  assert.equal(JSON.stringify(pool.state.registries[0]).includes("provider-secret-123"), false);
  assert.equal(pool.state.investigations.get(key("tenant_alpha", "inv-alpha")).registry_publication_required, 1);
});

test("confirmation replay is durable and mismatched intent is rejected without duplicate writes", async () => {
  const pool = createFakePool();
  const repository = createFraudWorkflowRepository(pool);
  await repository.confirmFraud(confirmationInput());

  const replay = await repository.confirmFraud(confirmationInput({ correlationId: "request-retry" }));
  assert.equal(replay.replayed, true);
  assert.equal(pool.state.ledger.length, 1);
  assert.equal(pool.state.registries.length, 1);

  await assert.rejects(
    () => repository.confirmFraud(confirmationInput({ reason: "A different decision intent." })),
    FraudWorkflowIdempotencyConflictError,
  );
  assert.equal(pool.state.ledger.length, 1);
});

test("concurrent matching confirmations serialize to one write and one durable replay", async () => {
  const pool = createFakePool();
  const repository = createFraudWorkflowRepository(pool);

  const results = await Promise.all([
    repository.confirmFraud(confirmationInput({ correlationId: "concurrent-1" })),
    repository.confirmFraud(confirmationInput({ correlationId: "concurrent-2" })),
  ]);

  assert.deepEqual(results.map((result) => result.replayed).sort(), [false, true]);
  assert.equal(pool.state.ledger.length, 1);
  assert.equal(pool.state.operations.length, 1);
  assert.equal(pool.state.registries.length, 1);
});

test("tenant ledger heads produce unique global sequences and independent tenant chains", async () => {
  const pool = createFakePool();
  const repository = createFraudWorkflowRepository(pool);
  const betaInput = confirmationInput({
    tenantId: "tenant_beta",
    investigationId: "inv-beta",
    requestedClaimId: "claim-beta",
    actorId: "beta-investigator",
    correlationId: "beta-request",
    idempotencyKey: "confirm-inv-beta",
  });

  await Promise.all([
    repository.confirmFraud(confirmationInput()),
    repository.confirmFraud(betaInput),
  ]);

  assert.deepEqual(pool.state.ledger.map((entry) => entry.sequence_number), [1, 2]);
  assert.equal(pool.state.ledger[0].previous_hash, "0".repeat(64));
  assert.equal(pool.state.ledger[1].previous_hash, "0".repeat(64));
  assert.notEqual(pool.state.ledger[0].entry_hash, pool.state.ledger[1].entry_hash);
  assert.equal(pool.state.heads.size, 2);
});

test("registry failure rolls back the confirmation ledger and investigation finalization", async () => {
  const pool = createFakePool({ failRegistryInsert: true });
  const repository = createFraudWorkflowRepository(pool);

  await assert.rejects(() => repository.confirmFraud(confirmationInput()), /simulated registry outage/);
  assert.equal(pool.state.ledger.length, 0);
  assert.equal(pool.state.registries.length, 0);
  assert.equal(pool.state.operations.length, 0);
  assert.equal(pool.state.allocator, 1);
  assert.equal(pool.state.investigations.get(key("tenant_alpha", "inv-alpha")).fraud_confirmed_at, null);
});

test("ledger and investigation failures roll back every confirmation write", async () => {
  for (const failure of ["failLedgerInsert", "failConfirmationUpdate"]) {
    const pool = createFakePool({ [failure]: true });
    const repository = createFraudWorkflowRepository(pool);

    await assert.rejects(() => repository.confirmFraud(confirmationInput()));
    assert.equal(pool.state.ledger.length, 0, failure);
    assert.equal(pool.state.registries.length, 0, failure);
    assert.equal(pool.state.operations.length, 0, failure);
    assert.equal(pool.state.investigations.get(key("tenant_alpha", "inv-alpha")).fraud_confirmed_at, null);
  }
});

test("tenant-scoped locking does not reveal an investigation from another tenant", async () => {
  const repository = createFraudWorkflowRepository(createFakePool());
  await assert.rejects(
    () => repository.confirmFraud(confirmationInput({ tenantId: "tenant_beta" })),
    FraudWorkflowNotFoundError,
  );
});

test("reversal links the original ledger and registry records and replays idempotently", async () => {
  const pool = createFakePool();
  const repository = createFraudWorkflowRepository(pool);
  const confirmation = await repository.confirmFraud(confirmationInput());
  const reversalInput = {
    ...confirmationInput(),
    reason: "Independent appeal evidence invalidated the original finding.",
    correlationId: "request-2",
    idempotencyKey: "reverse-inv-alpha",
  };

  const reversal = await repository.reverseFraud(reversalInput);
  assert.equal(reversal.replayed, false);
  assert.equal(pool.state.ledger.length, 2);
  assert.equal(pool.state.ledger[1].reversed_ledger_entry_id, confirmation.entry.id);
  assert.equal(pool.state.ledger[1].previous_hash, confirmation.entry.entryHash);
  assert.equal(pool.state.registries[1].reverses_registry_entry_id, confirmation.registryEntry.registryEntryId);
  assert.equal(pool.state.investigations.get(key("tenant_alpha", "inv-alpha")).status, "REVERSED");

  const replay = await repository.reverseFraud({ ...reversalInput, correlationId: "request-2-retry" });
  assert.equal(replay.replayed, true);
  assert.equal(pool.state.ledger.length, 2);
  assert.equal(pool.state.registries.length, 2);

  await assert.rejects(
    () => repository.reverseFraud({ ...reversalInput, reason: "A materially different reversal." }),
    FraudWorkflowIdempotencyConflictError,
  );
});

test("ledger, registry, and investigation failures each roll back every reversal write", async () => {
  for (const failure of ["failLedgerInsert", "failRegistryInsert", "failReversalUpdate"]) {
    const pool = createFakePool();
    const repository = createFraudWorkflowRepository(pool);
    await repository.confirmFraud(confirmationInput());
    pool[failure] = true;

    await assert.rejects(() => repository.reverseFraud({
      ...confirmationInput(),
      reason: "Appeal accepted.",
      idempotencyKey: `reverse-${failure}`,
    }));
    assert.equal(pool.state.ledger.length, 1, failure);
    assert.equal(pool.state.registries.length, 1, failure);
    assert.equal(pool.state.operations.length, 1, failure);
    assert.equal(pool.state.investigations.get(key("tenant_alpha", "inv-alpha")).status, "CONFIRMED_FRAUD");
  }
});

test("concurrent matching reversals produce one reversal and one replay", async () => {
  const pool = createFakePool();
  const repository = createFraudWorkflowRepository(pool);
  await repository.confirmFraud(confirmationInput());
  const reversalInput = {
    ...confirmationInput(),
    reason: "Appeal accepted.",
    idempotencyKey: "concurrent-reversal",
  };

  const results = await Promise.all([
    repository.reverseFraud({ ...reversalInput, correlationId: "reverse-concurrent-1" }),
    repository.reverseFraud({ ...reversalInput, correlationId: "reverse-concurrent-2" }),
  ]);
  assert.deepEqual(results.map((result) => result.replayed).sort(), [false, true]);
  assert.equal(pool.state.ledger.length, 2);
  assert.equal(pool.state.registries.length, 2);
});

test("reversal and confirmation lifecycle validation fail before writes", async () => {
  const pool = createFakePool();
  const repository = createFraudWorkflowRepository(pool);

  await assert.rejects(
    () => repository.reverseFraud({ ...confirmationInput(), idempotencyKey: "early-reversal" }),
    FraudWorkflowConflictError,
  );
  pool.state.investigations.get(key("tenant_alpha", "inv-alpha")).status = "NO_FRAUD_FOUND";
  await assert.rejects(() => repository.confirmFraud(confirmationInput()), FraudWorkflowConflictError);
  await assert.rejects(
    () => repository.confirmFraud(confirmationInput({ reason: "" })),
    FraudWorkflowValidationError,
  );
  assert.equal(pool.state.ledger.length, 0);
  assert.equal(pool.state.registries.length, 0);
});

test("cross-tenant reversal is unavailable and modifies no rows", async () => {
  const pool = createFakePool();
  const repository = createFraudWorkflowRepository(pool);
  await repository.confirmFraud(confirmationInput());
  const before = cloneState(pool.state);

  await assert.rejects(
    () => repository.reverseFraud({
      ...confirmationInput(),
      tenantId: "tenant_beta",
      idempotencyKey: "cross-tenant-reversal",
    }),
    FraudWorkflowNotFoundError,
  );
  assert.deepEqual(pool.state, before);
});
