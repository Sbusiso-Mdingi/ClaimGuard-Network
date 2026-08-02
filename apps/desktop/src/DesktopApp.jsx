import React, { useCallback, useEffect, useMemo, useState } from "react";
import LockKeyhole from "lucide-react/dist/esm/icons/lock-keyhole.mjs";
import ShieldCheck from "lucide-react/dist/esm/icons/shield-check.mjs";
import WifiOff from "lucide-react/dist/esm/icons/wifi-off.mjs";

import { Button } from "../../web/src/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../../web/src/components/ui/card";
import { Input } from "../../web/src/components/ui/input";
import { desktopBridge } from "./desktopBridge";
import { DesktopWorkspace } from "./DesktopWorkspace";

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
      setStatus(await desktopBridge.login(username, password));
    } catch (error) {
      setError(error?.message || "The account could not be authorised for the licensed organisation.");
    }
  }, [setError]);

  const screen = useMemo(() => {
    if (!status) return <main className="grid min-h-screen place-items-center bg-background text-foreground"><div className="text-center"><ShieldCheck className="mx-auto h-8 w-8 animate-pulse text-primary" /><p className="mt-3 text-sm text-muted-foreground">Opening the secure cache…</p></div></main>;
    if (status.activationRequired) return <ActivationScreen onActivated={setStatus} />;
    if (status.locked || !status.authenticated) return <LoginScreen status={status} onLogin={login} resetError={() => setStatus((previous) => ({ ...previous, error: "" }))} />;
    return <DesktopWorkspace status={status} onStatus={setStatus} onError={setError} />;
  }, [login, setError, status]);

  return screen;
}
