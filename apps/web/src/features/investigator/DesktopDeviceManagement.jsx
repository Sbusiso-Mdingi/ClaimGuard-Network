import React, { useCallback, useEffect, useState } from "react";
import Copy from "lucide-react/dist/esm/icons/copy.mjs";
import Laptop from "lucide-react/dist/esm/icons/laptop.mjs";
import RefreshCw from "lucide-react/dist/esm/icons/refresh-cw.mjs";

import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { apiJson } from "../../lib/apiClient";
import { useRole } from "../../context/RoleContext";
import {
  EmptyState,
  FormField,
  StatCard,
  StatusIndicator,
  WorkspaceNotice,
  formatEnumLabel,
} from "./InvestigatorUI";

function formatDate(value) {
  if (!value) return "Not available";
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? "Not available" : parsed.toLocaleString();
}

async function copyText(value) {
  await navigator.clipboard.writeText(value);
}

export function DesktopDeviceManagement() {
  const { identity } = useRole();
  const organisationId = identity?.organisationId;
  const [state, setState] = useState({ status: "loading", snapshot: null, error: "" });
  const [issue, setIssue] = useState({ expiresInHours: 24, maximumUses: 1, password: "", confirmation: "" });
  const [oneTimeKey, setOneTimeKey] = useState(null);
  const [submitting, setSubmitting] = useState(false);

  const load = useCallback(async () => {
    if (!organisationId) return;
    setState((previous) => ({ ...previous, status: previous.snapshot ? "refreshing" : "loading", error: "" }));
    try {
      const snapshot = await apiJson(`/admin/desktop/organisations/${encodeURIComponent(organisationId)}`, { cache: "no-store" });
      setState({ status: "ready", snapshot, error: "" });
    } catch (error) {
      setState((previous) => ({ ...previous, status: previous.snapshot ? "stale" : "error", error: error.message }));
    }
  }, [organisationId]);

  useEffect(() => { load(); }, [load]);

  async function issueKey(event) {
    event.preventDefault();
    setSubmitting(true);
    setOneTimeKey(null);
    try {
      const result = await apiJson(`/admin/desktop/organisations/${encodeURIComponent(organisationId)}/activation-keys`, {
        method: "POST",
        body: JSON.stringify(issue),
      });
      setOneTimeKey(result.activationKey);
      setIssue((previous) => ({ ...previous, password: "", confirmation: "" }));
      await load();
    } catch (error) {
      setState((previous) => ({ ...previous, error: error.message }));
    } finally {
      setSubmitting(false);
    }
  }

  async function revoke(kind, id) {
    const label = kind === "devices" ? "DEVICE" : "KEY";
    const password = window.prompt("Enter your current password to confirm this administrative action.");
    if (!password) return;
    const confirmation = window.prompt(`Type REVOKE ${label} ${id} exactly.`);
    if (confirmation !== `REVOKE ${label} ${id}`) return;
    try {
      await apiJson(`/admin/desktop/organisations/${encodeURIComponent(organisationId)}/${kind}/${encodeURIComponent(id)}/revoke`, {
        method: "POST",
        body: JSON.stringify({ password, confirmation }),
      });
      await load();
    } catch (error) {
      setState((previous) => ({ ...previous, error: error.message }));
    }
  }

  const snapshot = state.snapshot || {};
  const devices = snapshot.devices || [];
  const activationKeys = snapshot.activationKeys || [];
  const activeDevices = devices.filter((device) => device.status === "active").length;

  return (
    <div className="space-y-6">
      {state.error ? <WorkspaceNotice title="Desktop device administration failed" tone="danger">{state.error}</WorkspaceNotice> : null}
      {oneTimeKey ? (
        <WorkspaceNotice
          title="Copy this organisation activation key now"
          tone="warning"
          actions={<Button type="button" variant="outline" size="sm" onClick={() => copyText(oneTimeKey.activationKey)}><Copy className="mr-2 h-4 w-4" />Copy key</Button>}
        >
          <p>This key is shown once and is not recoverable after this notice is dismissed.</p>
          <code className="mt-3 block break-all rounded-md border border-border bg-background p-3 font-data text-sm" data-testid="one-time-activation-key">{oneTimeKey.activationKey}</code>
          <p className="mt-2 text-xs">Expires {formatDate(oneTimeKey.expiresAt)} · maximum uses {oneTimeKey.maximumUses}</p>
        </WorkspaceNotice>
      ) : null}

      <section aria-label="Desktop policy summary" className="grid gap-4 sm:grid-cols-3">
        <StatCard title="Active devices" value={activeDevices} description={`of ${snapshot.policy?.deviceLimit || 5} licensed devices`} />
        <StatCard title="Unused keys" value={activationKeys.filter((key) => key.status === "pending").length} description="One-way hashes only are retained by the server." />
        <StatCard title="Offline grace" value={`${snapshot.policy?.offlineGraceDays || 7} days`} description="Cached data locks when signed grace expires." />
      </section>

      <form onSubmit={issueKey} className="grid gap-4 rounded-xl border border-border/70 bg-background/30 p-4 sm:p-5">
        <div>
          <h4 className="font-semibold">Issue organisation activation key</h4>
          <p className="mt-1 text-sm text-muted-foreground">Step-up authentication is required. The key enrolls one device by default and never replaces user login.</p>
        </div>
        <div className="grid gap-4 md:grid-cols-2">
          <FormField label="Expires in hours"><Input type="number" min="1" max="168" value={issue.expiresInHours} onChange={(event) => setIssue((previous) => ({ ...previous, expiresInHours: Number(event.target.value) }))} /></FormField>
          <FormField label="Maximum uses" hint="Use one unless a controlled batch enrollment is explicitly required."><Input type="number" min="1" max="10000" value={issue.maximumUses} onChange={(event) => setIssue((previous) => ({ ...previous, maximumUses: Number(event.target.value) }))} /></FormField>
          <FormField label="Current password"><Input type="password" autoComplete="current-password" value={issue.password} onChange={(event) => setIssue((previous) => ({ ...previous, password: event.target.value }))} required /></FormField>
          <FormField label="Confirmation" hint={<span>Type <code>ISSUE DESKTOP KEY</code>.</span>}><Input value={issue.confirmation} onChange={(event) => setIssue((previous) => ({ ...previous, confirmation: event.target.value }))} required /></FormField>
        </div>
        <Button type="submit" className="w-fit" disabled={submitting || issue.confirmation !== "ISSUE DESKTOP KEY"}>{submitting ? "Issuing…" : "Issue activation key"}</Button>
      </form>

      <div className="space-y-3">
        <div className="flex items-center justify-between gap-3"><div><h4 className="font-semibold">Enrolled devices</h4><p className="mt-1 text-sm text-muted-foreground">Device public keys and original activation keys are never displayed.</p></div><Button type="button" variant="outline" size="sm" onClick={load} disabled={state.status === "refreshing"}><RefreshCw className="mr-2 h-4 w-4" />Refresh</Button></div>
        {devices.length === 0 && state.status !== "loading" ? <EmptyState icon={Laptop} title="No desktop devices enrolled" description="Issue an activation key to enroll the first Windows installation." compact /> : null}
        <div className="divide-y divide-border/70 rounded-xl border border-border/70">
          {devices.map((device) => (
            <div key={device.deviceEnrollmentId} className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between">
              <div className="min-w-0"><div className="flex flex-wrap items-center gap-2"><p className="font-data text-sm font-semibold">{device.installationId}</p><StatusIndicator variant="badge" tone={device.status === "active" ? "success" : "danger"}>{formatEnumLabel(device.status)}</StatusIndicator></div><p className="mt-1 text-xs text-muted-foreground">Activated {formatDate(device.activatedAt)} · last seen {formatDate(device.lastSeenAt)}</p></div>
              {device.status === "active" ? <Button type="button" variant="destructive" size="sm" onClick={() => revoke("devices", device.deviceEnrollmentId)}>Revoke device</Button> : null}
            </div>
          ))}
        </div>
      </div>

      <div className="space-y-3"><h4 className="font-semibold">Activation keys</h4><div className="divide-y divide-border/70 rounded-xl border border-border/70">{activationKeys.map((key) => <div key={key.activationKeyId} className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between"><div><div className="flex items-center gap-2"><span className="font-data text-sm">{key.activationKeyId}</span><StatusIndicator variant="badge" tone={key.status === "pending" ? "warning" : key.status === "used" ? "success" : "danger"}>{formatEnumLabel(key.status)}</StatusIndicator></div><p className="mt-1 text-xs text-muted-foreground">Issued {formatDate(key.issuedAt)} · expires {formatDate(key.expiresAt)} · uses {key.useCount}/{key.maximumUses}</p></div>{key.status === "pending" ? <Button type="button" variant="outline" size="sm" onClick={() => revoke("activation-keys", key.activationKeyId)}>Revoke unused key</Button> : null}</div>)}</div></div>

      <div className="space-y-3"><h4 className="font-semibold">Activation audit history</h4><div className="divide-y divide-border/70 rounded-xl border border-border/70">{(snapshot.auditHistory || []).map((event) => <div key={event.desktopAuditEventId} className="flex flex-wrap items-center justify-between gap-3 p-4"><div><p className="text-sm font-medium">{formatEnumLabel(event.action)}</p><p className="mt-1 text-xs text-muted-foreground">{formatDate(event.occurredAt)} · correlation {event.correlationId || "not supplied"}</p></div><StatusIndicator variant="badge" tone={event.outcome === "success" ? "success" : "danger"}>{formatEnumLabel(event.outcome)}</StatusIndicator></div>)}</div></div>
    </div>
  );
}
