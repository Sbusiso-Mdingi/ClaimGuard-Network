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
import { PRODUCT_NAME } from "../../lib/productBrand";

function formatDate(value) {
  if (!value) return "Not available";
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? "Not available" : parsed.toLocaleString();
}

async function copyText(value) {
  await navigator.clipboard.writeText(value);
}

export function DesktopFleetPolicyEditor({ organisationId }) {
  const [state, setState] = useState({ status: "loading", snapshot: null, error: "", message: "" });
  const [form, setForm] = useState({ deviceLimit: "", password: "", confirmation: "" });
  const [submitting, setSubmitting] = useState(false);

  const load = useCallback(async () => {
    if (!organisationId) return;
    setState((previous) => ({ ...previous, status: previous.snapshot ? "refreshing" : "loading", error: "" }));
    try {
      const snapshot = await apiJson(`/admin/desktop/organisations/${encodeURIComponent(organisationId)}`, { cache: "no-store" });
      setState({ status: "ready", snapshot, error: "", message: "" });
      setForm((previous) => ({
        ...previous,
        deviceLimit: snapshot.policy?.deviceLimit == null ? "" : String(snapshot.policy.deviceLimit),
      }));
    } catch (error) {
      setState((previous) => ({ ...previous, status: "error", error: error.message, message: "" }));
    }
  }, [organisationId]);

  useEffect(() => { load(); }, [load]);

  const normalizedLimit = Number(form.deviceLimit);
  const expectedConfirmation = Number.isInteger(normalizedLimit) ? `SET DESKTOP LIMIT ${normalizedLimit}` : "";
  const activeDevices = state.snapshot?.usage?.activeDevices ?? 0;
  const policyAuditHistory = (state.snapshot?.auditHistory || [])
    .filter((event) => event.action === "desktop_fleet_policy.updated")
    .slice(0, 10);

  async function save(event) {
    event.preventDefault();
    setSubmitting(true);
    setState((previous) => ({ ...previous, error: "", message: "" }));
    try {
      const result = await apiJson(`/admin/desktop/organisations/${encodeURIComponent(organisationId)}/policy`, {
        method: "PUT",
        body: JSON.stringify({
          deviceLimit: normalizedLimit,
          password: form.password,
          confirmation: form.confirmation,
        }),
      });
      setState((previous) => ({
        ...previous,
        status: "ready",
        snapshot: {
          ...(previous.snapshot || {}),
          policy: result.policy,
          usage: result.usage,
          auditHistory: result.auditEvent
            ? [result.auditEvent, ...(previous.snapshot?.auditHistory || [])]
            : previous.snapshot?.auditHistory || [],
        },
        error: "",
        message: "Licensed desktop allowance updated and audited.",
      }));
      setForm((previous) => ({ ...previous, password: "", confirmation: "" }));
    } catch (error) {
      setState((previous) => ({ ...previous, error: error.message, message: "" }));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="grid gap-4">
      {state.error ? <WorkspaceNotice title="Desktop fleet policy failed" tone="danger">{state.error}</WorkspaceNotice> : null}
      {state.message ? <WorkspaceNotice title={state.message} tone="success" /> : null}
      {state.snapshot?.usage?.overLimit ? (
        <WorkspaceNotice title="Scheme is over its licensed allowance" tone="warning">
          Existing devices remain active. New enrollment is blocked until the allowance is raised or the scheme revokes enough devices.
        </WorkspaceNotice>
      ) : null}
      <div className="grid gap-3 sm:grid-cols-3">
        <StatCard title="Active devices" value={activeDevices} description="Currently authorised Windows installations." />
        <StatCard title="Licensed allowance" value={state.snapshot?.policy?.deviceLimit ?? "Not set"} description={state.snapshot?.policy?.configured ? "Explicit production entitlement." : "Five is used only in test and pilot environments."} />
        <StatCard title="Remaining" value={state.snapshot?.usage?.remainingCapacity ?? "—"} description="New enrollments available under the current allowance." />
      </div>
      <form onSubmit={save} className="grid gap-4 rounded-xl border border-border/70 bg-background/30 p-4 sm:p-5">
        <div>
          <h4 className="font-semibold">Set licensed computer allowance</h4>
          <p className="mt-1 text-sm text-muted-foreground">Only {PRODUCT_NAME} platform administrators can change this value. Reducing it never revokes existing devices.</p>
        </div>
        <div className="grid gap-4 md:grid-cols-3">
          <FormField label="Licensed computers" hint="Enter an explicit allowance from 1 to 10,000."><Input type="number" min="1" max="10000" value={form.deviceLimit} onChange={(event) => setForm((previous) => ({ ...previous, deviceLimit: event.target.value }))} required /></FormField>
          <FormField label="Current password"><Input type="password" autoComplete="current-password" value={form.password} onChange={(event) => setForm((previous) => ({ ...previous, password: event.target.value }))} required /></FormField>
          <FormField label="Confirmation" hint={expectedConfirmation ? <span>Type <code>{expectedConfirmation}</code>.</span> : "Enter an allowance first."}><Input value={form.confirmation} onChange={(event) => setForm((previous) => ({ ...previous, confirmation: event.target.value }))} required /></FormField>
        </div>
        {Number.isInteger(normalizedLimit) && normalizedLimit < activeDevices ? <WorkspaceNotice title="This will put the scheme over its allowance" tone="warning">The {activeDevices} active devices will stay authorised; only new enrollment will be blocked.</WorkspaceNotice> : null}
        <Button type="submit" className="w-fit" disabled={submitting || normalizedLimit < 1 || normalizedLimit > 10000 || form.confirmation !== expectedConfirmation}>{submitting ? "Saving…" : "Update licensed allowance"}</Button>
      </form>
      <div className="grid gap-3">
        <h4 className="font-semibold">Allowance audit history</h4>
        {policyAuditHistory.length === 0 ? <EmptyState title="No allowance changes recorded" description="The first platform-admin policy update will appear here." compact /> : (
          <div className="divide-y divide-border/70 rounded-xl border border-border/70">
            {policyAuditHistory.map((event) => (
              <div key={event.desktopAuditEventId} className="flex flex-wrap items-center justify-between gap-3 p-4">
                <div>
                  <p className="text-sm font-medium">{event.details?.previousDeviceLimit ?? "Not set"} → {event.details?.deviceLimit ?? "Not recorded"} licensed computers</p>
                  <p className="mt-1 text-xs text-muted-foreground">{formatDate(event.occurredAt)} · actor {event.actorId || "not recorded"}</p>
                </div>
                <StatusIndicator variant="badge" tone={event.outcome === "success" ? "success" : "danger"}>{formatEnumLabel(event.outcome)}</StatusIndicator>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
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
  const deviceLimit = snapshot.usage?.deviceLimit ?? snapshot.policy?.deviceLimit ?? null;
  const enrollmentBlocked = snapshot.usage?.enrollmentBlocked ?? (deviceLimit != null && activeDevices >= deviceLimit);
  const overLimit = snapshot.usage?.overLimit ?? (deviceLimit != null && activeDevices > deviceLimit);

  return (
    <div className="space-y-6">
      {state.error ? <WorkspaceNotice title="Desktop device administration failed" tone="danger">{state.error}</WorkspaceNotice> : null}
      {overLimit ? <WorkspaceNotice title="Desktop fleet is over its licensed allowance" tone="warning">Existing devices remain active. Revoke devices or ask {PRODUCT_NAME} to raise the allowance before enrolling another computer.</WorkspaceNotice> : null}
      {!overLimit && enrollmentBlocked ? <WorkspaceNotice title={deviceLimit == null ? "Desktop allowance is not configured" : "Desktop allowance is full"} tone="warning">{deviceLimit == null ? `${PRODUCT_NAME} must configure the scheme licence before a new computer can be enrolled.` : `Revoke an unused device or ask ${PRODUCT_NAME} to raise the licensed allowance.`}</WorkspaceNotice> : null}
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
        <StatCard title="Active devices" value={activeDevices} description={deviceLimit == null ? "Licensed allowance not configured" : `of ${deviceLimit} licensed devices`} />
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
        <Button type="submit" className="w-fit" disabled={submitting || enrollmentBlocked || issue.confirmation !== "ISSUE DESKTOP KEY"}>{submitting ? "Issuing…" : "Issue activation key"}</Button>
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

      <div className="space-y-3"><h4 className="font-semibold">Activation audit history</h4><div className="divide-y divide-border/70 rounded-xl border border-border/70">{(snapshot.auditHistory || []).map((event) => <div key={event.desktopAuditEventId} className="flex flex-wrap items-center justify-between gap-3 p-4"><div><p className="text-sm font-medium">{formatEnumLabel(event.action)}</p>{event.action === "desktop_fleet_policy.updated" ? <p className="mt-1 text-xs text-muted-foreground">Allowance {event.details?.previousDeviceLimit ?? "not set"} → {event.details?.deviceLimit ?? "not recorded"}</p> : null}<p className="mt-1 text-xs text-muted-foreground">{formatDate(event.occurredAt)} · correlation {event.correlationId || "not supplied"}</p></div><StatusIndicator variant="badge" tone={event.outcome === "success" ? "success" : "danger"}>{formatEnumLabel(event.outcome)}</StatusIndicator></div>)}</div></div>
    </div>
  );
}
