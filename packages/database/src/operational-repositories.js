import { createClaimIngestionRepository } from "./claim-ingestion-repository.js";
import { createClaimsReadRepository } from "./prospective-claims-read-repository.js";
import { createClaimProcessingOutboxRepository } from "./claim-processing-outbox-repository.js";
import { createDatabaseFromPool } from "./client.js";
import { requireOperationalDataPlaneContext } from "./data-plane-context.js";
import { createFraudWorkflowRepository } from "./fraud-workflow-repository.js";
import { createInvestigationQueueRepository } from "./investigation-queue-repository.js";
import { createInvestigationRepository } from "./investigation-repository.js";
import { createCaseWorkflowRepository } from "./case-workflow-repository.js";
import { createLegacyCaseAdapter } from "./legacy-case-adapter.js";
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
    fraudWorkflow: createFraudWorkflowRepository(pool, options),
    reportSnapshots: scopedReads.reportSnapshots,
    tenants: createTenantRepository(pool, { dataPlaneContext: context, allowLegacyDefault: false }),
    detectionStrategy: createDetectionStrategyRepository(db, pool, options),
  });
}
