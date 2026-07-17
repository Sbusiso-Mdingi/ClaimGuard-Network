import { repositoryTenantId } from "./repository-context.js";

function parsePositiveInteger(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function normalizeListParams({ page = 1, pageSize = 25, maxPageSize = 100 } = {}) {
  const normalizedPage = parsePositiveInteger(page, 1);
  const requestedPageSize = parsePositiveInteger(pageSize, 25);
  const normalizedMaxPageSize = parsePositiveInteger(maxPageSize, 100);
  const normalizedPageSize = Math.min(requestedPageSize, normalizedMaxPageSize);
  return {
    page: normalizedPage,
    pageSize: normalizedPageSize,
    requestedPageSize,
    maxPageSize: normalizedMaxPageSize,
    offset: (normalizedPage - 1) * normalizedPageSize,
  };
}

function mapClaimRow(row) {
  if (!row) return null;
  return {
    claimId: row.claim_id,
    schemeId: row.scheme_id,
    memberId: row.member_id,
    providerId: row.provider_id,
    serviceDate: row.service_date,
    billedAmount: Number(row.amount),
    billingCode: row.billing_code,
    submittedAt: row.created_at,
    updatedAt: row.updated_at,
    status: row.investigation_status || "SUBMITTED",
    riskScore: null,
    riskLevel: null,
    investigation: row.investigation_id
      ? {
          investigationId: row.investigation_id,
          status: row.investigation_status,
          priority: row.investigation_priority,
          updatedAt: row.investigation_updated_at,
        }
      : null,
  };
}

function placeholders(count) {
  return Array.from({ length: count }, () => "?").join(", ");
}

function attachLatestInvestigation(claimRows, investigationRows) {
  const byClaimId = new Map();
  for (const row of investigationRows || []) {
    if (!row?.claim_id || byClaimId.has(row.claim_id)) continue;
    byClaimId.set(row.claim_id, row);
  }

  return (claimRows || []).map((row) => {
    const investigation = byClaimId.get(row.claim_id) || null;
    return {
      ...row,
      investigation_id: investigation?.investigation_id || null,
      investigation_status: investigation?.status || null,
      investigation_priority: investigation?.priority || null,
      investigation_updated_at: investigation?.updated_at || null,
    };
  });
}

export function createClaimsReadRepository(pool, {
  dataPlaneContext = null,
  allowLegacyTenantContext = false,
  maxPageSize = 100,
} = {}) {
  if (!pool || typeof pool.execute !== "function") {
    throw new Error("A mysql2 pool with execute support is required for claims read repository.");
  }

  const canonicalTenantId = () => repositoryTenantId(dataPlaneContext, { allowLegacyTenantContext });

  return Object.freeze({
    async listClaims({ page = 1, pageSize = 25 } = {}) {
      const tenantId = canonicalTenantId();
      const paging = normalizeListParams({ page, pageSize, maxPageSize });

      const [countRows] = await pool.execute(
        "SELECT COUNT(*) AS total FROM claims WHERE tenant_id = ?",
        [tenantId],
      );
      const total = Number(countRows?.[0]?.total || 0);

      const [claimRows] = await pool.execute(
        `
          SELECT
            c.claim_id,
            c.scheme_id,
            c.member_id,
            c.provider_id,
            c.service_date,
            c.amount,
            c.billing_code,
            c.created_at,
            c.updated_at
          FROM claims c
          WHERE c.tenant_id = ?
            ORDER BY c.updated_at DESC, c.claim_id ASC
            LIMIT ${paging.pageSize} OFFSET ${paging.offset}
        `,
          [tenantId],
      );

      let enrichedRows = claimRows;
      const claimIds = claimRows.map((row) => row.claim_id).filter(Boolean);
      if (claimIds.length > 0) {
        const [investigationRows] = await pool.execute(
          `
            SELECT i.claim_id, i.investigation_id, i.status, i.priority, i.updated_at
            FROM investigations i
            INNER JOIN (
              SELECT claim_id, MAX(updated_at) AS latest_updated_at
              FROM investigations
              WHERE tenant_id = ? AND claim_id IN (${placeholders(claimIds.length)})
              GROUP BY claim_id
            ) latest
              ON latest.claim_id = i.claim_id
             AND latest.latest_updated_at = i.updated_at
            WHERE i.tenant_id = ? AND i.claim_id IN (${placeholders(claimIds.length)})
            ORDER BY i.updated_at DESC
          `,
          [tenantId, ...claimIds, tenantId, ...claimIds],
        );
        enrichedRows = attachLatestInvestigation(claimRows, investigationRows);
      }

      const claims = enrichedRows.map(mapClaimRow);
      return {
        claims,
        pagination: {
          page: paging.page,
          pageSize: paging.pageSize,
          requestedPageSize: paging.requestedPageSize,
          maxPageSize: paging.maxPageSize,
          total,
          totalPages: Math.max(1, Math.ceil(total / paging.pageSize)),
          hasNextPage: paging.offset + claims.length < total,
        },
      };
    },

    async getClaimById(claimId) {
      if (typeof claimId !== "string" || !claimId.trim()) return null;
      const tenantId = canonicalTenantId();
      const normalizedClaimId = claimId.trim();

      const [claimRows] = await pool.execute(
        `
          SELECT
            c.claim_id,
            c.scheme_id,
            c.member_id,
            c.provider_id,
            c.service_date,
            c.amount,
            c.billing_code,
            c.created_at,
            c.updated_at
          FROM claims c
          WHERE c.tenant_id = ? AND c.claim_id = ?
          LIMIT 1
        `,
        [tenantId, normalizedClaimId],
      );

      const baseClaim = claimRows?.[0] || null;
      if (!baseClaim) return null;

      const [investigationRows] = await pool.execute(
        `
          SELECT i.claim_id, i.investigation_id, i.status, i.priority, i.updated_at
          FROM investigations i
          INNER JOIN (
            SELECT claim_id, MAX(updated_at) AS latest_updated_at
            FROM investigations
            WHERE tenant_id = ? AND claim_id = ?
            GROUP BY claim_id
          ) latest
            ON latest.claim_id = i.claim_id
           AND latest.latest_updated_at = i.updated_at
          WHERE i.tenant_id = ? AND i.claim_id = ?
          LIMIT 1
        `,
        [tenantId, normalizedClaimId, tenantId, normalizedClaimId],
      );

      const merged = attachLatestInvestigation([baseClaim], investigationRows);

      return mapClaimRow(merged?.[0] || null);
    },
  });
}