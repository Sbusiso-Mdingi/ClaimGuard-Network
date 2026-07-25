import React, { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import Search from "lucide-react/dist/esm/icons/search.mjs";
import { useRole } from "../../context/RoleContext";
import { apiJson, apiRequest } from "../../lib/apiClient";
import {
  DataTableShell,
  EmptyState,
  FormField,
  PageFrame,
  SectionCard,
  StatusIndicator,
  WorkspaceNotice,
  formatEnumLabel,
} from "./InvestigatorUI";
import { Input } from "../../components/ui/input";
import { Button } from "../../components/ui/button";

const STATUS_OPTIONS = ["OPEN", "UNDER_REVIEW", "AWAITING_EVIDENCE", "CONFIRMED_FRAUD", "REVERSED", "NO_FRAUD_FOUND", "CLOSED"];
const PRIORITY_OPTIONS = ["LOW", "NORMAL", "HIGH", "CRITICAL"];

function formatDate(value) {
  if (!value) return "Not available";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Not available" : date.toLocaleString();
}

function priorityTone(priority) {
  if (priority === "CRITICAL") return "danger";
  if (priority === "HIGH") return "warning";
  if (priority === "LOW") return "info";
  return "neutral";
}

export function InvestigationsPage() {
  const { identity } = useRole();
  const [investigations, setInvestigations] = useState([]);
  const [pagination, setPagination] = useState({ page: 1, total: 0, totalPages: 0, hasNextPage: false, hasPreviousPage: false });
  const [filters, setFilters] = useState({ search: "", status: "", priority: "", assignment: "all" });
  const [appliedFilters, setAppliedFilters] = useState(filters);
  const [status, setStatus] = useState("loading");
  const [error, setError] = useState("");
  const [lookupId, setLookupId] = useState("");
  const [lookupError, setLookupError] = useState("");
  const [checking, setChecking] = useState(false);

  const loadQueue = useCallback(async (page = 1) => {
    setStatus((previous) => previous === "ready" ? "refreshing" : "loading");
    setError("");
    try {
      const query = new URLSearchParams({ page: String(page), pageSize: "25", assignment: appliedFilters.assignment });
      if (appliedFilters.search) query.set("search", appliedFilters.search);
      if (appliedFilters.status) query.set("status", appliedFilters.status);
      if (appliedFilters.priority) query.set("priority", appliedFilters.priority);
      const result = await apiJson(`/investigations/queue?${query.toString()}`, { cache: "no-store" });
      setInvestigations(result.investigations || []);
      setPagination(result.pagination || { page, total: 0, totalPages: 0, hasNextPage: false, hasPreviousPage: false });
      setStatus("ready");
    } catch (loadError) {
      setError(loadError?.message || "Failed to load the investigation queue.");
      setStatus("error");
    }
  }, [appliedFilters]);

  useEffect(() => {
    loadQueue(1);
  }, [loadQueue]);

  function applyFilters(event) {
    event.preventDefault();
    setAppliedFilters({
      search: filters.search.trim(),
      status: filters.status,
      priority: filters.priority,
      assignment: filters.assignment,
    });
  }

  function clearFilters() {
    const cleared = { search: "", status: "", priority: "", assignment: "all" };
    setFilters(cleared);
    setAppliedFilters(cleared);
  }

  async function handleOpenById(event) {
    event.preventDefault();
    const canonicalId = lookupId.trim();
    if (!canonicalId) return;
    setChecking(true);
    setLookupError("");
    try {
      const response = await apiRequest(`/investigations/${encodeURIComponent(canonicalId)}`);
      const json = await response.json().catch(() => ({}));
      if (!response.ok || !json.available) {
        setLookupError(json.message || "Investigation not found for the active tenant.");
        return;
      }
      window.location.assign(`/investigations/${encodeURIComponent(canonicalId)}`);
    } catch {
      setLookupError("Could not reach the API.");
    } finally {
      setChecking(false);
    }
  }

  const activeFilterCount = useMemo(
    () => [appliedFilters.search, appliedFilters.status, appliedFilters.priority, appliedFilters.assignment !== "all"].filter(Boolean).length,
    [appliedFilters],
  );

  return (
    <PageFrame
      eyebrow="Investigations"
      title="Investigation queue"
      description={`Authoritative tenant-scoped cases for ${identity.label}, ordered by most recent activity.`}
      actions={[
        <StatusIndicator key="count" variant="badge">{pagination.total || 0} cases</StatusIndicator>,
        <Button key="refresh" variant="outline" onClick={() => loadQueue(pagination.page || 1)} disabled={status === "loading" || status === "refreshing"}>
          {status === "refreshing" ? "Refreshing..." : "Refresh queue"}
        </Button>,
      ]}
    >
      <SectionCard title="Filter cases" description="Search by investigation or claim ID and narrow the tenant queue by workflow state.">
        <form onSubmit={applyFilters} className="grid gap-4 lg:grid-cols-4">
          <FormField label="Search">
            <Input value={filters.search} onChange={(event) => setFilters((previous) => ({ ...previous, search: event.target.value }))} placeholder="Investigation or claim ID" />
          </FormField>
          <FormField label="Status">
            <select className="h-9 rounded-md border border-input bg-background px-3 text-sm" value={filters.status} onChange={(event) => setFilters((previous) => ({ ...previous, status: event.target.value }))}>
              <option value="">All statuses</option>
              {STATUS_OPTIONS.map((value) => <option key={value} value={value}>{formatEnumLabel(value)}</option>)}
            </select>
          </FormField>
          <FormField label="Priority">
            <select className="h-9 rounded-md border border-input bg-background px-3 text-sm" value={filters.priority} onChange={(event) => setFilters((previous) => ({ ...previous, priority: event.target.value }))}>
              <option value="">All priorities</option>
              {PRIORITY_OPTIONS.map((value) => <option key={value} value={value}>{formatEnumLabel(value)}</option>)}
            </select>
          </FormField>
          <FormField label="Assignment">
            <select className="h-9 rounded-md border border-input bg-background px-3 text-sm" value={filters.assignment} onChange={(event) => setFilters((previous) => ({ ...previous, assignment: event.target.value }))}>
              <option value="all">All cases</option>
              <option value="mine">Assigned to me</option>
              <option value="assigned">Assigned</option>
              <option value="unassigned">Unassigned</option>
            </select>
          </FormField>
          <div className="flex flex-wrap gap-2 lg:col-span-4">
            <Button type="submit">Apply filters</Button>
            <Button type="button" variant="outline" onClick={clearFilters} disabled={activeFilterCount === 0}>Clear filters</Button>
          </div>
        </form>
      </SectionCard>

      {status === "error" ? (
        <WorkspaceNotice title="Investigation queue unavailable" tone="danger" actions={<Button variant="outline" onClick={() => loadQueue(1)}>Retry</Button>}>
          {error}
        </WorkspaceNotice>
      ) : null}

      <SectionCard title="Tenant cases" description="Cases are read directly from the active operational tenant, not browser storage.">
        {status === "loading" ? (
          <WorkspaceNotice title="Loading investigation queue">Reading the latest case state from the active tenant.</WorkspaceNotice>
        ) : investigations.length === 0 && status !== "error" ? (
          <EmptyState icon={Search} title="No investigations found" description={activeFilterCount > 0 ? "No cases match the current filters." : "Escalated claims will appear here automatically."} compact />
        ) : (
          <DataTableShell label="Investigation queue">
            <table className="w-full min-w-[900px] text-left text-sm">
              <thead className="border-b border-border/70 text-xs uppercase tracking-wider text-muted-foreground">
                <tr>
                  <th className="px-4 py-3">Investigation</th>
                  <th className="px-4 py-3">Claim</th>
                  <th className="px-4 py-3">Status</th>
                  <th className="px-4 py-3">Priority</th>
                  <th className="px-4 py-3">Assignment</th>
                  <th className="px-4 py-3">Case material</th>
                  <th className="px-4 py-3">Updated</th>
                  <th className="px-4 py-3"><span className="sr-only">Action</span></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border/70">
                {investigations.map((investigation) => (
                  <tr key={investigation.investigationId}>
                    <td className="px-4 py-4 font-data text-xs">{investigation.investigationId}</td>
                    <td className="px-4 py-4 font-data text-xs">{investigation.claimId}</td>
                    <td className="px-4 py-4"><StatusIndicator variant="badge">{formatEnumLabel(investigation.status)}</StatusIndicator></td>
                    <td className="px-4 py-4"><StatusIndicator variant="badge" tone={priorityTone(investigation.priority)}>{formatEnumLabel(investigation.priority)}</StatusIndicator></td>
                    <td className="px-4 py-4">{investigation.assignedInvestigator || "Unassigned"}</td>
                    <td className="px-4 py-4 text-muted-foreground">{investigation.noteCount} notes · {investigation.evidenceCount} evidence</td>
                    <td className="px-4 py-4 text-muted-foreground">{formatDate(investigation.updatedAt)}</td>
                    <td className="px-4 py-4 text-right"><Link to={`/investigations/${encodeURIComponent(investigation.investigationId)}`} className="font-medium text-primary hover:underline">Open workspace</Link></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </DataTableShell>
        )}

        {pagination.totalPages > 1 ? (
          <div className="mt-4 flex items-center justify-between gap-3">
            <Button variant="outline" size="sm" disabled={!pagination.hasPreviousPage || status === "refreshing"} onClick={() => loadQueue(pagination.page - 1)}>Previous</Button>
            <span className="text-sm text-muted-foreground">Page {pagination.page} of {pagination.totalPages}</span>
            <Button variant="outline" size="sm" disabled={!pagination.hasNextPage || status === "refreshing"} onClick={() => loadQueue(pagination.page + 1)}>Next</Button>
          </div>
        ) : null}
      </SectionCard>

      <SectionCard title="Open by investigation ID" description="Use direct lookup when you have an ID that is outside the current filter or page.">
        <form onSubmit={handleOpenById} className="flex flex-wrap gap-3">
          <Input value={lookupId} onChange={(event) => setLookupId(event.target.value)} placeholder="investigation-id" className="max-w-xs" />
          <Button type="submit" disabled={checking || !lookupId.trim()}>{checking ? "Checking..." : "Open"}</Button>
        </form>
        {lookupError ? <p className="mt-2 text-sm text-destructive" role="alert">{lookupError}</p> : null}
      </SectionCard>
    </PageFrame>
  );
}
