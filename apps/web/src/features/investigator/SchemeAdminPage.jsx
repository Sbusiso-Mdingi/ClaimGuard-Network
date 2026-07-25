import React, { useCallback, useEffect, useMemo, useState } from "react";
import { useRole } from "../../context/RoleContext";
import { PageFrame, SectionCard, StatCard, StatusIndicator } from "./InvestigatorUI";
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
      <SectionCard title="Scheme operations" description="Loading tenant-scoped operational metrics.">
        <p className="text-sm text-muted-foreground">Loading operational overview...</p>
      </SectionCard>
    );
  }

  if (status === "error") {
    return (
      <SectionCard title="Scheme operations unavailable" description={error || "The operational overview could not be loaded."}>
        <Button variant="outline" onClick={onRefresh}>Retry overview</Button>
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
    ["not scored", processing.notScored || 0],
  ];

  return (
    <div className="space-y-5">
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard title="Total claims" value={claims.total || 0} description="Claims currently held in this scheme's operational data plane." />
        <StatCard title="Scored claims" value={claims.scored || 0} description={`${claims.completionRate || 0}% of all claims have a persisted score.`} tone="success" />
        <StatCard title="Awaiting scoring" value={claims.awaitingScoring || 0} description="Queued, processing, or retrying detection work." tone="warning" />
        <StatCard title="Processing failures" value={claims.failed || 0} description="Claims requiring operational intervention." tone={claims.failed > 0 ? "danger" : "success"} />
      </div>

      <div className="grid gap-5 xl:grid-cols-2">
        <SectionCard title="Processing queue" description="Current claim-detection lifecycle counts from the authoritative claims projection.">
          <div className="space-y-2">
            {processingRows.map(([label, count]) => (
              <div key={label} className="flex items-center justify-between rounded-lg border border-border/70 px-3 py-2">
                <StatusIndicator tone={processingTone(label.replace(" ", "_"))} variant="badge">
                  {label.replace(/\b\w/g, (letter) => letter.toUpperCase())}
                </StatusIndicator>
                <span className="font-data text-sm font-semibold">{count}</span>
              </div>
            ))}
          </div>
        </SectionCard>

        <SectionCard title="Detection configuration" description="Active tenant-scoped strategy used for newly ingested claim versions.">
          <div className="space-y-3 text-sm">
            <div className="flex justify-between gap-4 border-b border-border/60 pb-2">
              <span className="text-muted-foreground">Strategy type</span>
              <span className="font-medium">{unavailableText(strategy?.strategyType, "No active strategy")}</span>
            </div>
            <div className="flex justify-between gap-4 border-b border-border/60 pb-2">
              <span className="text-muted-foreground">Model deployment</span>
              <span className="font-data text-xs">{unavailableText(strategy?.modelDeploymentId, "Rules-based")}</span>
            </div>
            <div className="flex justify-between gap-4 border-b border-border/60 pb-2">
              <span className="text-muted-foreground">Activated</span>
              <span>{formatDate(strategy?.activatedAt)}</span>
            </div>
            <div className="flex justify-between gap-4">
              <span className="text-muted-foreground">Change reason</span>
              <span className="max-w-sm text-right">{unavailableText(strategy?.changeReason)}</span>
            </div>
          </div>
        </SectionCard>
      </div>

      <SectionCard title="Investigations overview" description="Claims currently linked to investigations, grouped by their latest investigation state.">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <div className="rounded-xl border border-border/70 p-4">
            <p className="text-xs uppercase tracking-[0.16em] text-muted-foreground">Claims with investigations</p>
            <p className="mt-2 font-data text-2xl font-semibold">{investigations.claimsWithInvestigations || 0}</p>
          </div>
          {Object.entries(investigations.byStatus || {}).map(([label, count]) => (
            <div key={label} className="rounded-xl border border-border/70 p-4">
              <p className="text-xs uppercase tracking-[0.16em] text-muted-foreground">{label.replace(/_/g, " ")}</p>
              <p className="mt-2 font-data text-2xl font-semibold">{count}</p>
            </div>
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

  async function handleCreateUser(e) {
    e.preventDefault();
    setIsSubmitting(true);
    setError("");
    try {
      await apiJson("/admin/scheme/users", {
        method: "POST",
        body: JSON.stringify(newUser),
      });
      setNewUser({ displayName: "", username: "", password: "", roleKey: "claims_analyst" });
      await loadUsers();
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
    try {
      await apiJson(`/admin/scheme/users/${encodeURIComponent(userId)}`, { method: "DELETE" });
      await loadUsers();
    } catch (err) {
      setError(err.message || "Failed to disable user");
      setLoading(false);
    }
  }

  return (
    <div className="space-y-6">
      {error ? <p className="text-sm text-destructive">{error}</p> : null}

      <form onSubmit={handleCreateUser} className="grid gap-4 rounded-xl border border-border p-4">
        <h4 className="font-semibold">Create new user</h4>
        <div className="grid gap-4 md:grid-cols-2">
          <label className="block text-sm font-medium">Display name
            <Input value={newUser.displayName} onChange={(event) => setNewUser((previous) => ({ ...previous, displayName: event.target.value }))} required />
          </label>
          <label className="block text-sm font-medium">Username
            <Input value={newUser.username} onChange={(event) => setNewUser((previous) => ({ ...previous, username: event.target.value }))} required />
          </label>
          <label className="block text-sm font-medium">Password
            <Input type="password" value={newUser.password} onChange={(event) => setNewUser((previous) => ({ ...previous, password: event.target.value }))} required minLength={8} />
          </label>
          <label className="block text-sm font-medium">Role
            <select className="mt-1 block w-full rounded-md border border-input bg-background px-3 py-2 text-sm" value={newUser.roleKey} onChange={(event) => setNewUser((previous) => ({ ...previous, roleKey: event.target.value }))}>
              <option value="claims_analyst">Claims Analyst</option>
              <option value="fraud_analyst">Fraud Analyst</option>
              <option value="investigator">Investigator</option>
              <option value="applications_committee_member">Applications Committee Member</option>
              <option value="scheme_administrator">Scheme Administrator</option>
            </select>
          </label>
        </div>
        <Button type="submit" disabled={isSubmitting}>{isSubmitting ? "Creating..." : "Create user"}</Button>
      </form>

      <div className="space-y-3">
        <div className="flex items-center justify-between gap-3">
          <h4 className="font-semibold">Existing users</h4>
          <Button variant="outline" size="sm" onClick={loadUsers} disabled={loading}>{loading ? "Refreshing..." : "Refresh users"}</Button>
        </div>
        {users.length === 0 && !loading ? <p className="text-sm text-muted-foreground">No users found.</p> : null}
        {users.map((user) => (
          <div key={user.userId} className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border p-4">
            <div>
              <p className="font-medium">{user.displayName} <span className="text-xs text-muted-foreground">({user.username})</span></p>
              <p className="text-sm text-muted-foreground">Roles: {(user.roles || []).join(", ") || "None"} · Status: {user.userStatus}</p>
            </div>
            {user.userStatus === "active" ? (
              <Button variant="destructive" size="sm" onClick={() => handleDisableUser(user.userId)} disabled={loading}>Disable</Button>
            ) : null}
          </div>
        ))}
      </div>
    </div>
  );
}

function ApiGapPanel({ title, description }) {
  return (
    <div className="rounded-xl border border-dashed border-border p-4">
      <div className="flex items-center justify-between gap-3">
        <p className="font-medium">{title}</p>
        <StatusIndicator variant="badge" tone="warning">API required</StatusIndicator>
      </div>
      <p className="mt-2 text-sm leading-6 text-muted-foreground">{description}</p>
    </div>
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
        <div className="grid gap-3 md:grid-cols-2">
          <div className="rounded-xl border border-border/70 px-4 py-3">
            <p className="text-xs uppercase tracking-[0.16em] text-muted-foreground">Operational tenant</p>
            <p className="mt-1 font-data text-sm">{tenantReference}</p>
          </div>
          <div className="rounded-xl border border-border/70 px-4 py-3">
            <p className="text-xs uppercase tracking-[0.16em] text-muted-foreground">Scheme</p>
            <p className="mt-1 text-sm font-semibold">{schemeLabel}</p>
          </div>
        </div>
      </SectionCard>

      <OperationsOverview overview={overview} status={overviewStatus} error={overviewError} onRefresh={loadOverview} />

      <SectionCard title="Detection engine settings" description="Change the active rules or approved-model strategy with an auditable reason.">
        <DetectionEngineSettings tenantId={identity.tenantId || identity.organisationId || null} />
      </SectionCard>

      <SectionCard title="Users and roles" description="Create, review, and disable users within this scheme.">
        <UserManagementPanel />
      </SectionCard>

      <SectionCard title="Management API coverage" description="These administrative domains remain intentionally explicit until authoritative APIs are implemented.">
        <div className="grid gap-3 md:grid-cols-2">
          <ApiGapPanel title="Integration credentials" description="Credential creation, rotation, revocation, and last-used metadata need a dedicated control-plane management contract. Secret values must never be reconstructed in the browser." />
          <ApiGapPanel title="Audit activity" description="The control plane stores safe audit events, but a tenant-filtered audit read endpoint is not exposed yet. The UI does not fabricate an activity feed." />
        </div>
      </SectionCard>
    </PageFrame>
  );
}
