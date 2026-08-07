import React, { useMemo, useState } from "react";
import Activity from "lucide-react/dist/esm/icons/activity.mjs";
import Building2 from "lucide-react/dist/esm/icons/building-2.mjs";
import Network from "lucide-react/dist/esm/icons/network.mjs";
import ShieldCheck from "lucide-react/dist/esm/icons/shield-check.mjs";
import { Button } from "../../components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../../components/ui/card";
import { Input } from "../../components/ui/input";
import { useRole } from "../../context/RoleContext";
import { PRODUCT_NAME } from "../../lib/productBrand";

function configuredInitialSlug() {
  const match = window.location.pathname.match(/^\/o\/([^/]+)\/login\/?$/);
  return match ? decodeURIComponent(match[1]) : "";
}

function isLocalHost(host) {
  return /^(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/i.test(String(host || ""));
}

export function organisationSignInUrl(slug, runtime = window) {
  const normalizedSlug = String(slug || "").trim().toLowerCase();
  const renderedSlug = normalizedSlug || "<organisation>";
  const configuredScheme = String(runtime.__CLAIMGUARD_ORGANISATION_URL_SCHEME__ || "").trim();
  const configuredHost = String(runtime.__CLAIMGUARD_ORGANISATION_HOST__ || "").trim();
  const currentHost = String(runtime.location?.host || "").trim();
  const currentProtocol = String(runtime.location?.protocol || "https:").replace(/:$/, "");
  const configuredHostIsUnsafeFallback = isLocalHost(configuredHost) && !isLocalHost(currentHost);

  if (configuredHost && !configuredHostIsUnsafeFallback) {
    return `${configuredScheme || "https"}://${renderedSlug}.${configuredHost}`;
  }

  const origin = runtime.location?.origin
    || `${currentProtocol || "https"}://${currentHost}`;
  return `${origin}/o/${renderedSlug}/login`;
}

export function LoginPage() {
  const { login, error, status } = useRole();
  const [organisationSlug, setOrganisationSlug] = useState(configuredInitialSlug);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const normalizedSlug = organisationSlug.trim().toLowerCase();
  const preview = useMemo(
    () => organisationSignInUrl(normalizedSlug),
    [normalizedSlug],
  );

  async function submit(event) {
    event.preventDefault();
    await login({ organisationSlug, username, password });
    setPassword("");
  }

  return (
    <main className="relative flex min-h-screen items-center justify-center overflow-hidden bg-background p-4 text-foreground sm:p-6">
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_15%_15%,hsl(var(--primary)/0.12),transparent_34%),radial-gradient(circle_at_85%_80%,hsl(var(--accent)/0.1),transparent_32%)]" aria-hidden="true" />
      <div className="relative grid w-full max-w-6xl overflow-hidden rounded-3xl border border-border/80 bg-card shadow-2xl shadow-black/10 lg:grid-cols-[1.05fr_0.95fr]">
        <section className="relative flex min-h-[360px] flex-col justify-between overflow-hidden border-b border-border bg-surface-elevated p-7 sm:p-10 lg:min-h-[650px] lg:border-b-0 lg:border-r">
          <div className="pointer-events-none absolute -right-24 top-20 h-64 w-64 rounded-full border border-primary/15 bg-primary/5" aria-hidden="true" />
          <div className="relative">
            <div className="flex items-center gap-3">
              <span className="flex h-11 w-11 items-center justify-center rounded-xl border border-primary/20 bg-primary/10 text-primary">
                <Activity className="h-5 w-5" aria-hidden="true" />
              </span>
              <div>
                <p className="font-display text-lg font-semibold">{PRODUCT_NAME}</p>
                <p className="font-data text-[10px] uppercase tracking-[0.2em] text-muted-foreground">Medical-scheme integrity</p>
              </div>
            </div>
            <p className="mt-16 font-data text-xs font-semibold uppercase tracking-[0.22em] text-primary">Secure scheme workspace</p>
            <h1 className="mt-4 max-w-xl font-display text-4xl font-semibold leading-tight tracking-tight sm:text-5xl">
              Claims intelligence built for decisive, auditable action.
            </h1>
            <p className="mt-5 max-w-lg text-base leading-7 text-muted-foreground">
              Screen prospective claims, investigate suspicious activity, and collaborate through a tenant-isolated fraud network.
            </p>
          </div>

          <div className="relative mt-12 grid gap-3 sm:grid-cols-3 lg:grid-cols-1">
            {[
              { icon: ShieldCheck, title: "Role-governed", text: "Every view and action follows your assigned capabilities." },
              { icon: Building2, title: "Scheme-isolated", text: "Operational data stays within the resolved medical-scheme tenant." },
              { icon: Network, title: "Network-aware", text: "Confirmed findings can support authorised cross-scheme decisions." },
            ].map((item) => {
              const Icon = item.icon;
              return (
                <div key={item.title} className="flex gap-3 rounded-xl border border-border/70 bg-background/45 p-3.5">
                  <Icon className="mt-0.5 h-4 w-4 shrink-0 text-primary" aria-hidden="true" />
                  <div>
                    <p className="text-sm font-semibold">{item.title}</p>
                    <p className="mt-0.5 text-xs leading-5 text-muted-foreground">{item.text}</p>
                  </div>
                </div>
              );
            })}
          </div>
        </section>

        <div className="flex flex-col justify-center gap-5 p-5 sm:p-8 lg:p-10">
          <Card className="border-border/80 shadow-none">
            <CardHeader>
              <CardTitle className="font-display text-2xl">Sign in to {PRODUCT_NAME}</CardTitle>
              <CardDescription>Use your organisation and assigned account credentials.</CardDescription>
            </CardHeader>
            <CardContent>
              <form className="space-y-4" onSubmit={submit}>
                <label className="grid gap-2 text-sm font-medium">Organisation
                  <Input aria-label="Organisation" autoComplete="organization" value={organisationSlug} onChange={(event) => setOrganisationSlug(event.target.value)} placeholder="medical-scheme-slug" required />
                </label>
                <label className="grid gap-2 text-sm font-medium">Username
                  <Input aria-label="Username" autoComplete="username" value={username} onChange={(event) => setUsername(event.target.value)} required />
                </label>
                <label className="grid gap-2 text-sm font-medium">Password
                  <Input aria-label="Password" type="password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} required />
                </label>
                <div className="rounded-lg border border-border bg-secondary/30 p-3">
                  <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Organisation sign-in address</p>
                  <output className="mt-1 block break-all font-mono text-sm">{preview}</output>
                  <p className="mt-1 text-xs text-muted-foreground">This address identifies the organisation at sign-in; server-side routing still controls data access.</p>
                </div>
                {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
                <Button type="submit" disabled={status === "loading"} className="w-full">{status === "loading" ? "Signing in…" : "Sign in"}</Button>
              </form>
            </CardContent>
          </Card>
        </div>
      </div>
    </main>
  );
}
