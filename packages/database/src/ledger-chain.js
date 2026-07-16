import { createLedgerEntry, genesisPreviousHash } from "./ledger-entry.js";

export class LedgerConcurrencyConflictError extends Error {
  constructor(message = "The ledger changed concurrently. Retry the operation with the same idempotency key.") {
    super(message);
    this.name = "LedgerConcurrencyConflictError";
    this.code = "ledger_concurrency_conflict";
    this.status = 409;
  }
}

function isDuplicateKeyError(error) {
  return error?.code === "ER_DUP_ENTRY" || error?.errno === 1062;
}

export async function appendLedgerEntry(
  connection,
  {
    tenantId,
    entryType,
    payload,
    operationId = null,
    operationType = null,
    investigationId = null,
    reversedLedgerEntryId = null,
    actorId = null,
    actorRole = null,
    correlationId = null,
    workflowVersion = null,
  },
) {
  await connection.execute(
    `
      INSERT IGNORE INTO ledger_chain_heads (
        tenant_id, last_sequence_number, last_entry_hash
      ) VALUES (?, 0, ?)
    `,
    [tenantId, genesisPreviousHash],
  );

  // The global allocator preserves the deployed unique sequence-number contract.
  // The per-tenant head is then locked before its previous hash is consumed.
  const [allocatorRows] = await connection.execute(
    "SELECT next_sequence FROM ledger_sequence_allocator WHERE allocator_id = 1 FOR UPDATE",
  );
  const [headRows] = await connection.execute(
    `
      SELECT last_sequence_number, last_entry_hash
      FROM ledger_chain_heads
      WHERE tenant_id = ?
      FOR UPDATE
    `,
    [tenantId],
  );

  if (!allocatorRows?.[0] || !headRows?.[0]) {
    throw new Error("Ledger chain state is not initialized. Apply database migrations before writing.");
  }

  const sequenceNumber = Number(allocatorRows[0].next_sequence);
  if (!Number.isSafeInteger(sequenceNumber) || sequenceNumber < 1 || sequenceNumber > 2_147_483_647) {
    throw new Error("The ledger sequence allocator has exceeded the supported INT range.");
  }

  const entry = createLedgerEntry({
    sequenceNumber,
    previousHash: headRows[0].last_entry_hash,
    entryType,
    payload,
    tenantId,
  });

  try {
    const [insertResult] = await connection.execute(
      `
        INSERT INTO ledger_entries (
          sequence_number, entry_type, previous_hash, entry_hash, payload, tenant_id,
          operation_id, operation_type, investigation_id, reversed_ledger_entry_id,
          actor_id, actor_role, correlation_id, workflow_version
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      [
        entry.sequenceNumber,
        entry.entryType,
        entry.previousHash,
        entry.entryHash,
        JSON.stringify(entry.payload),
        entry.tenantId,
        operationId,
        operationType,
        investigationId,
        reversedLedgerEntryId,
        actorId,
        actorRole,
        correlationId,
        workflowVersion,
      ],
    );

    await connection.execute(
      "UPDATE ledger_sequence_allocator SET next_sequence = ? WHERE allocator_id = 1",
      [sequenceNumber + 1],
    );
    await connection.execute(
      `
        UPDATE ledger_chain_heads
        SET last_sequence_number = ?, last_entry_hash = ?
        WHERE tenant_id = ?
      `,
      [entry.sequenceNumber, entry.entryHash, tenantId],
    );

    return {
      ...entry,
      id: Number(insertResult.insertId),
      entryId: Number(insertResult.insertId),
      operationId,
      operationType,
      investigationId,
      reversedLedgerEntryId,
      actorId,
      actorRole,
      correlationId,
      workflowVersion,
    };
  } catch (error) {
    if (isDuplicateKeyError(error)) {
      throw new LedgerConcurrencyConflictError();
    }
    throw error;
  }
}
