import React, { useEffect, useState } from "react";
import { ApiError, safeApiErrorMessage } from "../../lib/apiClient";
import { hasAnyCapability } from "../../lib/capabilities";
import { useRole } from "../../context/RoleContext";
import {
  EmptyState,
  PageFrame,
  SectionCard,
  StatusIndicator,
  WorkspaceNotice,
} from "../investigator/InvestigatorUI";
import { fetchRole, fetchRoles } from "./accessApi";
import { formatStatus } from "./accessFormatting";

function RoleDetailPanel({ roleId, onClose }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetchRole(roleId)
      .then((result) => { if (!cancelled) { setData(result); setLoading(false); } })
      .catch((err) => { if (!cancelled) { setError(err); setLoading(false); } });
    return () => { cancelled = true; };
  }, [roleId]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-end bg-black/40"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label="Role detail"
    >
      <div
        className="h-full w-full max-w-lg overflow-y-auto bg-background p-6 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-center justify-between">
          <h2 className="font-display text-lg font-semibold">Role detail</h2>
          <button
            type="button"
            onClick={onClose}
            className="rounded p-1 hover:bg-accent"
            aria-label="Close role detail"
          >
            ✕
          </button>
        </div>

        {loading && (
          <WorkspaceNotice title="Loading role">Reading role detail from the server.</WorkspaceNotice>
        )}

        {error && (
          <WorkspaceNotice title="Role detail unavailable" tone="danger">{safeApiErrorMessage(error)}</WorkspaceNotice>
        )}

        {data && (
          <div className="grid gap-4">
            <dl className="grid gap-3">
              <div><dt className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Name</dt><dd className="mt-1 text-sm">{data.name || "—"}</dd></div>
              <div><dt className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Description</dt><dd className="mt-1 text-sm text-muted-foreground">{data.description || "—"}</dd></div>
              <div><dt className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Class</dt><dd className="mt-1 text-sm">{data.roleClass || "—"}</dd></div>
              <div><dt className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">State</dt><dd className="mt-1"><StatusIndicator tone={data.state === "active" ? "success" : "warning"}>{formatStatus(data.state)}</StatusIndicator></dd></div>
              <div><dt className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Version</dt><dd className="mt-1 font-data text-sm">{data.version ?? "—"}</dd></div>
              {data.systemRole && <div><dt className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">System role</dt><dd className="mt-1"><StatusIndicator tone="info">Immutable</StatusIndicator></dd></div>}
            </dl>

            {Array.isArray(data.permissions) && data.permissions.length > 0 && (
              <div>
                <h3 className="mb-2 text-sm font-semibold">Permissions ({data.permissions.length})</h3>
                <ul className="flex flex-wrap gap-1">
                  {data.permissions.map((perm) => (
                    <li key={typeof perm === "string" ? perm : perm.key}>
                      <StatusIndicator tone={perm.elevated ? "warning" : "info"}>
                        {typeof perm === "string" ? perm : perm.key}
                      </StatusIndicator>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

export function AccessRolesPage() {
  const { identity } = useRole();
  const canManage = hasAnyCapability(identity, ["access.roles.manage"]);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [selectedRoleId, setSelectedRoleId] = useState(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetchRoles()
      .then((result) => { if (!cancelled) { setData(result); setLoading(false); } })
      .catch((err) => { if (!cancelled) { setError(err); setLoading(false); } });
    return () => { cancelled = true; };
  }, []);

  if (loading) {
    return (
      <PageFrame title="Roles">
        <WorkspaceNotice title="Loading roles">Reading roles from the server.</WorkspaceNotice>
      </PageFrame>
    );
  }

  if (error instanceof ApiError && error.status === 403) {
    return (
      <PageFrame title="Roles">
        <WorkspaceNotice title="Permission denied" tone="danger">You do not have permission to view this section.</WorkspaceNotice>
      </PageFrame>
    );
  }

  if (error instanceof ApiError && error.status === 404) {
    return (
      <PageFrame title="Roles">
        <WorkspaceNotice title="Resource unavailable" tone="danger">This resource is not available.</WorkspaceNotice>
      </PageFrame>
    );
  }

  if (error) {
    return (
      <PageFrame title="Roles">
        <WorkspaceNotice title="Roles unavailable" tone="danger">{safeApiErrorMessage(error)}</WorkspaceNotice>
      </PageFrame>
    );
  }

  const roles = Array.isArray(data?.roles) ? data.roles : Array.isArray(data) ? data : [];

  if (roles.length === 0) {
    return (
      <PageFrame title="Roles">
        <EmptyState title="No roles found" description="No roles are defined in this deployment." />
      </PageFrame>
    );
  }

  return (
    <PageFrame title="Roles" description="Roles defined in this deployment. Click a role to view its permissions.">
      {canManage && (
        <WorkspaceNotice title="Mutation controls" tone="info">
          Mutation controls will be available in the next implementation slice.
        </WorkspaceNotice>
      )}

      <SectionCard title={`Roles (${roles.length})`}>
        <div className="overflow-x-auto">
          <table className="w-full text-sm" aria-label="Roles list">
            <thead>
              <tr className="border-b border-border text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                <th className="px-4 py-3">Name</th>
                <th className="px-4 py-3">Class</th>
                <th className="px-4 py-3">State</th>
                <th className="px-4 py-3">Permissions</th>
                <th className="px-4 py-3">Version</th>
                <th className="px-4 py-3">Flags</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {roles.map((role) => {
                const perms = Array.isArray(role.permissions) ? role.permissions : [];
                const elevated = perms.filter((p) => (typeof p === "object" ? p.elevated : false));
                const ordinary = perms.filter((p) => !(typeof p === "object" ? p.elevated : false));
                return (
                  <tr
                    key={role.roleId || role.id || role.name}
                    className="cursor-pointer hover:bg-accent/50"
                    onClick={() => setSelectedRoleId(role.roleId || role.id || role.name)}
                    tabIndex={0}
                    onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") setSelectedRoleId(role.roleId || role.id || role.name); }}
                    aria-label={`View role ${role.name}`}
                  >
                    <td className="px-4 py-3 font-medium">{role.name || "—"}</td>
                    <td className="px-4 py-3 text-muted-foreground">{role.roleClass || "—"}</td>
                    <td className="px-4 py-3">
                      <StatusIndicator tone={role.state === "active" ? "success" : "warning"}>{formatStatus(role.state)}</StatusIndicator>
                    </td>
                    <td className="px-4 py-3">
                      <span className="flex flex-wrap gap-1">
                        {ordinary.length > 0 && <StatusIndicator tone="info">{ordinary.length} ordinary</StatusIndicator>}
                        {elevated.length > 0 && <StatusIndicator tone="warning">{elevated.length} elevated</StatusIndicator>}
                        {perms.length === 0 && "—"}
                      </span>
                    </td>
                    <td className="px-4 py-3 font-data text-xs">{role.version ?? "—"}</td>
                    <td className="px-4 py-3">
                      {role.systemRole && <StatusIndicator tone="info">Immutable</StatusIndicator>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </SectionCard>

      {selectedRoleId && (
        <RoleDetailPanel
          roleId={selectedRoleId}
          onClose={() => setSelectedRoleId(null)}
        />
      )}
    </PageFrame>
  );
}
