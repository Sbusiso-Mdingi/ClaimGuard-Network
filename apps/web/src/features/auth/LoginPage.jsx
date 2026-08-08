import React from "react";
import { SignIn } from "@clerk/react";
import Activity from "lucide-react/dist/esm/icons/activity.mjs";
import Building2 from "lucide-react/dist/esm/icons/building-2.mjs";
import Network from "lucide-react/dist/esm/icons/network.mjs";
import ShieldCheck from "lucide-react/dist/esm/icons/shield-check.mjs";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../../components/ui/card";
import { useWorkforceIdentity } from "../../context/WorkforceIdentityContext";
import { PRODUCT_NAME } from "../../lib/productBrand";

export function LoginPage() {
  const workforce = useWorkforceIdentity();
  return (
    <main className="relative flex min-h-screen items-center justify-center overflow-hidden bg-background p-4 text-foreground sm:p-6">
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_15%_15%,hsl(var(--primary)/0.12),transparent_34%),radial-gradient(circle_at_85%_80%,hsl(var(--accent)/0.1),transparent_32%)]" aria-hidden="true" />
      <div className="relative grid w-full max-w-6xl overflow-hidden rounded-3xl border border-border/80 bg-card shadow-2xl shadow-black/10 lg:grid-cols-[1.05fr_0.95fr]">
        <section className="relative flex min-h-[360px] flex-col justify-between overflow-hidden border-b border-border bg-surface-elevated p-7 sm:p-10 lg:min-h-[650px] lg:border-b-0 lg:border-r">
          <div className="relative">
            <div className="flex items-center gap-3">
              <span className="flex h-11 w-11 items-center justify-center rounded-xl border border-primary/20 bg-primary/10 text-primary"><Activity className="h-5 w-5" aria-hidden="true" /></span>
              <div><p className="font-display text-lg font-semibold">{PRODUCT_NAME}</p><p className="font-data text-[10px] uppercase tracking-[0.2em] text-muted-foreground">Medical-scheme integrity</p></div>
            </div>
            <p className="mt-16 font-data text-xs font-semibold uppercase tracking-[0.22em] text-primary">Secure workforce workspace</p>
            <h1 className="mt-4 max-w-xl font-display text-4xl font-semibold leading-tight tracking-tight sm:text-5xl">Claims intelligence built for decisive, auditable action.</h1>
            <p className="mt-5 max-w-lg text-base leading-7 text-muted-foreground">Invitation-only access with verified work email, multi-factor authentication, and organisation selection.</p>
          </div>
          <div className="relative mt-12 grid gap-3 sm:grid-cols-3 lg:grid-cols-1">
            {[
              { icon: ShieldCheck, title: "Clerk-secured", text: "Passwords and consumer social sign-in are not accepted by Sequrin." },
              { icon: Building2, title: "Organisation-bound", text: "Your selected workforce organisation is mapped to one internal tenant." },
              { icon: Network, title: "Server-authorised", text: "Sequrin roles and permissions remain authoritative on every request." },
            ].map((item) => { const Icon = item.icon; return <div key={item.title} className="flex gap-3 rounded-xl border border-border/70 bg-background/45 p-3.5"><Icon className="mt-0.5 h-4 w-4 shrink-0 text-primary" aria-hidden="true" /><div><p className="text-sm font-semibold">{item.title}</p><p className="mt-0.5 text-xs leading-5 text-muted-foreground">{item.text}</p></div></div>; })}
          </div>
        </section>
        <div className="flex flex-col items-center justify-center gap-5 p-5 sm:p-8 lg:p-10">
          {workforce.managed ? (
            <SignIn routing="path" path="/sign-in" fallbackRedirectUrl="/" signUpUrl="/sign-up" />
          ) : (
            <Card className="w-full max-w-md border-border/80 shadow-none"><CardHeader><CardTitle>Workforce sign-in unavailable</CardTitle><CardDescription>Clerk has not been configured for this client.</CardDescription></CardHeader><CardContent><p className="text-sm text-muted-foreground">Ask the platform administrator to configure the Clerk publishable key. Local passwords are not accepted.</p></CardContent></Card>
          )}
        </div>
      </div>
    </main>
  );
}
