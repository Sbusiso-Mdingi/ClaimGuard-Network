import React, { useCallback, useEffect, useMemo, useState } from "react";
import Users from "lucide-react/dist/esm/icons/users.mjs";
import { useRole } from "../../context/RoleContext";
import {
  DefinitionList,
  EmptyState,
  FormField,
  PageFrame,
  SectionCard,
  StatCard,
  StatusIndicator,
  WorkspaceNotice,
  formatEnumLabel,
} from "./InvestigatorUI";
import { DetectionEngineSettings } from "./DetectionEngineSettings";
import { apiJson } from "../../lib/apiClient";
import { Input } from "../../components/ui/input";
import { Button } from "../../components/ui/button";

function unavailableText(value, fallback = "Not available") {
  return value === undefined || value === null || value === "" ? fallback : value;
}

function formatDate(value) {
  if (!value) return "Not available";
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? "Not available" : parsed.toLocaleString();
}

function processingTone(status) {
  if (status === "failed") return "danger";
  if (status === "retrying" || status === "queued" || status === "processing") return "warning";
  if (status === "scored") return "success";
  return "info";
}

function OperationsOverview({ overview, status, error, onRefresh }) {
  if (status === "loading") {
    return (
      <SectionCard title="Scheme operations" description="Tenant-scoped operational metrics and processing health.">
        <WorkspaceNotice title="Loading scheme operations">
          ClaimGuard is reading the latest tenant-scoped claims and detection state.
        </WorkspaceNotice>
      </SectionCard>
    );
  }

  if (status === "error") {
    return (
      <SectionCard title="Scheme operations" description="Tenant-scoped operational metrics and processing health.">
        <WorkspaceNotice
          title="Scheme operations unavailable"
          tone="danger"
          actions={<Button variant="outline" onClick={onRefresh}>Retry overview</Button>}
        >
          {error || "The operational overview could not be loaded."}
        </WorkspaceNotice>
      </SectionCard>
    );
  }

  const claims = overview?.claims || {};
  const processing = overview?.processing || {};
  const investigations = overview?.investigations || {};
  const strategy = overview?.detectionStrategy || null;
  const processingRows = [
    ["queued", processing.queued || 0],
    ["processing", processing.processing || 0],
    ["retrying", processing.retrying || 0],
    ["failed", processing.failed || 0],
    ["scored", processing.scored || 0],
    ["not_scored", processing.notScored || 0],
  ];
  const investigationRows = Object.entries(investigations.byStatus || {});

  return (
    <div className="space-y-5">
      {status === "stale" ? (
        <WorkspaceNotice
          title="Showing the last successful scheme snapshot"
          tone="warning"
          actions={<Button variant="outline" size="sm" onClick={onRefresh}>Retry refresh</Button>}
        >
          {error || "The latest refresh failed, so the previous operational values remain visible."}
        </WorkspaceNotice>
      ) : null}

      <section aria-label="Scheme claim metrics" className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard title="Total claims" value={claims.total || 0} description="Claims currently held in this scheme's operational data plane." />
        <StatCard title="Scored claims" value={claims.scored || 0} description={`${claims.completionRate || 0}% of all claims have a persisted score.`} tone="success" />
        <StatCard title="Awaiting scoring" value={claims.awaitingScoring || 0} description="Queued, processing, or retrying detection work." tone="warning" />
        <StatCard title="Processing failures" value={claims.failed || 0} description="Claims requiring operational intervention." tone={claims.failed > 0 ? "danger" : "success"} />
      </section>

      <div className="grid gap-5 xl:grid-cols-2">
        <SectionCard title="Processing queue" description="Current claim-detection lifecycle counts from the authoritative claims projection.">
          <div className="divide-y divide-border/70 rounded-xl border border-border/70">
            {processingRows.map(([label, count]) => (
              <div key={label} className="flex items-center justify-between gap-4 px-4 py-3">
                <StatusIndicator tone={processingTone(label)} variant="badge">
                  {formatEnumLabel(label)}
                </StatusIndicator>
                <span className="font-data text-sm font-semibold">{count}</span>
              </div>
            ))}
          </div>
        </SectionCard>

        <SectionCard title="Detection configuration" description="Active tenant-scoped strategy used for newly ingested claim versions.">
          <DefinitionList
            columns={1}
            items={[
              { label: "Strategy type", value: strategy?.strategyType ? formatEnumLabel(strategy.strategyType) : "No active strategy" },
              { label: "Model deployment", value: unavailableText(strategy?.modelDeploymentId, "Rules-based"), mono: true },
              { label: "Activated", value: formatDate(strategy?.activatedAt) },
              { label: "Change reason", value: unavailableText(strategy?.changeReason) },
            ]}
          />
        </SectionCard>
      </div>

      <SectionCard title="Investigations overview" description="Claims currently linked to investigations, grouped by their latest investigation state.">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <StatCard title="Claims with investigations" value={investigations.claimsWithInvestigations || 0} description="Claims linked to at least one investigation." />
          {investigationRows.map(([label, count]) => (
            <StatCard key={label} title={formatEnumLabel(label)} value={count} description="Latest investigation state across linked claims." />
          ))}
        </div>
      </SectionCard>
    </div>
  );
}

function UserManagementPanel() {
  const [users, setUsers] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [newUser, setNewUser] = useState({ displayName: "", username: "", password: "", roleKey: "claims_analyst" });
  const [isSubmitting, setIsSubmitting] = useState(false);

  const loadUsers = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const result = await apiJson("/admin/scheme/users", { cache: "no-store" });
      setUsers(result.users || []);
    } catch (err) {
      setError(err.message || "Failed to load users");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadUsers();
  }, [loadUsers]);

  async function handleCreateUser(event) {
    event.preventDefault();
    setIsSubmitting(true);
    setError("");
    setMessage("");
    try {
      await apiJson("/admin/scheme/users", {
        method: "POST",
        body: JSON.stringify(newUser),
      });
      setNewUser({ displayName: "", username: "", password: "", roleKey: "claims_analyst" });
      await loadUsers();
      setMessage("User created successfully.");
    } catch (err) {
      setError(err.message || "Failed to create user");
    } finally {
      setIsSubmitting(false);
    }
  }

  async function handleDisableUser(userId) {
    if (!window.confirm("Are you sure you want to disable this user?")) return;
    setLoading(true);
    setError("");
    setMessage("");
    try {
      await apiJson(`/admin/scheme/users/${encodeURIComponent(userId)}`, { method: "DELETE" });
      await loadUsers();
      setMessage("User disabled successfully.");
    } catch (err) {
      setError(err.message || "Failed to disable user");
      setLoading(false);
    }
  }

  return (
    <div className="space-y-6">
      {error ? <WorkspaceNotice title="User administration failed" tone="danger">{error}</WorkspaceNotice> : null}
      {message ? <WorkspaceNotice title={message} tone="success" /> : null}

      <form onSubmit={handleCreateUser} className="grid gap-5 rounded-xl border border-border/70 bg-background/30 p-4 sm:p-5">
        <div>
          <h4 className="font-semibold">Create new user</h4>
          <p className="mt-1 text-sm leading-6 text-muted-foreground">Create a tenant-scoped account and assign its initial ClaimGuard role.</p>
        </div>
        <div className="grid gap-4 md:grid-cols-2">
          <FormField label="Display name">
            <Input value={newUser.displayName} onChange={(event) => setNewUser((previous) => ({ ...previous, displayName: event.target.value }))} required />
          </FormField>
          <FormField label="Username">
            <Input value={newUser.username} onChange={(event) => setNewUser((previous) => ({ ...previous, username: event.target.value }))} required />
          </FormField>
          <FormField label="Password" hint="Use at least eight characters.">
            <Input type="password" value={newUser.password} onChange={(event) => setNewUser((previous) => ({ ...previous, password: event.target.value }))} required minLength={8} />
          </FormField>
          <FormField label="Role">
            <select className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" value={newUser.roleKey} onChange={(event) => setNewUser((previous) => ({ ...previous, roleKey: event.target.value }))}>
              <option value="claims_analyst">Claims Analyst</option>
              <option value="fraud_analyst">Fraud Analyst</option>
              <option value="investigator">Investigator</option>
              <option value="applications_committee_member">Applications Committee Member</option>
              <option value="scheme_administrator">Scheme Administrator</option>
            </select>
          </FormField>
        </div>
        <Button type="submit" className="w-fit" disabled={isSubmitting}>{isSubmitting ? "Creating..." : "Create user"}</Button>
      </form>

      <div className="space-y-3">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h4 className="font-semibold">Existing users</h4>
            <p className="mt-1 text-sm text-muted-foreground">Review tenant users, assigned roles and account status.</p>
          </div>
          <Button variant="outline" size="sm" onClick={loadUsers} disabled={loading}>{loading ? "Refreshing..." : "Refresh users"}</Button>
        </div>

        {users.length === 0 && !loading ? (
          <EmptyState icon={Users} title="No users found." description="Create the first tenant user with the form above." compact />
        ) : null}

        <div className="divide-y divide-border/70 rounded-xl border border-border/70">
          {users.map((user) => (
            <div key={user.userId} className="flex flex-col gap-3 px-4 py-4 sm:flex-row sm:items-center sm:justify-between">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <p className="font-medium">{user.displayName}</p>
                  <StatusIndicator variant="badge" tone={user.userStatus === "active" ? "success" : "info"}>{formatEnumLabel(user.userStatus)}</StatusIndicator>
                </div>
                <p className="mt-1 break-all text-sm text-muted-foreground">{user.username}</p>
                <p className="mt-1 text-xs text-muted-foreground">Roles: {(user.roles || []).map((role) => formatEnumLabel(role)).join(", ") || "None"}</p>
              </div>
              {user.userStatus === "active" ? (
                <Button variant="destructive" size="sm" onClick={() => handleDisableUser(user.userId)} disabled={loading}>Disable user</Button>
              ) : null}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function ApiGapPanel({ title, description }) {
  return (
    <WorkspaceNotice
      title={title}
      tone="warning"
      actions={<StatusIndicator variant="badge" tone="warning">API required</StatusIndicator>}
    >
      {description}
    </WorkspaceNotice>
  );
}

export function SchemeAdminPage() {
  const { identity } = useRole();
  const [overview, setOverview] = useState(null);
  const [overviewStatus, setOverviewStatus] = useState("loading");
  const [overviewError, setOverviewError] = useState("");

  const loadOverview = useCallback(async () => {
    setOverviewStatus((previous) => overview ? "refreshing" : previous === "error" ? "loading" : previous);
    setOverviewError("");
    try {
      const result = await apiJson("/admin/scheme/overview", { cache: "no-store" });
      setOverview(result.overview || null);
      setOverviewStatus("ready");
    } catch (error) {
      setOverviewError(error.message || "Failed to load the scheme operations overview.");
      setOverviewStatus(overview ? "stale" : "error");
    }
  }, [overview]);

  useEffect(() => {
    loadOverview();
  }, []);

  const schemeLabel = useMemo(
    () => identity.tenantLabel || identity.organisationLabel || identity.organisationName || "Scheme operations",
    [identity],
  );
  const tenantReference = identity.tenantId || identity.organisationId || "Resolved by secure session";

  return (
    <PageFrame
      eyebrow="Scheme Administration"
      title={schemeLabel}
      description="Tenant-scoped operational visibility, detection configuration, user administration, and processing health."
      actions={[
        <Button key="refresh" variant="outline" onClick={loadOverview} disabled={overviewStatus === "loading" || overviewStatus === "refreshing"}>
          {overviewStatus === "refreshing" ? "Refreshing..." : "Refresh operations"}
        </Button>,
        overview?.generatedAt ? <StatusIndicator key="generated" variant="badge">Updated {formatDate(overview.generatedAt)}</StatusIndicator> : null,
      ].filter(Boolean)}
    >
      <SectionCard title="Scheme identity" description="Organisation and operational tenant context resolved from the authenticated session.">
        <DefinitionList
          items={[
            { label: "Operational tenant", value: tenantReference, mono: true },
            { label: "Scheme", value: schemeLabel },
          ]}
        />
      </SectionCard>

      <OperationsOverview overview={overview} status={overviewStatus} error={overviewError} onRefresh={loadOverview} />

      <SectionCard title="Detection engine settings" description="Change the active rules or approved-model strategy with an auditable reason.">
        <DetectionEngineSettings tenantId={identity.tenantId || identity.organisationId || null} />
      </SectionCard>

      <SectionCard title="Users and roles" description="Create, review, and disable users within this scheme.">
        <UserManagementPanel />
      </SectionCard>

      <SectionCard title="Management API coverage" description="These administrative domains remain intentionally explicit until authoritative APIs are implemented.">
        <div className="grid gap-3 xl:grid-cols-2">
          <ApiGapPanel title="Integration credentials" description="Credential creation, rotation, revocation, and last-used metadata need a dedicated control-plane management contract. Secret values must never be reconstructed in the browser." />
          <ApiGapPanel title="Audit activity" description="The control plane stores safe audit events, but a tenant-filtered audit read endpoint is not exposed yet. The UI does not fabricate an activity feed." />
        </div>
      </SectionCard>
    </PageFrame>
  );
}
