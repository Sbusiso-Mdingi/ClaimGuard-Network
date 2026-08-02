import { repositoryTenantId } from "./repository-context.js";

function validDate(value, fieldName) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new TypeError(`${fieldName} must be a valid date.`);
  return date;
}

function safeLimit(value) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Math.max(1, Math.min(500, Number.isInteger(parsed) ? parsed : 500));
}

function investigationChange(row) {
  const closed = row.status === "CLOSED";
  return {
    resource: "investigation",
    operation: closed ? "delete" : "upsert",
    id: row.investigation_id,
    version: String(row.record_version || 1),
    updatedAt: row.updated_at,
    ...(closed ? {} : {
      record: {
        investigationId: row.investigation_id,
        claimId: row.claim_id,
        assignedInvestigator: row.assigned_investigator || null,
        assignedBy: row.assigned_by,
        status: row.status,
        priority: row.priority,
        recordVersion: Number(row.record_version || 1),
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        closedAt: row.closed_at || null,
        fraudConfirmedAt: row.fraud_confirmed_at || null,
        reversedAt: row.reversed_at || null,
      },
    }),
  };
}

function compareChanges(left, right) {
  const time = new Date(left.updatedAt).getTime() - new Date(right.updatedAt).getTime();
  if (time !== 0) return time;
  const resource = left.resource.localeCompare(right.resource);
  return resource !== 0 ? resource : left.id.localeCompare(right.id);
}

export function createDesktopSyncRepository(
  pool,
  claimsReadRepository,
  { dataPlaneContext = null, allowLegacyTenantContext = false } = {},
) {
  if (!pool || typeof pool.execute !== "function" || !claimsReadRepository?.listDesktopClaimChanges) {
    throw new TypeError("A verified operational pool and desktop-capable claims repository are required.");
  }
  const canonicalTenantId = () => repositoryTenantId(dataPlaneContext, { allowLegacyTenantContext });

  return Object.freeze({
    async listChanges({ scopeStart, watermarks = {}, limit = 500 } = {}) {
      const tenantId = canonicalTenantId();
      const retentionStart = validDate(scopeStart, "scopeStart");
      const pageLimit = safeLimit(limit);
      const claimsWatermark = watermarks.claims || {};
      const investigationsWatermark = watermarks.investigations || {};
      const claimResult = await claimsReadRepository.listDesktopClaimChanges({
        scopeStart: retentionStart,
        afterUpdatedAt: claimsWatermark.updatedAt || null,
        afterClaimId: claimsWatermark.id || null,
        limit: pageLimit,
      });
      const parameters = [tenantId, retentionStart];
      let cursorPredicate = "";
      if (investigationsWatermark.updatedAt && investigationsWatermark.id) {
        const cursorDate = validDate(investigationsWatermark.updatedAt, "investigations watermark");
        cursorPredicate = "AND (i.updated_at > ? OR (i.updated_at = ? AND i.investigation_id > ?))";
        parameters.push(cursorDate, cursorDate, investigationsWatermark.id);
      }
      const [rows] = await pool.execute(
        `SELECT i.investigation_id, i.claim_id, i.assigned_investigator, i.assigned_by,
                i.status, i.priority, i.record_version, i.created_at, i.updated_at, i.closed_at,
                i.fraud_confirmed_at, i.reversed_at
         FROM investigations i
         WHERE i.tenant_id = ?
           AND (i.status <> 'CLOSED' OR i.updated_at >= ?)
           ${cursorPredicate}
         ORDER BY i.updated_at ASC, i.investigation_id ASC
         LIMIT ${pageLimit + 1}`,
        parameters,
      );
      const investigationHasMore = (rows || []).length > pageLimit;
      const investigationChanges = (rows || []).slice(0, pageLimit).map(investigationChange);
      const changes = [...claimResult.changes, ...investigationChanges]
        .sort(compareChanges)
        .slice(0, pageLimit);
      return {
        changes,
        hasMore: claimResult.hasMore || investigationHasMore || claimResult.changes.length + investigationChanges.length > pageLimit,
      };
    },

    async currentProjections() {
      const overview = await claimsReadRepository.getClaimsOverview();
      return {
        dashboard: {
          resource: "dashboard",
          operation: "replace",
          id: "current",
          version: String(overview.generatedAt || new Date().toISOString()),
          updatedAt: overview.generatedAt || new Date().toISOString(),
          record: { generatedAt: overview.generatedAt, summary: overview.summary },
        },
        suspiciousNetwork: {
          resource: "suspicious_network",
          operation: "replace",
          id: "current",
          version: String(overview.generatedAt || new Date().toISOString()),
          updatedAt: overview.generatedAt || new Date().toISOString(),
          record: overview.graph,
        },
      };
    },
  });
}
