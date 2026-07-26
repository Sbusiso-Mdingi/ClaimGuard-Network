import { repositoryTenantId } from "./repository-context.js";
import {
  INVESTIGATION_PRIORITY,
  INVESTIGATION_STATUS,
  InvestigationValidationError,
  normalizeInvestigationPriority,
  normalizeInvestigationStatus,
} from "./investigation-repository.js";

const DEFAULT_PAGE_SIZE = 25;
const MAX_PAGE_SIZE = 100;
const ASSIGNMENT_FILTERS = new Set(["all", "mine", "assigned", "unassigned"]);

function positiveInteger(value, fallback, maximum = Number.MAX_SAFE_INTEGER) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isInteger(parsed) || parsed < 1) return fallback;
  return Math.min(parsed, maximum);
}

function optionalSearch(value) {
  const rendered = String(value ?? "").trim();
  if (!rendered) return null;
  if (rendered.length > 128) {
    throw new InvestigationValidationError("search must be at most 128 characters.", "invalid_search");
  }
  return rendered;
}

function assignmentFilter(value) {
  const rendered = String(value || "all").trim().toLowerCase();
  if (!ASSIGNMENT_FILTERS.has(rendered)) {
    throw new InvestigationValidationError("Unsupported assignment filter.", "invalid_assignment");
  }
  return rendered;
}

function mapQueueRow(row) {
  return {
    investigationId: row.investigation_id,
    claimId: row.claim_id,
    assignedInvestigator: row.assigned_investigator,
    assignedBy: row.assigned_by,
    status: row.status,
    priority: row.priority,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    closedAt: row.closed_at,
    fraudConfirmedAt: row.fraud_confirmed_at,
    reversedAt: row.reversed_at ?? null,
    noteCount: Number(row.note_count || 0),
    evidenceCount: Number(row.evidence_count || 0),
  };
}

export function createInvestigationQueueRepository(
  pool,
  { dataPlaneContext = null, allowLegacyTenantContext = false } = {},
) {
  if (!pool || typeof pool.execute !== "function") {
    throw new Error("A mysql2 pool with execute support is required for investigation queue repository.");
  }
  if (!dataPlaneContext && !allowLegacyTenantContext) repositoryTenantId(null);
  const canonicalTenantId = () => repositoryTenantId(dataPlaneContext, { allowLegacyTenantContext });

  return {
    async listInvestigations({
      page = 1,
      pageSize = DEFAULT_PAGE_SIZE,
      status = null,
      priority = null,
      search = null,
      assignment = "all",
      actorId = null,
    } = {}) {
      const tenantId = canonicalTenantId();
      const canonicalPage = positiveInteger(page, 1);
      const canonicalPageSize = positiveInteger(pageSize, DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);
      const canonicalStatus = status ? normalizeInvestigationStatus(status) : null;
      const canonicalPriority = priority ? normalizeInvestigationPriority(priority) : null;
      const canonicalSearch = optionalSearch(search);
      const canonicalAssignment = assignmentFilter(assignment);
      const canonicalActorId = String(actorId || "").trim() || null;

      if (canonicalAssignment === "mine" && !canonicalActorId) {
        throw new InvestigationValidationError(
          "An authenticated actor is required for the mine assignment filter.",
          "assignment_actor_required",
        );
      }

      const conditions = ["i.tenant_id = ?"];
      const parameters = [tenantId];

      if (canonicalStatus) {
        conditions.push("i.status = ?");
        parameters.push(canonicalStatus);
      }
      if (canonicalPriority) {
        conditions.push("i.priority = ?");
        parameters.push(canonicalPriority);
      }
      if (canonicalSearch) {
        conditions.push("(i.investigation_id LIKE ? OR i.claim_id LIKE ?)");
        const pattern = `%${canonicalSearch.replaceAll("%", "\\%").replaceAll("_", "\\_")}%`;
        parameters.push(pattern, pattern);
      }
      if (canonicalAssignment === "mine") {
        conditions.push("i.assigned_investigator = ?");
        parameters.push(canonicalActorId);
      } else if (canonicalAssignment === "assigned") {
        conditions.push("i.assigned_investigator IS NOT NULL");
      } else if (canonicalAssignment === "unassigned") {
        conditions.push("i.assigned_investigator IS NULL");
      }

      const whereClause = conditions.join(" AND ");
      const offset = (canonicalPage - 1) * canonicalPageSize;
      const [countRows] = await pool.execute(
        `SELECT COUNT(*) AS total FROM investigations i WHERE ${whereClause}`,
        parameters,
      );
      const total = Number(countRows?.[0]?.total || 0);
      const totalPages = total === 0 ? 0 : Math.ceil(total / canonicalPageSize);

      const [rows] = await pool.execute(
        `
          SELECT
            i.investigation_id,
            i.claim_id,
            i.assigned_investigator,
            i.assigned_by,
            i.status,
            i.priority,
            i.created_at,
            i.updated_at,
            i.closed_at,
            i.fraud_confirmed_at,
            i.reversed_at,
            (
              SELECT COUNT(*)
              FROM investigation_notes n
              WHERE n.tenant_id = i.tenant_id
                AND n.investigation_id = i.investigation_id
            ) AS note_count,
            (
              SELECT COUNT(*)
              FROM investigation_evidence e
              WHERE e.tenant_id = i.tenant_id
                AND e.investigation_id = i.investigation_id
            ) AS evidence_count
          FROM investigations i
          WHERE ${whereClause}
          ORDER BY i.updated_at DESC, i.investigation_id DESC
          LIMIT ${canonicalPageSize} OFFSET ${offset}
        `,
        parameters,
      );

      return {
        investigations: (rows || []).map(mapQueueRow),
        pagination: {
          page: canonicalPage,
          pageSize: canonicalPageSize,
          requestedPageSize: positiveInteger(pageSize, DEFAULT_PAGE_SIZE),
          maxPageSize: MAX_PAGE_SIZE,
          total,
          totalPages,
          hasNextPage: canonicalPage < totalPages,
          hasPreviousPage: canonicalPage > 1 && totalPages > 0,
        },
        filters: {
          status: canonicalStatus,
          priority: canonicalPriority,
          search: canonicalSearch,
          assignment: canonicalAssignment,
        },
      };
    },
  };
}

export const INVESTIGATION_QUEUE_DEFAULT_PAGE_SIZE = DEFAULT_PAGE_SIZE;
export const INVESTIGATION_QUEUE_MAX_PAGE_SIZE = MAX_PAGE_SIZE;
export const INVESTIGATION_QUEUE_STATUSES = INVESTIGATION_STATUS;
export const INVESTIGATION_QUEUE_PRIORITIES = INVESTIGATION_PRIORITY;
