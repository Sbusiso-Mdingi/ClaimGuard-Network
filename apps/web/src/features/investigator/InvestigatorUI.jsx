import React from "react";
import { Badge } from "../../components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../../components/ui/card";

export function PageFrame({ eyebrow, title, description, actions, children }) {
  return (
    <div className="space-y-5">
      <header className="flex flex-col gap-4 border-b border-border/70 pb-4 lg:flex-row lg:items-end lg:justify-between">
        <div className="space-y-1">
          {eyebrow ? <p className="font-data text-xs font-semibold uppercase tracking-[0.24em] text-muted-foreground">{eyebrow}</p> : null}
          <h1 className="font-display text-2xl font-semibold tracking-tight text-foreground lg:text-[1.75rem]">{title}</h1>
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
    <Card className={`rounded-xl border border-border/70 bg-card shadow-none ${className}`}>
      <CardHeader className="space-y-2 pb-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="space-y-1">
            <CardTitle className="font-display text-base font-semibold tracking-tight">{title}</CardTitle>
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
  const toneStyles = {
    success: {
      border: "border-emerald-500/40",
      accent: "bg-emerald-500/70",
      chip: "bg-emerald-500/10 text-emerald-600 dark:text-emerald-300",
    },
    warning: {
      border: "border-amber-500/40",
      accent: "bg-amber-500/70",
      chip: "bg-amber-500/10 text-amber-600 dark:text-amber-300",
    },
    danger: {
      border: "border-rose-500/40",
      accent: "bg-rose-500/70",
      chip: "bg-rose-500/10 text-rose-600 dark:text-rose-300",
    },
    default: {
      border: "border-border/80",
      accent: "bg-primary/50",
      chip: "bg-primary/10 text-primary",
    },
  };
  const styles = toneStyles[tone] || toneStyles.default;

  return (
    <Card className={`relative overflow-hidden rounded-xl bg-card shadow-none ${styles.border}`}>
      <span className={`absolute inset-x-0 top-0 h-0.5 ${styles.accent}`} aria-hidden="true" />
      <CardHeader className="space-y-3 pb-3">
        <div className="flex items-center justify-between gap-3">
          <p className="text-xs font-medium uppercase tracking-[0.18em] text-muted-foreground">{title}</p>
          {Icon ? (
            <span className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ${styles.chip}`}>
              <Icon className="h-4 w-4" />
            </span>
          ) : null}
        </div>
        <CardTitle className="font-data text-3xl font-semibold leading-none tracking-tight">{value}</CardTitle>
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
      <span className="font-data">{value}</span>
    </div>
  );
}

const STATUS_TONE_VAR = {
  danger: "--stamp-danger",
  warning: "--stamp-warning",
  success: "--stamp-success",
  info: "--stamp-info",
};

export function StatusIndicator({ children, tone = "info", variant = "stamp" }) {
  if (variant === "badge") {
    const badgeVariant =
      tone === "danger" ? "destructive" : tone === "warning" ? "warning" : tone === "success" ? "success" : "outline";
    return (
      <Badge variant={badgeVariant} className="rounded-full px-2.5 py-1 text-[11px] font-semibold tracking-wide">
        {children}
      </Badge>
    );
  }

  const cssVar = STATUS_TONE_VAR[tone] || STATUS_TONE_VAR.info;
  return (
    <span
      className="case-stamp"
      style={{
        borderColor: `hsl(var(${cssVar}))`,
        color: `hsl(var(${cssVar}))`,
      }}
    >
      {children}
    </span>
  );
}

export function severityStatusTone(severity) {
  if (severity === "High") return "danger";
  if (severity === "Medium") return "warning";
  return "success";
}

export function riskScoreTone(score) {
  if (!Number.isFinite(score)) return "default";
  if (score >= 75) return "danger";
  if (score >= 50) return "warning";
  return "success";
}

const RISK_BAR_TONE = {
  danger: "bg-rose-500/80",
  warning: "bg-amber-500/80",
  success: "bg-emerald-500/80",
  default: "bg-primary/70",
};

export function RiskScoreBar({ score, className = "" }) {
  const clamped = Number.isFinite(score) ? Math.max(0, Math.min(100, score)) : 0;
  const tone = riskScoreTone(score);

  return (
    <div
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={clamped}
      aria-label="Risk score"
      className={`h-1.5 w-full overflow-hidden rounded-full bg-secondary ${className}`}
    >
      <div className={`h-full rounded-full transition-all ${RISK_BAR_TONE[tone]}`} style={{ width: `${clamped}%` }} />
    </div>
  );
}

export function claimStatusTone(status) {
  if (status === "CONFIRMED_FRAUD") return "danger";
  if (status === "UNDER_INVESTIGATION") return "warning";
  if (status === "DISMISSED") return "success";
  return "info";
}
