import crypto from "node:crypto";

import { int, json, mysqlTable, varchar } from "drizzle-orm/mysql-core";

export { createDatabase, createMysqlConnection } from "./client.js";
export { createClaimIngestionRepository } from "./claim-ingestion-repository.js";
export {
  assertInvestigationStatusTransition,
  canTransitionInvestigationStatus,
  createInvestigationRepository,
  InvestigationConflictError,
  InvestigationNotFoundError,
  InvestigationValidationError,
  INVESTIGATION_NOTE_TYPE,
  INVESTIGATION_PRIORITY,
  INVESTIGATION_STATUS,
  isFraudConfirmationPermitted,
  normalizeInvestigationNoteType,
  normalizeInvestigationPriority,
  normalizeInvestigationStatus,
} from "./investigation-repository.js";
export { createLedgerRepository } from "./ledger-repository.js";
export {
  createSharedFraudRegistryRepository,
  FRAUD_REGISTRY_STATUS,
  FRAUD_SUBJECT_TYPE,
  FraudRegistryConflictError,
  FraudRegistryNotFoundError,
  FraudRegistryValidationError,
  normalizeRegistryPublicationMetadata,
} from "./shared-fraud-registry-repository.js";
export {
  createTenantRepository,
  LEGACY_DEFAULT_TENANT_ID,
  LEGACY_DEFAULT_TENANT_SLUG,
} from "./tenant-repository.js";
export {
  getActiveTenantContext,
  getActiveTenantId,
  getLegacyDefaultTenantContext,
  runWithTenantContext,
} from "./tenant-context-store.js";
export { applyMigrations, defaultMigrationPath } from "./migrate.js";
export { loadSyntheticPhase1Data, seedSyntheticDatabase } from "./seed.js";

export const ledgerEntriesTable = mysqlTable("ledger_entries", {
  id: int("id").autoincrement().primaryKey(),
  sequenceNumber: int("sequence_number").notNull(),
  entryType: varchar("entry_type", { length: 64 }).notNull(),
  previousHash: varchar("previous_hash", { length: 64 }).notNull(),
  entryHash: varchar("entry_hash", { length: 64 }).notNull().unique(),
  payload: json("payload").notNull(),
  tenantId: varchar("tenant_id", { length: 64 }),
});

export const genesisPreviousHash = "0".repeat(64);

function sortValue(value) {
  if (Array.isArray(value)) {
    return value.map(sortValue);
  }

  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, sortValue(value[key])]),
    );
  }

  return value;
}

export function stableStringify(value) {
  return JSON.stringify(sortValue(value));
}

export function computeLedgerEntryHash({ previousHash, entryType, payload }) {
  const digest = crypto.createHash("sha256");
  digest.update(previousHash);
  digest.update("|");
  digest.update(entryType);
  digest.update("|");
  digest.update(stableStringify(payload));
  return digest.digest("hex");
}

export function createLedgerEntry({
  sequenceNumber,
  previousHash = genesisPreviousHash,
  entryType,
  payload,
  tenantId,
}) {
  const entryHash = computeLedgerEntryHash({ previousHash, entryType, payload });

  return {
    sequenceNumber,
    entryType,
    previousHash,
    entryHash,
    payload,
    tenantId,
  };
}
