import React, { useEffect, useState } from "react";
import { ApiError, safeApiErrorMessage } from "../../lib/apiClient";
import {
  EmptyState,
  PageFrame,
  SectionCard,
  StatusIndicator,
  WorkspaceNotice,
} from "../investigator/InvestigatorUI";
import { fetchDelegations } from "./accessApi";
import { formatDate, formatStatus } from "./accessFormatting";

export function AccessDelegationsPage() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetchDelegations()
      .then((result) => { if (!cancelled) { setData(result); setLoading(false); } })
      .catch((err) => { if (!cancelled) { setError(err); setLoading(false); } });
    return () => { cancelled = true; };
  }, []);

  if (loading) {
    return (
      <PageFrame title="Delegations">
        <WorkspaceNotice title="Loading delegations">Reading delegations from the server.</WorkspaceNotice>
      </PageFrame>
    );
  }

  if (error instanceof ApiError && error.status === 403) {
    return (
      <PageFrame title="Delegations">
        <WorkspaceNotice title="Permission denied" tone="danger">You do not have permission to view this section.</WorkspaceNotice>
      </PageFrame>
    );
  }

  if (error instanceof ApiError && error.status === 404) {
    return (
      <PageFrame title="Delegations">
        <WorkspaceNotice title="Resource unavailable" tone="danger">This resource is not available.</WorkspaceNotice>
      </PageFrame>
    );
  }

  if (error) {
    return (
      <PageFrame title="Delegations">
        <WorkspaceNotice title="Delegations unavailable" tone="danger">{safeApiErrorMessage(error)}</WorkspaceNotice>
      </PageFrame>
    );
  }

  const delegations = Array.isArray(data?.delegations) ? data.delegations : Array.isArray(data) ? data : [];

  return (
    <PageFrame title="Delegations" description="Active permission delegations in this deployment.">
      <WorkspaceNotice title="Read-only workspace" tone="info">
        Delegation is bounded and non-transitive. Grant and revoke actions will be available in a future slice.
      </WorkspaceNotice>

      {delegations.length === 0 ? (
        <EmptyState title="No delegations found" description="No delegations exist in this deployment." />
      ) : (
        <SectionCard title={`Delegations (${delegations.length})`}>
          <div className="overflow-x-auto">
            <table className="w-full text-sm" aria-label="Delegations list">
              <thead>
                <tr className="border-b border-border text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  <th className="px-4 py-3">Grantor</th>
                  <th className="px-4 py-3">Grantee</th>
                  <th className="px-4 py-3">Permissions</th>
                  <th className="px-4 py-3">Reason</th>
                  <th className="px-4 py-3">Status</th>
                  <th className="px-4 py-3">Effective</th>
                  <th className="px-4 py-3">Expiry</th>
                  <th className="px-4 py-3">Version</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {delegations.map((d, idx) => {
                  const perms = Array.isArray(d.delegatedPermissions) ? d.delegatedPermissions : [];
                  return (
                    <tr key={d.delegationId || idx} className="hover:bg-accent/50">
                      <td className="px-4 py-3 font-data text-xs">{d.grantor || "—"}</td>
                      <td className="px-4 py-3 font-data text-xs">{d.grantee || "—"}</td>
                      <td className="px-4 py-3">
                        <span className="flex flex-wrap gap-1">
                          {perms.length > 0
                            ? perms.map((p) => <StatusIndicator key={p} tone="info">{p}</StatusIndicator>)
                            : "—"}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-xs text-muted-foreground">{d.reason || "—"}</td>
                      <td className="px-4 py-3">
                        <StatusIndicator tone={d.status === "active" ? "success" : "warning"}>{formatStatus(d.status)}</StatusIndicator>
                      </td>
                      <td className="px-4 py-3 text-xs">{formatDate(d.effectiveAt || d.effectiveDate)}</td>
                      <td className="px-4 py-3 text-xs">{formatDate(d.expiresAt || d.expiry)}</td>
                      <td className="px-4 py-3 font-data text-xs">{d.version ?? "—"}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </SectionCard>
      )}
    </PageFrame>
  );
}
