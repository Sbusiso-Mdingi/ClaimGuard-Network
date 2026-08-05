import { createClaimIngestionRepository } from "./claim-ingestion-repository.js";
import { createClaimsReadRepository } from "./prospective-claims-read-repository.js";
import { createClaimProcessingOutboxRepository } from "./claim-processing-outbox-repository.js";
import { createDatabaseFromPool } from "./client.js";
import { requireOperationalDataPlaneContext } from "./data-plane-context.js";
import { createInvestigationQueueRepository } from "./investigation-queue-repository.js";
import { createInvestigationRepository } from "./investigation-repository.js";
import { createCaseWorkflowRepository } from "./case-workflow-repository.js";
import { createLegacyCaseAdapter } from "./legacy-case-adapter.js";
import { createLegacyCaseReadRepository } from "./legacy-case-read-repository.js";
import { createLedgerRepository } from "./ledger-repository.js";
import { createSharedFraudRegistryRepository } from "./shared-fraud-registry-repository.js";
import { createScopedReadRepositories } from "./scoped-read-repositories.js";
import { createTenantRepository } from "./tenant-repository.js";
import { createDetectionStrategyRepository } from "./detection-strategy-repository.js";
import { createDesktopSyncRepository } from "./desktop-sync-repository.js";

function configuredOutcomeCodes() {
  return String(process.env.SEQURIN_CASE_OUTCOME_CODES || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

function disabledOperation({ name, code, message, tenantId }) {
  return async function disabledLegacyOperation(input = {}) {
    if (input.tenantId !== undefined && input.tenantId !== tenantId) {
      const error = new Error("The supplied tenant does not match the verified DataPlaneContext.");
      error.name = "DataPlaneTenantMismatchError";
      error.code = "data_plane_tenant_mismatch";
      error.status = 403;
      throw error;
    }
    const error = new Error(message);
    error.name = name;
    error.code = code;
    error.status = 409;
    throw error;
  };
}

function createDisabledLegacyFraudWorkflowAdapter(tenantId) {
  return Object.freeze({
    confirmFraud: disabledOperation({
      name: "LegacyFraudConfirmationDisabledError",
      code: "LEGACY_FRAUD_CONFIRMATION_DISABLED",
      message: "Direct legacy fraud confirmation is disabled. Complete the investigation and use the governed case outcome-review workflow.",
      tenantId,
    }),
    reverseFraud: disabledOperation({
      name: "LegacyFraudReversalDisabledError",
      code: "LEGACY_FRAUD_REVERSAL_DISABLED",
      message: "Direct legacy fraud reversal is disabled. Use the governed case review and appeal workflow.",
      tenantId,
    }),
  });
}

function legacyStatusWriteDisabled() {
  const error = new Error(
    "Investigation lifecycle changes must use the governed Sequrin case-action API.",
  );
  error.name = "LegacyInvestigationStatusWriteDisabledError";
  error.code = "LEGACY_INVESTIGATION_STATUS_WRITE_DISABLED";
  error.status = 409;
  return error;
}

export function createOperationalRepositories(dataPlaneContext, pool) {
  const context = requireOperationalDataPlaneContext(dataPlaneContext);
  if (!pool || typeof pool.execute !== "function") throw new TypeError("A verified operational pool is required.");
  const db = createDatabaseFromPool(pool);
  const options = { dataPlaneContext: context, allowLegacyTenantContext: false };
  const scopedReads = createScopedReadRepositories(context, pool);
  const legacyInvestigations = createInvestigationRepository(pool, options);
  const investigations = Object.freeze({
    ...legacyInvestigations,
    ...createInvestigationQueueRepository(pool, options),
    async updateInvestigation(input) {
      if (input && Object.hasOwn(input, "status") && input.status !== undefined) {
        throw legacyStatusWriteDisabled();
      }
      return legacyInvestigations.updateInvestigation(input);
    },
  });
  const claimsRead = createClaimsReadRepository(pool, options);
  const cases = Object.freeze({
    ...createCaseWorkflowRepository(pool, {
      ...options,
      allowedOutcomeCodes: configuredOutcomeCodes(),
    }),
    ...createLegacyCaseReadRepository(pool, options),
    ...createLegacyCaseAdapter(pool, options),
  });
  return Object.freeze({
    dataPlaneContext: context,
    claims: createClaimIngestionRepository(pool, options),
    claimsRead,
    desktopSync: createDesktopSyncRepository(pool, claimsRead, options),
    members: scopedReads.members,
    providers: scopedReads.providers,
    claimProcessingOutbox: createClaimProcessingOutboxRepository(pool, options),
    investigations,
    cases,
    ledger: createLedgerRepository(db, pool, options),
    registry: createSharedFraudRegistryRepository(pool, options),
    fraudWorkflow: createDisabledLegacyFraudWorkflowAdapter(context.operationalTenantId),
    reportSnapshots: scopedReads.reportSnapshots,
    tenants: createTenantRepository(pool, { dataPlaneContext: context, allowLegacyDefault: false }),
    detectionStrategy: createDetectionStrategyRepository(db, pool, options),
  });
}
