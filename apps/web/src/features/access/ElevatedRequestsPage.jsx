import React, { useEffect, useState } from "react";
import { ApiError, safeApiErrorMessage } from "../../lib/apiClient";
import {
  EmptyState,
  PageFrame,
  SectionCard,
  StatusIndicator,
  WorkspaceNotice,
} from "../investigator/InvestigatorUI";
import { fetchElevatedRequests } from "./accessApi";
import { formatDate, formatElevatedDecision, formatStatus } from "./accessFormatting";

export function ElevatedRequestsPage() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetchElevatedRequests()
      .then((result) => { if (!cancelled) { setData(result); setLoading(false); } })
      .catch((err) => { if (!cancelled) { setError(err); setLoading(false); } });
    return () => { cancelled = true; };
  }, []);

  if (loading) {
    return (
      <PageFrame title="Elevated requests">
        <WorkspaceNotice title="Loading elevated requests">Reading elevated permission requests from the server.</WorkspaceNotice>
      </PageFrame>
    );
  }

  if (error instanceof ApiError && error.status === 403) {
    return (
      <PageFrame title="Elevated requests">
        <WorkspaceNotice title="Permission denied" tone="danger">You do not have permission to view this section.</WorkspaceNotice>
      </PageFrame>
    );
  }

  if (error instanceof ApiError && error.status === 404) {
    return (
      <PageFrame title="Elevated requests">
        <WorkspaceNotice title="Resource unavailable" tone="danger">This resource is not available.</WorkspaceNotice>
      </PageFrame>
    );
  }

  if (error) {
    return (
      <PageFrame title="Elevated requests">
        <WorkspaceNotice title="Elevated requests unavailable" tone="danger">{safeApiErrorMessage(error)}</WorkspaceNotice>
      </PageFrame>
    );
  }

  const requests = Array.isArray(data?.requests) ? data.requests : Array.isArray(data) ? data : [];

  if (requests.length === 0) {
    return (
      <PageFrame title="Elevated requests">
        <EmptyState title="No elevated requests" description="No elevated permission requests exist in this deployment." />
      </PageFrame>
    );
  }

  function decisionTone(decision) {
    const d = String(decision || "").toLowerCase();
    if (d === "approved") return "success";
    if (d === "rejected") return "danger";
    if (d === "superseded") return "warning";
    return "info";
  }

  return (
    <PageFrame title="Elevated requests" description="Elevated permission requests and their governance decisions.">
      <SectionCard title={`Elevated requests (${requests.length})`}>
        <div className="overflow-x-auto">
          <table className="w-full text-sm" aria-label="Elevated requests list">
            <thead>
              <tr className="border-b border-border text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                <th className="px-4 py-3">Target type</th>
                <th className="px-4 py-3">Target resource</th>
                <th className="px-4 py-3">Requester</th>
                <th className="px-4 py-3">Target user</th>
                <th className="px-4 py-3">Permissions</th>
                <th className="px-4 py-3">Decision</th>
                <th className="px-4 py-3">Effective</th>
                <th className="px-4 py-3">Expiry</th>
                <th className="px-4 py-3">Version</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {requests.map((r, idx) => {
                const perms = Array.isArray(r.requestedPermissions) ? r.requestedPermissions : [];
                return (
                  <tr key={r.requestId || idx} className="hover:bg-accent/50">
                    <td className="px-4 py-3 text-xs">{formatStatus(r.targetType)}</td>
                    <td className="px-4 py-3 font-data text-xs">{r.targetResource || "—"}</td>
                    <td className="px-4 py-3 font-data text-xs">{r.requester || "—"}</td>
                    <td className="px-4 py-3 font-data text-xs">{r.targetUser || r.targetMembership || "—"}</td>
                    <td className="px-4 py-3">
                      <span className="flex flex-wrap gap-1">
                        {perms.length > 0
                          ? perms.map((p) => <StatusIndicator key={p} tone="warning">{p}</StatusIndicator>)
                          : "—"}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      <StatusIndicator tone={decisionTone(r.decision)}>
                        {formatElevatedDecision(r.decision)}
                      </StatusIndicator>
                    </td>
                    <td className="px-4 py-3 text-xs">{formatDate(r.effectiveAt || r.effectiveDate)}</td>
                    <td className="px-4 py-3 text-xs">{formatDate(r.expiresAt || r.expiry)}</td>
                    <td className="px-4 py-3 font-data text-xs">{r.version ?? "—"}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </SectionCard>
    </PageFrame>
  );
}
