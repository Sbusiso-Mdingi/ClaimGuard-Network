import React, { useEffect, useState } from "react";
import { ApiError, safeApiErrorMessage } from "../../lib/apiClient";
import {
  EmptyState,
  PageFrame,
  SectionCard,
  StatusIndicator,
  WorkspaceNotice,
} from "../investigator/InvestigatorUI";
import { Button } from "../../components/ui/button";
import { fetchAudit } from "./accessApi";
import { formatDate, formatStatus } from "./accessFormatting";

export function AccessAuditPage() {
  const [entries, setEntries] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState(null);
  const [page, setPage] = useState(1);
  const [hasMore, setHasMore] = useState(false);
  const [filters, setFilters] = useState({ action: "", actor: "", outcome: "" });
  const [appliedFilters, setAppliedFilters] = useState({ action: "", actor: "", outcome: "" });

  function loadPage(pageNum, currentFilters, append = false) {
    const setter = append ? setLoadingMore : setLoading;
    setter(true);
    if (!append) setError(null);
    fetchAudit({ page: pageNum, limit: 50, ...Object.fromEntries(Object.entries(currentFilters).filter(([, v]) => v)) })
      .then((result) => {
        const rows = Array.isArray(result?.entries) ? result.entries : Array.isArray(result) ? result : [];
        setEntries((prev) => append ? [...prev, ...rows] : rows);
        setHasMore(result?.hasMore ?? rows.length === 50);
        setter(false);
      })
      .catch((err) => {
        if (!append) setError(err);
        setter(false);
      });
  }

  useEffect(() => {
    setPage(1);
    setEntries([]);
    loadPage(1, appliedFilters, false);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [appliedFilters]);

  function applyFilters(e) {
    e.preventDefault();
    setAppliedFilters({ ...filters });
  }

  function loadNext() {
    const next = page + 1;
    setPage(next);
    loadPage(next, appliedFilters, true);
  }

  if (loading) {
    return (
      <PageFrame title="Audit log">
        <WorkspaceNotice title="Loading audit log">Reading audit records from the server.</WorkspaceNotice>
      </PageFrame>
    );
  }

  if (error instanceof ApiError && error.status === 403) {
    return (
      <PageFrame title="Audit log">
        <WorkspaceNotice title="Permission denied" tone="danger">You do not have permission to view this section.</WorkspaceNotice>
      </PageFrame>
    );
  }

  if (error instanceof ApiError && error.status === 404) {
    return (
      <PageFrame title="Audit log">
        <WorkspaceNotice title="Resource unavailable" tone="danger">This resource is not available.</WorkspaceNotice>
      </PageFrame>
    );
  }

  if (error) {
    return (
      <PageFrame title="Audit log">
        <WorkspaceNotice title="Audit log unavailable" tone="danger">{safeApiErrorMessage(error)}</WorkspaceNotice>
      </PageFrame>
    );
  }

  return (
    <PageFrame title="Audit log" description="Immutable access audit records.">
      <WorkspaceNotice title="Immutable record" tone="info">
        This record is immutable.
      </WorkspaceNotice>

      <SectionCard title="Filters">
        <form onSubmit={applyFilters} className="flex flex-wrap gap-3 p-1">
          <label className="flex flex-col gap-1">
            <span className="text-xs font-medium text-muted-foreground">Action</span>
            <input
              type="text"
              aria-label="Filter by action"
              value={filters.action}
              onChange={(e) => setFilters((f) => ({ ...f, action: e.target.value }))}
              placeholder="e.g. roles.assign"
              className="h-9 rounded-md border border-input bg-background px-3 text-sm"
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-xs font-medium text-muted-foreground">Actor</span>
            <input
              type="text"
              aria-label="Filter by actor"
              value={filters.actor}
              onChange={(e) => setFilters((f) => ({ ...f, actor: e.target.value }))}
              placeholder="User ID or identifier"
              className="h-9 rounded-md border border-input bg-background px-3 text-sm"
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-xs font-medium text-muted-foreground">Outcome</span>
            <select
              aria-label="Filter by outcome"
              value={filters.outcome}
              onChange={(e) => setFilters((f) => ({ ...f, outcome: e.target.value }))}
              className="h-9 rounded-md border border-input bg-background px-3 text-sm"
            >
              <option value="">All outcomes</option>
              <option value="success">Success</option>
              <option value="failure">Failure</option>
              <option value="denied">Denied</option>
            </select>
          </label>
          <div className="flex items-end">
            <Button type="submit" variant="outline" size="sm">Apply filters</Button>
          </div>
        </form>
      </SectionCard>

      {entries.length === 0 ? (
        <EmptyState title="No audit entries" description="No audit records match the current filters." />
      ) : (
        <SectionCard title={`Audit entries (${entries.length}${hasMore ? "+" : ""})`}>
          <div className="overflow-x-auto">
            <table className="w-full text-sm" aria-label="Audit log">
              <thead>
                <tr className="border-b border-border text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  <th className="px-4 py-3">Timestamp</th>
                  <th className="px-4 py-3">Action</th>
                  <th className="px-4 py-3">Actor</th>
                  <th className="px-4 py-3">Subject</th>
                  <th className="px-4 py-3">Target type</th>
                  <th className="px-4 py-3">Target</th>
                  <th className="px-4 py-3">Before</th>
                  <th className="px-4 py-3">After</th>
                  <th className="px-4 py-3">Outcome</th>
                  <th className="px-4 py-3">Reason</th>
                  <th className="px-4 py-3">Correlation</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {entries.map((e, idx) => (
                  <tr key={e.auditId || idx} className="hover:bg-accent/50">
                    <td className="px-4 py-3 text-xs">{formatDate(e.timestamp || e.createdAt)}</td>
                    <td className="px-4 py-3 font-data text-xs">{e.action || "—"}</td>
                    <td className="px-4 py-3 font-data text-xs">{e.actor || "—"}</td>
                    <td className="px-4 py-3 font-data text-xs">{e.subject || "—"}</td>
                    <td className="px-4 py-3 text-xs">{formatStatus(e.targetType)}</td>
                    <td className="px-4 py-3 font-data text-xs">{e.target || "—"}</td>
                    <td className="px-4 py-3 font-data text-xs">{e.beforeVersion ?? "—"}</td>
                    <td className="px-4 py-3 font-data text-xs">{e.afterVersion ?? "—"}</td>
                    <td className="px-4 py-3">
                      <StatusIndicator tone={e.outcome === "success" ? "success" : e.outcome === "failure" || e.outcome === "denied" ? "danger" : "info"}>
                        {formatStatus(e.outcome)}
                      </StatusIndicator>
                    </td>
                    <td className="px-4 py-3 text-xs text-muted-foreground">{e.reason || "—"}</td>
                    <td className="px-4 py-3 font-data text-xs">{e.correlationRef || "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {hasMore && (
            <div className="border-t border-border p-4">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={loadNext}
                disabled={loadingMore}
              >
                {loadingMore ? "Loading…" : "Load next page"}
              </Button>
            </div>
          )}
        </SectionCard>
      )}
    </PageFrame>
  );
}
