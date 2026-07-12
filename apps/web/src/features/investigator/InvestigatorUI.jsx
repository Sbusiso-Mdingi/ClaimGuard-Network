import React from "react";
import { Badge } from "../../components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../../components/ui/card";

export function PageFrame({ eyebrow, title, description, actions, children }) {
  return (
    <div className="space-y-5">
      <header className="flex flex-col gap-4 border-b border-border/70 pb-4 lg:flex-row lg:items-end lg:justify-between">
        <div className="space-y-1">
          {eyebrow ? <p className="text-xs font-semibold uppercase tracking-[0.24em] text-muted-foreground">{eyebrow}</p> : null}
          <h1 className="text-2xl font-semibold tracking-tight text-foreground lg:text-[1.75rem]">{title}</h1>
          {description ? <p className="max-w-3xl text-sm leading-6 text-muted-foreground">{description}</p> : null}
        </div>
        {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
      </header>
      {children}
    </div>
  );
}

export function SectionCard({ title, description, actions, children, className = "" }) {
  return (
    <Card className={className}>
      <CardHeader className="space-y-2 pb-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="space-y-1">
            <CardTitle className="text-base font-semibold tracking-tight">{title}</CardTitle>
            {description ? <CardDescription className="max-w-3xl text-sm leading-6">{description}</CardDescription> : null}
          </div>
          {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
        </div>
      </CardHeader>
      <CardContent className="pt-0">{children}</CardContent>
    </Card>
  );
}

export function StatCard({ title, value, description, icon: Icon, tone = "default" }) {
  const toneClasses =
    tone === "success"
      ? "border-emerald-500/25 bg-emerald-500/5"
      : tone === "warning"
        ? "border-amber-500/25 bg-amber-500/5"
        : tone === "danger"
          ? "border-rose-500/25 bg-rose-500/5"
          : "border-border/80 bg-card";

  return (
    <Card className={`overflow-hidden shadow-[0_10px_30px_rgba(15,23,42,0.08)] ${toneClasses}`}>
      <CardHeader className="space-y-3 pb-3">
        <div className="flex items-center justify-between gap-3">
          <p className="text-xs font-medium uppercase tracking-[0.18em] text-muted-foreground">{title}</p>
          {Icon ? <Icon className="h-4 w-4 text-muted-foreground" /> : null}
        </div>
        <CardTitle className="text-3xl leading-none tracking-tight">{value}</CardTitle>
      </CardHeader>
      <CardContent className="pt-0">
        <p className="text-sm leading-6 text-muted-foreground">{description}</p>
      </CardContent>
    </Card>
  );
}

export function MetricPill({ label, value, tone = "default" }) {
  const toneClasses =
    tone === "success"
      ? "border-emerald-500/20 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
      : tone === "warning"
        ? "border-amber-500/20 bg-amber-500/10 text-amber-700 dark:text-amber-300"
        : tone === "danger"
          ? "border-rose-500/20 bg-rose-500/10 text-rose-700 dark:text-rose-300"
          : "border-border bg-secondary text-foreground";

  return (
    <div className={`inline-flex items-center gap-2 rounded-full border px-3 py-1 text-xs font-medium ${toneClasses}`}>
      <span className="uppercase tracking-[0.18em] text-[10px] opacity-70">{label}</span>
      <span>{value}</span>
    </div>
  );
}

export function StatusBadge({ children, variant = "outline" }) {
  return <Badge variant={variant} className="rounded-full px-2.5 py-1 text-[11px] font-semibold tracking-wide">{children}</Badge>;
}