import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Activity from "lucide-react/dist/esm/icons/activity.mjs";
import Clock3 from "lucide-react/dist/esm/icons/clock-3.mjs";
import FileSearch from "lucide-react/dist/esm/icons/file-search.mjs";
import LockKeyhole from "lucide-react/dist/esm/icons/lock-keyhole.mjs";
import LogOut from "lucide-react/dist/esm/icons/log-out.mjs";
import RefreshCw from "lucide-react/dist/esm/icons/refresh-cw.mjs";
import RotateCcw from "lucide-react/dist/esm/icons/rotate-ccw.mjs";
import ShieldCheck from "lucide-react/dist/esm/icons/shield-check.mjs";
import WifiOff from "lucide-react/dist/esm/icons/wifi-off.mjs";

import { Button } from "../../web/src/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../../web/src/components/ui/card";
import { Input } from "../../web/src/components/ui/input";
import { desktopBridge, nextBackoff, operationalWriteAllowed } from "./desktopBridge";

const AUTO_LOCK_MS = 15 * 60_000;

function displayDate(value) {
  if (!value) return "Never";
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? "Unknown" : parsed.toLocaleString();
}

function money(value) {
  return Number.isFinite(Number(value))
    ? new Intl.NumberFormat("en-ZA", { style: "currency", currency: "ZAR" }).format(Number(value))
    : "Not available";
}

function freshnessClasses(freshness) {
  if (freshness === "Fresh") return "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300";
  if (freshness === "Synchronizing") return "border-sky-500/30 bg-sky-500/10 text-sky-700 dark:text-sky-300";
  if (freshness === "Offline") return "border-rose-500/30 bg-rose-500/10 text-rose-700 dark:text-rose-300";
  return "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300";
}

function Brand() {
  return (
    <div className="flex items-center gap-3">
      <span className="grid h-10 w-10 place-items-center rounded-xl bg-primary text-primary-foreground shadow-sm"><ShieldCheck className="h-5 w-5" /></span>
      <div><p className="font-display text-base font-semibold">ClaimGuard</p><p className="font-data text-[10px] uppercase tracking-[0.18em] text-muted-foreground">Secure desktop</p></div>
    </div>
  );
}

function ActivationScreen({ onActivated }) {
  const [activationKey, setActivationKey] = useState("");
  const [state, setState] = useState({ submitting: false, error: "" });

  async function submit(event) {
    event.preventDefault();
    setState({ submitting: true, error: "" });
    try {
      const status = await desktopBridge.activate(activationKey);
      setActivationKey("");
      onActivated(status);
    } catch (error) {
      setState({ submitting: false, error: error?.message || "Activation could not be completed." });
    }
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-background p-5 text-foreground">
      <div className="grid w-full max-w-5xl overflow-hidden rounded-3xl border border-border bg-card shadow-2xl lg:grid-cols-[1fr_0.85fr]">
        <section className="flex min-h-[520px] flex-col justify-between border-b border-border bg-surface-elevated p-8 lg:border-b-0 lg:border-r lg:p-10">
          <Brand />
          <div><h1 className="max-w-lg font-display text-4xl font-semibold tracking-tight">Activate this trusted ClaimGuard workstation.</h1><p className="mt-4 max-w-lg leading-7 text-muted-foreground">Your organisation administrator provides a one-time activation key. It enrolls this Windows installation and cannot be used as an account credential.</p></div>
          <div className="flex gap-3 rounded-xl border border-border bg-background/60 p-4"><LockKeyhole className="mt-0.5 h-5 w-5 shrink-0 text-primary" /><p className="text-sm leading-6 text-muted-foreground">The device private key and cache key are stored with Windows-protected credentials. ClaimGuard never connects directly to the operational database.</p></div>
        </section>
        <section className="flex items-center p-6 sm:p-9">
          <Card className="w-full shadow-none"><CardHeader><CardTitle className="font-display text-2xl">Organisation activation</CardTitle><CardDescription>Enter the key on first launch. It is sent only to the configured ClaimGuard activation service over TLS.</CardDescription></CardHeader><CardContent><form className="space-y-4" onSubmit={submit}><label className="grid gap-2 text-sm font-medium">Organisation Activation Key<Input aria-label="Organisation Activation Key" type="password" autoComplete="off" spellCheck="false" value={activationKey} onChange={(event) => setActivationKey(event.target.value)} required /></label>{state.error ? <p role="alert" className="text-sm text-destructive">{state.error}</p> : null}<Button type="submit" className="w-full" disabled={state.submitting}>{state.submitting ? "Activating…" : "Activate ClaimGuard"}</Button></form></CardContent></Card>
        </section>
      </div>
    </main>
  );
}

function LoginScreen({ status, onLogin, resetError }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);

  async function submit(event) {
    event.preventDefault();
    setSubmitting(true);
    resetError();
    try {
      await onLogin(username, password);
      setPassword("");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-background p-5 text-foreground">
      <Card className="w-full max-w-md"><CardHeader><Brand /><CardTitle className="pt-6 font-display text-2xl">Sign in to the licensed organisation</CardTitle><CardDescription>User authentication remains separate from device enrollment.</CardDescription></CardHeader><CardContent><div className="mb-5 rounded-xl border border-primary/20 bg-primary/5 p-4"><p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">Licensed to</p><p className="mt-1 font-display text-lg font-semibold" data-testid="licensed-organisation">{status.enrollment?.organisationDisplayName}</p></div><form className="space-y-4" onSubmit={submit}><label className="grid gap-2 text-sm font-medium">Username<Input aria-label="Username" autoComplete="username" value={username} onChange={(event) => setUsername(event.target.value)} required /></label><label className="grid gap-2 text-sm font-medium">Password<Input aria-label="Password" type="password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} required /></label>{status.error ? <p role="alert" className="text-sm text-destructive">{status.error}</p> : null}{status.lockReason === "offline_grace_expired" ? <p role="alert" className="flex gap-2 text-sm text-destructive"><WifiOff className="h-4 w-4 shrink-0" />Cached scheme data is locked until this device reconnects and validates its enrollment.</p> : null}<Button type="submit" className="w-full" disabled={submitting}>{submitting ? "Signing in…" : "Sign in"}</Button></form></CardContent></Card>
    </main>
  );
}

function RiskLabel({ score }) {
  const value = Number(score);
  const className = value >= 70 ? "bg-rose-500/10 text-rose-700 dark:text-rose-300" : value >= 40 ? "bg-amber-500/10 text-amber-700 dark:text-amber-300" : "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300";
  return <span className={`inline-flex rounded-md px-2 py-1 font-data text-xs font-semibold ${className}`}>{Number.isFinite(value) ? `${value.toFixed(1)} risk` : "Unscored"}</span>;
}

function Workspace({ status, onStatus, onError }) {
  const [selectedClaim, setSelectedClaim] = useState(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [resetConfirmation, setResetConfirmation] = useState("");
  const claims = status.cache?.claims || [];
  const summary = status.cache?.dashboard?.summary || {};
  const syncAttempt = useRef(0);
  const syncing = useRef(false);
  const initialSyncStarted = useRef(false);

  const syncNow = useCallback(async () => {
    if (syncing.current || !status.authenticated || status.locked) return;
    syncing.current = true;
    onStatus((previous) => ({ ...previous, cache: { ...previous.cache, freshness: "Synchronizing" } }));
    try {
      const next = await desktopBridge.sync();
      syncAttempt.current = 0;
      onStatus(next);
    } catch (error) {
      syncAttempt.current += 1;
      onError(error?.message || "Synchronization failed. Cached data remains read-only.", true);
    } finally {
      syncing.current = false;
    }
  }, [onError, onStatus, status.authenticated, status.locked]);

  useEffect(() => {
    if (initialSyncStarted.current) return undefined;
    initialSyncStarted.current = true;
    const initial = window.setTimeout(syncNow, 0);
    return () => window.clearTimeout(initial);
  }, [syncNow]);

  useEffect(() => {
    const delay = status.syncHasMore ? 250 : nextBackoff(syncAttempt.current, { active: document.visibilityState === "visible" });
    const timer = window.setTimeout(syncNow, delay);
    return () => window.clearTimeout(timer);
  }, [status.cache?.lastSuccessfulSyncAt, status.error, status.syncHasMore, syncNow]);

  useEffect(() => {
    let timer;
    const arm = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(async () => {
        await desktopBridge.lock();
        onStatus((previous) => ({ ...previous, locked: true, lockReason: "automatic_lock" }));
      }, AUTO_LOCK_MS);
    };
    const events = ["pointerdown", "keydown", "focus"];
    events.forEach((event) => window.addEventListener(event, arm, { passive: true }));
    arm();
    return () => { window.clearTimeout(timer); events.forEach((event) => window.removeEventListener(event, arm)); };
  }, [onStatus]);

  async function openClaim(claimId) {
    setDetailLoading(true);
    try { setSelectedClaim(await desktopBridge.claimDetails(claimId)); }
    catch (error) { onError(error?.message || "Claim details are unavailable."); }
    finally { setDetailLoading(false); }
  }

  async function signOut() {
    await desktopBridge.logout();
    onStatus(await desktopBridge.status());
  }

  async function lock() {
    await desktopBridge.lock();
    onStatus((previous) => ({ ...previous, locked: true, lockReason: "manual_lock" }));
  }

  async function reset() {
    await desktopBridge.reset(resetConfirmation);
    onStatus(await desktopBridge.status());
  }

  const writesAllowed = operationalWriteAllowed(status);

  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="desktop-drag-region sticky top-0 z-20 flex min-h-16 items-center gap-4 border-b border-border bg-card px-5"><Brand /><div className="ml-auto flex items-center gap-2 desktop-no-drag"><div className="hidden rounded-lg border border-border bg-background px-3 py-2 sm:block"><span className="text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">Licensed to </span><span className="text-sm font-semibold" data-testid="licensed-organisation">{status.enrollment.organisationDisplayName}</span></div><div className={`inline-flex items-center gap-2 rounded-lg border px-3 py-2 ${freshnessClasses(status.cache?.freshness)}`}><span className="h-2 w-2 rounded-full bg-current" /><span className="text-xs font-semibold">{status.cache?.freshness || "Stale"}</span></div><Button variant="outline" size="sm" onClick={syncNow} disabled={syncing.current}><RefreshCw className="mr-2 h-4 w-4" />Sync</Button><Button variant="ghost" size="sm" onClick={lock}><LockKeyhole className="h-4 w-4" /><span className="sr-only">Lock</span></Button><Button variant="ghost" size="sm" onClick={signOut}><LogOut className="h-4 w-4" /><span className="sr-only">Sign out</span></Button></div></header>

      <main className="mx-auto max-w-[1500px] space-y-6 p-5 sm:p-7">
        <section className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between"><div><p className="font-data text-xs font-semibold uppercase tracking-[0.18em] text-primary">Scheme intelligence</p><h1 className="mt-2 font-display text-3xl font-semibold">Claims overview</h1><p className="mt-2 text-sm text-muted-foreground">Cached summaries render immediately; only deltas after the durable cursor are synchronized.</p></div><div className="flex items-center gap-2 text-xs text-muted-foreground"><Clock3 className="h-4 w-4" />Last successful sync {displayDate(status.cache?.lastSuccessfulSyncAt)}</div></section>

        {status.error ? <div role="alert" className="rounded-xl border border-rose-500/30 bg-rose-500/10 p-4 text-sm text-rose-700 dark:text-rose-300">{status.error}</div> : null}
        {!writesAllowed ? <div className="flex gap-3 rounded-xl border border-amber-500/30 bg-amber-500/10 p-4 text-sm text-amber-800 dark:text-amber-200"><WifiOff className="h-5 w-5 shrink-0" /><div><p className="font-semibold">Offline data is read-only</p><p className="mt-1">Investigation creation, notes, evidence, status transitions, fraud decisions, and administrative actions are blocked until authoritative connectivity returns.</p></div></div> : null}

        <section className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4"><Card><CardHeader className="pb-2"><CardDescription>Cached claims</CardDescription><CardTitle className="font-data text-3xl">{claims.length}</CardTitle></CardHeader><CardContent className="text-xs text-muted-foreground">Most recent 90 days plus active investigations</CardContent></Card><Card><CardHeader className="pb-2"><CardDescription>Total scheme claims</CardDescription><CardTitle className="font-data text-3xl">{summary.totalClaims ?? "—"}</CardTitle></CardHeader><CardContent className="text-xs text-muted-foreground">Current server aggregate, not a local recount</CardContent></Card><Card><CardHeader className="pb-2"><CardDescription>High-risk claims</CardDescription><CardTitle className="font-data text-3xl">{summary.highRiskClaims ?? "—"}</CardTitle></CardHeader><CardContent className="text-xs text-muted-foreground">Current dashboard projection</CardContent></Card><Card><CardHeader className="pb-2"><CardDescription>Average risk</CardDescription><CardTitle className="font-data text-3xl">{Number.isFinite(summary.averageRiskScore) ? summary.averageRiskScore.toFixed(1) : "—"}</CardTitle></CardHeader><CardContent className="text-xs text-muted-foreground">Screening signal, not a fraud finding</CardContent></Card></section>

        <Card><CardHeader className="flex-row items-center justify-between"><div><CardTitle>Cached claim summaries</CardTitle><CardDescription>Minimum necessary, organisation-bound records. Detailed evidence is fetched only when a claim is opened.</CardDescription></div><FileSearch className="h-5 w-5 text-muted-foreground" /></CardHeader><CardContent className="overflow-x-auto p-0"><table className="desktop-claim-table w-full min-w-[800px] text-left text-sm"><thead className="border-y border-border bg-secondary/40 text-[10px] uppercase tracking-[0.12em] text-muted-foreground"><tr><th className="px-5 py-3">Claim</th><th className="px-5 py-3">Service date</th><th className="px-5 py-3">Amount</th><th className="px-5 py-3">Status</th><th className="px-5 py-3">Risk</th><th className="px-5 py-3"><span className="sr-only">Actions</span></th></tr></thead><tbody className="divide-y divide-border/70">{claims.map((claim) => <tr key={claim.claimId}><td className="px-5 py-4 font-data text-xs font-semibold">{claim.claimId}</td><td className="px-5 py-4">{claim.serviceDate || "—"}</td><td className="px-5 py-4 font-data">{money(claim.billedAmount)}</td><td className="px-5 py-4">{claim.status || "Submitted"}</td><td className="px-5 py-4"><RiskLabel score={claim.riskScore} /></td><td className="px-5 py-4 text-right"><Button variant="outline" size="sm" onClick={() => openClaim(claim.claimId)} disabled={detailLoading}>Open</Button></td></tr>)}</tbody></table>{claims.length === 0 ? <div className="grid place-items-center gap-2 p-12 text-center"><Activity className="h-7 w-7 text-muted-foreground" /><p className="font-semibold">No cached claims yet</p><p className="text-sm text-muted-foreground">ClaimGuard will request the first bounded page after authentication.</p></div> : null}</CardContent></Card>

        {selectedClaim ? <Card><CardHeader><CardTitle>Claim {selectedClaim.claim?.claimId || selectedClaim.claimId}</CardTitle><CardDescription>On-demand encrypted detail · fetched {displayDate(selectedClaim.fetchedAt)}</CardDescription></CardHeader><CardContent><pre className="max-h-80 overflow-auto rounded-xl border border-border bg-secondary/30 p-4 text-xs">{JSON.stringify(selectedClaim.claim || selectedClaim, null, 2)}</pre></CardContent></Card> : null}

        <details className="rounded-xl border border-border bg-card p-4"><summary className="cursor-pointer text-sm font-semibold">Administrative device reset</summary><div className="mt-4 max-w-xl space-y-3"><p className="text-sm text-muted-foreground">Reset permanently deletes this Windows user’s encrypted cache, session material, device key, and organisation enrollment. A new activation key is required.</p><label className="grid gap-2 text-sm font-medium">Type RESET CLAIMGUARD<Input value={resetConfirmation} onChange={(event) => setResetConfirmation(event.target.value)} /></label><Button variant="destructive" onClick={reset} disabled={resetConfirmation !== "RESET CLAIMGUARD"}><RotateCcw className="mr-2 h-4 w-4" />Delete cache and reset organisation</Button></div></details>
      </main>
    </div>
  );
}

export function DesktopApp() {
  const [status, setStatus] = useState(null);

  useEffect(() => {
    let active = true;
    desktopBridge.status()
      .then((value) => { if (active) setStatus(value); })
      .catch((error) => { if (active) setStatus({ activationRequired: true, error: error?.message || "ClaimGuard could not open its secure local state." }); });
    return () => { active = false; };
  }, []);

  const setError = useCallback((message, offline = false) => {
    setStatus((previous) => ({
      ...previous,
      error: message,
      cache: offline ? { ...previous.cache, freshness: "Offline" } : previous.cache,
    }));
  }, []);

  const login = useCallback(async (username, password) => {
    try {
      const next = await desktopBridge.login(username, password);
      setStatus(next);
    } catch (error) {
      setError(error?.message || "The account could not be authorised for the licensed organisation.");
    }
  }, [setError]);

  const screen = useMemo(() => {
    if (!status) return <main className="grid min-h-screen place-items-center bg-background text-foreground"><div className="text-center"><ShieldCheck className="mx-auto h-8 w-8 animate-pulse text-primary" /><p className="mt-3 text-sm text-muted-foreground">Opening the secure cache…</p></div></main>;
    if (status.activationRequired) return <ActivationScreen onActivated={setStatus} />;
    if (status.locked || !status.authenticated) return <LoginScreen status={status} onLogin={login} resetError={() => setStatus((previous) => ({ ...previous, error: "" }))} />;
    return <Workspace status={status} onStatus={setStatus} onError={setError} />;
  }, [login, setError, status]);

  return screen;
}
