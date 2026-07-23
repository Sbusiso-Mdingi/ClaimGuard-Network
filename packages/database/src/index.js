import { int, json, mysqlTable, varchar } from "drizzle-orm/mysql-core";

export {
  computeLedgerEntryHash,
  createLedgerEntry,
  genesisPreviousHash,
  stableStringify,
} from "./ledger-entry.js";
export { appendLedgerEntry, LedgerConcurrencyConflictError } from "./ledger-chain.js";

export { createDatabase, createDatabaseFromPool, createMysqlConnection, buildConnectionOptions } from "./client.js";
export {
  createDataPlaneContext,
  dataPlanePoolKey,
  DataPlaneContextValidationError,
  requireOperationalDataPlaneContext,
} from "./data-plane-context.js";
export { createLegacySharedAdapter, DataPlaneMetadataMismatchError } from "./legacy-shared-adapter.js";
export {
  createTenantConnectionManager,
  TenantPoolLimitError,
  TenantPoolStaleGenerationError,
  TenantPoolTimeoutError,
} from "./tenant-connection-manager.js";
export { createOperationalRepositories } from "./operational-repositories.js";
export {
  ClaimOwnershipConflictError,
  ClaimReferenceValidationError,
  createClaimIngestionRepository,
  ReferenceOwnershipConflictError,
} from "./claim-ingestion-repository.js";
export {
  createClaimsReadRepository,
} from "./claims-read-repository.js";
export {
  CLAIM_PROCESSING_AGGREGATE_TYPE,
  CLAIM_PROCESSING_JOB_TYPE,
  CLAIM_PROCESSING_STATUS,
  createClaimBatchIdempotencyKey,
  createClaimProcessingOutboxRepository,
  enqueueClaimProcessingJob,
} from "./claim-processing-outbox-repository.js";
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
  createFraudWorkflowRepository,
  FRAUD_WORKFLOW_OPERATION,
  FRAUD_WORKFLOW_VERSION,
  FraudWorkflowConflictError,
  FraudWorkflowIdempotencyConflictError,
  FraudWorkflowNotFoundError,
  FraudWorkflowValidationError,
} from "./fraud-workflow-repository.js";
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
export {
  applyMigrations,
  defaultMigrationPath,
  defaultMigrationPaths,
  getOperationalMigrationStatus,
  operationalMigrationChecksum,
  OperationalMigrationChecksumMismatchError,
  OperationalMigrationExecutionError,
} from "./migrate.js";
export const ledgerEntriesTable = mysqlTable("ledger_entries", {
  id: int("id").autoincrement().primaryKey(),
  sequenceNumber: int("sequence_number").notNull(),
  entryType: varchar("entry_type", { length: 64 }).notNull(),
  previousHash: varchar("previous_hash", { length: 64 }).notNull(),
  entryHash: varchar("entry_hash", { length: 64 }).notNull().unique(),
  payload: json("payload").notNull(),
  tenantId: varchar("tenant_id", { length: 64 }),
});

export const detectionStrategiesTable = mysqlTable("detection_strategies", {
  id: int("id").autoincrement().primaryKey(),
  tenantId: varchar("tenant_id", { length: 64 }).notNull(),
  strategyType: varchar("strategy_type", { length: 64 }).notNull().default("deterministic_rules"),
  modelDeploymentId: varchar("model_deployment_id", { length: 128 }),
  isActive: int("is_active").notNull().default(1),
  createdAt: varchar("created_at", { length: 64 }).notNull(),
  updatedAt: varchar("updated_at", { length: 64 }).notNull(),
  activatedAt: varchar("activated_at", { length: 64 }),
  deactivatedAt: varchar("deactivated_at", { length: 64 }),
  actor: varchar("actor", { length: 255 }),
  changeReason: varchar("change_reason", { length: 65535 }),
});
