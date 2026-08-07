import React, { useEffect, useState } from "react";
import { ApiError, safeApiErrorMessage } from "../../lib/apiClient";
import {
  EmptyState,
  PageFrame,
  SectionCard,
  StatusIndicator,
  WorkspaceNotice,
} from "../investigator/InvestigatorUI";
import { fetchAssignments } from "./accessApi";
import { formatDate, formatStatus } from "./accessFormatting";

export function AccessAssignmentsPage() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetchAssignments()
      .then((result) => { if (!cancelled) { setData(result); setLoading(false); } })
      .catch((err) => { if (!cancelled) { setError(err); setLoading(false); } });
    return () => { cancelled = true; };
  }, []);

  if (loading) {
    return (
      <PageFrame title="Assignments">
        <WorkspaceNotice title="Loading assignments">Reading assignments from the server.</WorkspaceNotice>
      </PageFrame>
    );
  }

  if (error instanceof ApiError && error.status === 403) {
    return (
      <PageFrame title="Assignments">
        <WorkspaceNotice title="Permission denied" tone="danger">You do not have permission to view this section.</WorkspaceNotice>
      </PageFrame>
    );
  }

  if (error instanceof ApiError && error.status === 404) {
    return (
      <PageFrame title="Assignments">
        <WorkspaceNotice title="Resource unavailable" tone="danger">This resource is not available.</WorkspaceNotice>
      </PageFrame>
    );
  }

  if (error) {
    return (
      <PageFrame title="Assignments">
        <WorkspaceNotice title="Assignments unavailable" tone="danger">{safeApiErrorMessage(error)}</WorkspaceNotice>
      </PageFrame>
    );
  }

  const assignments = Array.isArray(data?.assignments) ? data.assignments : Array.isArray(data) ? data : [];

  return (
    <PageFrame title="Assignments" description="Role assignments in this deployment.">
      <WorkspaceNotice title="Read-only workspace" tone="info">
        Assignment creation and revocation require a trusted member selector and will be available in a future slice.
      </WorkspaceNotice>

      {assignments.length === 0 ? (
        <EmptyState title="No assignments found" description="No assignments exist in this deployment." />
      ) : (
        <SectionCard title={`Assignments (${assignments.length})`}>
          <div className="overflow-x-auto">
            <table className="w-full text-sm" aria-label="Assignments list">
              <thead>
                <tr className="border-b border-border text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  <th className="px-4 py-3">ID</th>
                  <th className="px-4 py-3">Role</th>
                  <th className="px-4 py-3">Subject</th>
                  <th className="px-4 py-3">Membership</th>
                  <th className="px-4 py-3">Status</th>
                  <th className="px-4 py-3">Effective</th>
                  <th className="px-4 py-3">Expiry</th>
                  <th className="px-4 py-3">Version</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {assignments.map((a) => (
                  <tr key={a.assignmentId || a.id} className="hover:bg-accent/50">
                    <td className="px-4 py-3 font-data text-xs text-muted-foreground">{a.assignmentId || a.id || "—"}</td>
                    <td className="px-4 py-3">{a.role || a.roleName || "—"}</td>
                    <td className="px-4 py-3 font-data text-xs">{a.subject || "—"}</td>
                    <td className="px-4 py-3 font-data text-xs">{a.membershipRef || a.membership || "—"}</td>
                    <td className="px-4 py-3">
                      <StatusIndicator tone={a.status === "active" ? "success" : "warning"}>{formatStatus(a.status)}</StatusIndicator>
                    </td>
                    <td className="px-4 py-3 text-xs">{formatDate(a.effectiveAt || a.effectiveDate)}</td>
                    <td className="px-4 py-3 text-xs">{formatDate(a.expiresAt || a.expiry)}</td>
                    <td className="px-4 py-3 font-data text-xs">{a.version ?? "—"}</td>
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
