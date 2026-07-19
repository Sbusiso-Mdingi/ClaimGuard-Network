import { createClaimIngestionRepository } from "./claim-ingestion-repository.js";
import { createClaimsReadRepository } from "./claims-read-repository.js";
import { createClaimProcessingOutboxRepository } from "./claim-processing-outbox-repository.js";
import { createDatabaseFromPool } from "./client.js";
import { requireOperationalDataPlaneContext } from "./data-plane-context.js";
import { createFraudWorkflowRepository } from "./fraud-workflow-repository.js";
import { createInvestigationRepository } from "./investigation-repository.js";
import { createLedgerRepository } from "./ledger-repository.js";
import { createSharedFraudRegistryRepository } from "./shared-fraud-registry-repository.js";
import { createScopedReadRepositories } from "./scoped-read-repositories.js";
import { createTenantRepository } from "./tenant-repository.js";

export function createOperationalRepositories(dataPlaneContext, pool) {
  const context = requireOperationalDataPlaneContext(dataPlaneContext);
  if (!pool || typeof pool.execute !== "function") throw new TypeError("A verified operational pool is required.");
  const db = createDatabaseFromPool(pool);
  const options = { dataPlaneContext: context, allowLegacyTenantContext: false };
  const scopedReads = createScopedReadRepositories(context, pool);
  return Object.freeze({
    dataPlaneContext: context,
    claims: createClaimIngestionRepository(pool, options),
    claimsRead: createClaimsReadRepository(pool, options),
    members: scopedReads.members,
    providers: scopedReads.providers,
    claimProcessingOutbox: createClaimProcessingOutboxRepository(pool, options),
    investigations: createInvestigationRepository(pool, options),
    ledger: createLedgerRepository(db, pool, options),
    registry: createSharedFraudRegistryRepository(pool, options),
    fraudWorkflow: createFraudWorkflowRepository(pool, options),
    reportSnapshots: scopedReads.reportSnapshots,
    tenants: createTenantRepository(pool, { dataPlaneContext: context, allowLegacyDefault: false }),
  });
}
