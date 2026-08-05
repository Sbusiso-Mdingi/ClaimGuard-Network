import { repositoryTenantId } from "./repository-context.js";
import { CasePolicyError, CASE_ERROR_CODE } from "./case-transition-policy.js";

function requiredId(value, fieldName) {
  if (typeof value !== "string" || !value.trim() || value.trim().length > 64) {
    throw new CasePolicyError(`${fieldName} is invalid.`, CASE_ERROR_CODE.VALIDATION_FAILED);
  }
  return value.trim();
}

function mapCase(row) {
  if (!row) return null;
  return {
    caseId: row.case_id,
    tenantId: row.tenant_id,
    signalId: row.signal_id,
    claimId: row.claim_id,
    claimVersion: Number(row.claim_version),
    currentState: row.current_state,
    stateVersion: Number(row.state_version),
    assignedInvestigatorId: row.assigned_investigator_id || null,
    triageOwnerId: row.triage_owner_id || null,
    originatingReason: row.originating_reason || null,
    correlationId: row.correlation_id,
    lastTransitionEventId: row.last_transition_event_id || null,
    reportCompletingInvestigatorId: row.report_completing_investigator_id || null,
    reportReference: row.report_reference || null,
    reportDigest: row.report_digest || null,
    reportCompletionEventId: row.report_completion_event_id || null,
    legacyInvestigationId: row.legacy_investigation_id || null,
    legacyStatus: row.legacy_status || null,
    migrationReviewStatus: row.migration_review_status || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function createLegacyCaseReadRepository(
  pool,
  { dataPlaneContext = null, allowLegacyTenantContext = false } = {},
) {
  if (!pool || typeof pool.execute !== "function") {
    throw new TypeError("A mysql2 pool with execute support is required for legacy case reads.");
  }
  if (!dataPlaneContext && !allowLegacyTenantContext) repositoryTenantId(null);
  const canonicalTenantId = () => repositoryTenantId(dataPlaneContext, { allowLegacyTenantContext });

  return Object.freeze({
    async getCaseByLegacyInvestigationId(legacyInvestigationId) {
      const tenantId = canonicalTenantId();
      const investigationId = requiredId(legacyInvestigationId, "legacyInvestigationId");
      const [rows] = await pool.execute(
        `SELECT case_id, tenant_id, signal_id, claim_id, claim_version, current_state,
                state_version, assigned_investigator_id, triage_owner_id,
                originating_reason, correlation_id, last_transition_event_id,
                report_completing_investigator_id, report_reference, report_digest,
                report_completion_event_id, legacy_investigation_id, legacy_status,
                migration_review_status, created_at, updated_at
           FROM investigation_cases
          WHERE tenant_id = ? AND legacy_investigation_id = ?
          LIMIT 1`,
        [tenantId, investigationId],
      );
      return mapCase(rows?.[0] || null);
    },
  });
}
