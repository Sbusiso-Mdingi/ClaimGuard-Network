import React, { useEffect, useMemo, useState } from "react";
import { ApiError, safeApiErrorMessage } from "../../lib/apiClient";
import {
  EmptyState,
  PageFrame,
  SectionCard,
  StatusIndicator,
  WorkspaceNotice,
} from "../investigator/InvestigatorUI";
import { fetchPermissions } from "./accessApi";
import { formatPermissionKey, formatStatus } from "./accessFormatting";

const ALL_CATEGORIES = "all";

export function PermissionCataloguePage() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [search, setSearch] = useState("");
  const [category, setCategory] = useState(ALL_CATEGORIES);
  const [elevatedFilter, setElevatedFilter] = useState("all");

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetchPermissions()
      .then((result) => { if (!cancelled) { setData(result); setLoading(false); } })
      .catch((err) => { if (!cancelled) { setError(err); setLoading(false); } });
    return () => { cancelled = true; };
  }, []);

  const permissions = Array.isArray(data?.permissions) ? data.permissions : Array.isArray(data) ? data : [];

  const categories = useMemo(() => {
    const cats = new Set(permissions.map((p) => p.category).filter(Boolean));
    return [ALL_CATEGORIES, ...Array.from(cats).sort()];
  }, [permissions]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return permissions.filter((p) => {
      if (q && !String(p.key || "").toLowerCase().includes(q) && !String(p.label || "").toLowerCase().includes(q)) return false;
      if (category !== ALL_CATEGORIES && p.category !== category) return false;
      if (elevatedFilter === "elevated" && !p.elevated) return false;
      if (elevatedFilter === "ordinary" && p.elevated) return false;
      return true;
    });
  }, [permissions, search, category, elevatedFilter]);

  if (loading) {
    return (
      <PageFrame title="Permission catalogue">
        <WorkspaceNotice title="Loading permissions">Reading the permission catalogue from the server.</WorkspaceNotice>
      </PageFrame>
    );
  }

  if (error instanceof ApiError && error.status === 403) {
    return (
      <PageFrame title="Permission catalogue">
        <WorkspaceNotice title="Permission denied" tone="danger">You do not have permission to view this section.</WorkspaceNotice>
      </PageFrame>
    );
  }

  if (error instanceof ApiError && error.status === 404) {
    return (
      <PageFrame title="Permission catalogue">
        <WorkspaceNotice title="Resource unavailable" tone="danger">This resource is not available.</WorkspaceNotice>
      </PageFrame>
    );
  }

  if (error) {
    return (
      <PageFrame title="Permission catalogue">
        <WorkspaceNotice title="Permission catalogue unavailable" tone="danger">{safeApiErrorMessage(error)}</WorkspaceNotice>
      </PageFrame>
    );
  }

  return (
    <PageFrame title="Permission catalogue" description="All permissions defined in this deployment.">
      <SectionCard title="Filters">
        <div className="flex flex-wrap gap-3 p-1">
          <label className="flex flex-col gap-1">
            <span className="text-xs font-medium text-muted-foreground">Search</span>
            <input
              type="search"
              aria-label="Search permissions"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Key or label…"
              className="h-9 rounded-md border border-input bg-background px-3 text-sm"
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-xs font-medium text-muted-foreground">Category</span>
            <select
              aria-label="Filter by category"
              value={category}
              onChange={(e) => setCategory(e.target.value)}
              className="h-9 rounded-md border border-input bg-background px-3 text-sm"
            >
              {categories.map((c) => (
                <option key={c} value={c}>{c === ALL_CATEGORIES ? "All categories" : c}</option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-xs font-medium text-muted-foreground">Type</span>
            <select
              aria-label="Filter by elevated status"
              value={elevatedFilter}
              onChange={(e) => setElevatedFilter(e.target.value)}
              className="h-9 rounded-md border border-input bg-background px-3 text-sm"
            >
              <option value="all">All</option>
              <option value="ordinary">Ordinary</option>
              <option value="elevated">Elevated</option>
            </select>
          </label>
        </div>
      </SectionCard>

      {filtered.length === 0 ? (
        <EmptyState title="No permissions found" description="No permissions match the current filters." />
      ) : (
        <SectionCard title={`Permissions (${filtered.length})`}>
          <div className="overflow-x-auto">
            <table className="w-full text-sm" aria-label="Permission catalogue">
              <thead>
                <tr className="border-b border-border text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  <th className="px-4 py-3">Key</th>
                  <th className="px-4 py-3">Label</th>
                  <th className="px-4 py-3">Category</th>
                  <th className="px-4 py-3">Type</th>
                  <th className="px-4 py-3">Status</th>
                  <th className="px-4 py-3">Flags</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {filtered.map((perm) => (
                  <tr key={perm.key} className="hover:bg-accent/50">
                    <td className="px-4 py-3 font-data text-xs">{formatPermissionKey(perm.key)}</td>
                    <td className="px-4 py-3">{perm.label || "—"}</td>
                    <td className="px-4 py-3">{perm.category || "—"}</td>
                    <td className="px-4 py-3">
                      {perm.elevated
                        ? <StatusIndicator tone="warning">Elevated</StatusIndicator>
                        : <StatusIndicator tone="info">Ordinary</StatusIndicator>
                      }
                    </td>
                    <td className="px-4 py-3">
                      <StatusIndicator tone={perm.active !== false ? "success" : "danger"}>
                        {formatStatus(perm.active !== false ? "active" : "inactive")}
                      </StatusIndicator>
                    </td>
                    <td className="px-4 py-3">
                      <span className="flex flex-wrap gap-1">
                        {perm.tenantAssignable && <StatusIndicator tone="info">Tenant-assignable</StatusIndicator>}
                        {perm.delegable && <StatusIndicator tone="info">Delegable</StatusIndicator>}
                        {perm.systemOnly && <StatusIndicator tone="warning">System-only</StatusIndicator>}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </SectionCard>
      )}
    </PageFrame>
  );
}
