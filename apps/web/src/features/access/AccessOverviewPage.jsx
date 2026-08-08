import React, { useEffect, useState } from "react";
import { Link } from "react-router-dom";
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
import { fetchAccessMe } from "./accessApi";
import { formatDate } from "./accessFormatting";

const SECTION_LINKS = [
  { label: "Permissions", to: "/admin/scheme/access/permissions", caps: ["access.roles.read", "access.roles.manage"] },
  { label: "Roles", to: "/admin/scheme/access/roles", caps: ["access.roles.read", "access.roles.manage"] },
  { label: "Assignments", to: "/admin/scheme/access/assignments", caps: ["access.assignments.read", "access.assignments.manage"] },
  { label: "Delegations", to: "/admin/scheme/access/delegations", caps: ["access.delegations.read", "access.delegations.grant", "access.delegations.revoke"] },
  { label: "Elevated Requests", to: "/admin/scheme/access/elevated", caps: ["access.elevated_permissions.review"] },
  { label: "Audit", to: "/admin/scheme/access/audit", caps: ["access.audit.read"] },
];

export function AccessOverviewPage() {
  const { identity } = useRole();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetchAccessMe()
      .then((result) => { if (!cancelled) { setData(result); setLoading(false); } })
      .catch((err) => { if (!cancelled) { setError(err); setLoading(false); } });
    return () => { cancelled = true; };
  }, []);

  if (loading) {
    return (
      <PageFrame title="Access overview">
        <WorkspaceNotice title="Loading access overview">
          Reading your current access context from the server.
        </WorkspaceNotice>
      </PageFrame>
    );
  }

  if (error instanceof ApiError && error.status === 403) {
    return (
      <PageFrame title="Access overview">
        <WorkspaceNotice title="Permission denied" tone="danger">
          You do not have permission to view this section.
        </WorkspaceNotice>
      </PageFrame>
    );
  }

  if (error instanceof ApiError && error.status === 404) {
    return (
      <PageFrame title="Access overview">
        <WorkspaceNotice title="Resource unavailable" tone="danger">
          This resource is not available.
        </WorkspaceNotice>
      </PageFrame>
    );
  }

  if (error instanceof ApiError && error.code === "ACCESS_AUTHORIZATION_VERSION_STALE") {
    return (
      <PageFrame title="Access overview">
        <WorkspaceNotice title="Session authority is stale" tone="warning">
          Your session&apos;s authorization version is out of date.{" "}
          <Link to="/sign-in" className="underline">Sign in again through Clerk</Link> to refresh your access context.
        </WorkspaceNotice>
      </PageFrame>
    );
  }

  if (error instanceof ApiError && error.code === "ACCESS_VERSION_CONFLICT") {
    return (
      <PageFrame title="Access overview">
        <WorkspaceNotice title="Access version conflict" tone="warning">
          {safeApiErrorMessage(error)}
        </WorkspaceNotice>
      </PageFrame>
    );
  }

  if (error) {
    return (
      <PageFrame title="Access overview">
        <WorkspaceNotice title="Access overview unavailable" tone="danger">
          {safeApiErrorMessage(error)}
        </WorkspaceNotice>
      </PageFrame>
    );
  }

  if (!data) {
    return (
      <PageFrame title="Access overview">
        <EmptyState title="No access data" description="No access context was returned for this account." />
      </PageFrame>
    );
  }

  const visibleLinks = SECTION_LINKS.filter((link) => hasAnyCapability(identity, link.caps));

  return (
    <PageFrame
      title="Access overview"
      description="Your current server-resolved access context for this organisation."
    >
      <div className="grid gap-6">
        <SectionCard title="Context">
          <dl className="grid gap-4 sm:grid-cols-2 p-1">
            {data.organisation && (
              <div>
                <dt className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Organisation</dt>
                <dd className="mt-1 text-sm text-foreground">{data.organisation}</dd>
              </div>
            )}
            {data.membershipRef && (
              <div>
                <dt className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Membership reference</dt>
                <dd className="mt-1 font-data text-sm text-foreground">{data.membershipRef}</dd>
              </div>
            )}
            {data.authorizationVersion != null && (
              <div>
                <dt className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Authorization version</dt>
                <dd className="mt-1 font-data text-sm text-foreground">{data.authorizationVersion}</dd>
              </div>
            )}
            {data.evaluatedAt && (
              <div>
                <dt className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Evaluated at</dt>
                <dd className="mt-1 text-sm text-foreground">{formatDate(data.evaluatedAt)}</dd>
              </div>
            )}
          </dl>
        </SectionCard>

        {Array.isArray(data.effectivePermissions) && data.effectivePermissions.length > 0 && (
          <SectionCard title="Effective permissions">
            <ul className="flex flex-wrap gap-2 p-1" aria-label="Effective permissions list">
              {data.effectivePermissions.map((perm) => (
                <li key={perm}>
                  <StatusIndicator tone="info">{perm}</StatusIndicator>
                </li>
              ))}
            </ul>
          </SectionCard>
        )}

        {Array.isArray(data.authoritySources) && data.authoritySources.length > 0 && (
          <SectionCard title="Authority sources">
            <ul className="grid gap-2 p-1">
              {data.authoritySources.map((src, idx) => (
                <li key={idx} className="text-sm text-muted-foreground">{String(src)}</li>
              ))}
            </ul>
          </SectionCard>
        )}

        {visibleLinks.length > 0 && (
          <SectionCard title="Sections you can access">
            <ul className="flex flex-wrap gap-2 p-1">
              {visibleLinks.map((link) => (
                <li key={link.to}>
                  <Link
                    to={link.to}
                    className="inline-flex items-center rounded-md border border-border px-3 py-1.5 text-sm font-medium text-foreground hover:bg-accent"
                  >
                    {link.label}
                  </Link>
                </li>
              ))}
            </ul>
          </SectionCard>
        )}

        <SectionCard title="Access policy notices">
          <ul className="grid gap-2 p-1">
            <li className="text-sm text-muted-foreground">Roles are descriptive sources. They do not grant authority independently of server-resolved permissions.</li>
            <li className="text-sm text-muted-foreground">Elevated authority requires independent governance approval.</li>
            <li className="text-sm text-muted-foreground">Delegation is bounded and non-transitive.</li>
          </ul>
        </SectionCard>
      </div>
    </PageFrame>
  );
}
