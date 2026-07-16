import React, { useEffect, useMemo, useState } from "react";
import { Button } from "../../components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../../components/ui/card";
import { Input } from "../../components/ui/input";
import { useRole } from "../../context/RoleContext";
import { apiJson } from "../../lib/apiClient";

function configuredInitialSlug() {
  const match = window.location.pathname.match(/^\/o\/([^/]+)\/login\/?$/);
  return match ? decodeURIComponent(match[1]) : "";
}

export function LoginPage() {
  const { login, error, status } = useRole();
  const [organisationSlug, setOrganisationSlug] = useState(configuredInitialSlug);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [demoAccounts, setDemoAccounts] = useState([]);
  const scheme = window.__CLAIMGUARD_ORGANISATION_URL_SCHEME__ || "https";
  const host = window.__CLAIMGUARD_ORGANISATION_HOST__ || window.location.host;
  const normalizedSlug = organisationSlug.trim().toLowerCase();
  const preview = useMemo(() => normalizedSlug ? `${scheme}://${normalizedSlug}.${host}` : `${scheme}://<organisation>.${host}`, [scheme, host, normalizedSlug]);

  useEffect(() => {
    apiJson("/auth/demo-accounts", { cache: "no-store", skipUnauthorizedHandler: true })
      .then((payload) => setDemoAccounts(payload.accounts || []))
      .catch(() => setDemoAccounts([]));
  }, []);

  async function submit(event) {
    event.preventDefault();
    await login({ organisationSlug, username, password });
    setPassword("");
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-background p-4 text-foreground">
      <div className="grid w-full max-w-5xl gap-6 lg:grid-cols-[1fr_0.9fr]">
        <Card>
          <CardHeader>
            <CardTitle>Sign in to ClaimGuard</CardTitle>
            <CardDescription>Use your organisation slug and assigned account credentials.</CardDescription>
          </CardHeader>
          <CardContent>
            <form className="space-y-4" onSubmit={submit}>
              <label className="block text-sm font-medium">Organisation
                <Input aria-label="Organisation" autoComplete="organization" value={organisationSlug} onChange={(event) => setOrganisationSlug(event.target.value)} required />
              </label>
              <label className="block text-sm font-medium">Username
                <Input aria-label="Username" autoComplete="username" value={username} onChange={(event) => setUsername(event.target.value)} required />
              </label>
              <label className="block text-sm font-medium">Password
                <Input aria-label="Password" type="password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} required />
              </label>
              <div className="rounded-lg border border-border bg-secondary/30 p-3">
                <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Organisation URL preview</p>
                <output className="mt-1 block break-all font-mono text-sm">{preview}</output>
                <p className="mt-1 text-xs text-muted-foreground">Informational only; this URL never selects a database or grants access.</p>
              </div>
              {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
              <Button type="submit" disabled={status === "loading"} className="w-full">{status === "loading" ? "Signing in…" : "Sign in"}</Button>
            </form>
          </CardContent>
        </Card>
        {demoAccounts.length > 0 ? (
          <Card className="border-amber-500/50">
            <CardHeader><CardTitle>Demo Accounts</CardTitle><CardDescription>DEMO ONLY — these credentials must never be used for real accounts.</CardDescription></CardHeader>
            <CardContent className="space-y-3">
              {demoAccounts.map((account) => (
                <button key={account.catalogueEntryId} type="button" className="w-full rounded-lg border border-border p-3 text-left" onClick={() => {
                  setOrganisationSlug(account.organisationSlug); setUsername(account.usernameDisplayValue); setPassword(account.password);
                }}>
                  <strong className="block text-sm">{account.organisationName} · {account.roleLabel}</strong>
                  <span className="block font-mono text-xs">{account.usernameDisplayValue} / {account.password}</span>
                </button>
              ))}
            </CardContent>
          </Card>
        ) : null}
      </div>
    </main>
  );
}
