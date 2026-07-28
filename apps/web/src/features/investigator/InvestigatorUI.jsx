import React from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../../components/ui/card";

export function formatEnumLabel(value, fallback = "Unknown") {
  const normalized = String(value || "").trim();
  if (!normalized) return fallback;
  return normalized
    .toLowerCase()
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

export function PageFrame({ eyebrow, title, description, actions, children }) {
  return (
    <div className="space-y-6">
      <header className="flex flex-col gap-4 border-b border-border/70 pb-5 lg:flex-row lg:items-center lg:justify-between">
        <div className="min-w-0 space-y-1.5">
          {eyebrow ? <p className="font-data text-xs font-semibold uppercase tracking-[0.22em] text-muted-foreground">{eyebrow}</p> : null}
          <h1 className="font-display text-[1.85rem] font-semibold leading-tight tracking-tight text-foreground lg:text-[2.15rem]">{title}</h1>
          {description ? <p className="max-w-3xl text-sm leading-6 text-muted-foreground">{description}</p> : null}
        </div>
        {actions ? <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div> : null}
      </header>
      {children}
    </div>
  );
}

export function SectionCard({
  title,
  description,
  actions,
  children,
  className = "",
  contentClassName = "",
  variant = "default",
}) {
  const isConsole = variant === "console";
  return (
    <Card className={`${isConsole ? "rounded-xl border border-border/80 bg-card shadow-sm" : "rounded-xl border border-border/70 bg-card shadow-none"} ${className}`}>
      <CardHeader className={`${isConsole ? "border-b border-border/70 px-5 py-4" : "space-y-2 pb-4"}`}>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0 space-y-1">
            <CardTitle className={isConsole ? "font-display text-lg font-semibold" : "font-display text-base font-semibold tracking-tight"}>{title}</CardTitle>
            {description ? <CardDescription className="max-w-3xl text-sm leading-6">{description}</CardDescription> : null}
          </div>
          {actions ? <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div> : null}
        </div>
      </CardHeader>
      <CardContent className={`${isConsole ? "p-0" : "pt-0"} ${contentClassName}`}>{children}</CardContent>
    </Card>
  );
}

export function StatCard({ title, value, description, icon: Icon, tone = "default", variant = "default" }) {
  const isConsole = variant === "console";
  const toneStyles = {
    success: {
      border: "border-emerald-500/30",
      accent: "bg-emerald-500/70",
      chip: "border border-emerald-500/20 bg-emerald-500/10 text-emerald-600 dark:text-emerald-300",
      value: "text-emerald-600 dark:text-emerald-300",
    },
    warning: {
      border: "border-amber-500/30",
      accent: "bg-amber-500/70",
      chip: "border border-amber-500/20 bg-amber-500/10 text-amber-600 dark:text-amber-300",
      value: "text-amber-600 dark:text-amber-300",
    },
    danger: {
      border: "border-rose-500/30",
      accent: "bg-rose-500/70",
      chip: "border border-rose-500/20 bg-rose-500/10 text-rose-600 dark:text-rose-300",
      value: "text-rose-600 dark:text-rose-300",
    },
    default: {
      border: "border-border/80",
      accent: "bg-primary/50",
      chip: "border border-border bg-secondary text-muted-foreground",
      value: "text-foreground",
    },
  };
  const styles = toneStyles[tone] || toneStyles.default;

  if (isConsole) {
    return (
      <Card className={`relative min-h-[116px] overflow-hidden rounded-xl border bg-card p-4 shadow-sm ${styles.border}`}>
        <div className="flex items-center justify-between gap-3">
          <span className="text-xs font-medium text-muted-foreground">{title}</span>
          {Icon ? <span className={`flex h-8 w-8 items-center justify-center rounded-lg ${styles.chip}`}><Icon className="h-4 w-4" /></span> : null}
        </div>
        <div className={`mt-4 font-data text-3xl font-semibold tracking-tight ${styles.value}`}>{value}</div>
        {description ? <div className="mt-2 text-xs leading-5 text-muted-foreground">{description}</div> : null}
      </Card>
    );
  }

  return (
    <Card className={`relative overflow-hidden rounded-xl bg-card shadow-none ${styles.border}`}>
      <span className={`absolute inset-x-0 top-0 h-0.5 ${styles.accent}`} aria-hidden="true" />
      <CardHeader className="space-y-3 pb-3">
        <div className="flex items-center justify-between gap-3">
          <p className="text-xs font-medium uppercase tracking-[0.18em] text-muted-foreground">{title}</p>
          {Icon ? <span className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ${styles.chip}`}><Icon className="h-4 w-4" /></span> : null}
        </div>
        <CardTitle className={`font-data text-3xl font-semibold leading-none tracking-tight ${styles.value}`}>{value}</CardTitle>
      </CardHeader>
      <CardContent className="pt-0">
        <p className="text-sm leading-6 text-muted-foreground">{description}</p>
      </CardContent>
    </Card>
  );
}

export function SummaryRail({ items = [], ariaLabel = "Workspace summary" }) {
  const columnClass = items.length >= 4
    ? "xl:grid-cols-4"
    : items.length === 3
      ? "xl:grid-cols-3"
      : items.length === 2
        ? "xl:grid-cols-2"
        : "xl:grid-cols-1";
  return (
    <section
      aria-label={ariaLabel}
      className={`grid overflow-hidden rounded-xl border border-border/80 bg-card shadow-sm ${columnClass}`}
    >
      {items.map((item, index) => {
        const Icon = item.icon;
        return (
          <div
            key={item.key || item.label}
            className={[
              "flex min-w-0 items-center gap-3 px-4 py-3.5",
              index > 0 ? "border-t border-border/70 xl:border-l xl:border-t-0" : "",
            ].join(" ")}
          >
            {Icon ? (
              <span className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-border bg-background/60 ${item.iconClassName || "text-primary"}`}>
                <Icon className="h-4 w-4" aria-hidden="true" />
              </span>
            ) : null}
            <div className="min-w-0">
              <p className="text-[11px] font-medium text-muted-foreground">{item.label}</p>
              <p className="font-data mt-0.5 text-xl font-semibold leading-none text-foreground">{item.value}</p>
              {item.description ? <p className="mt-1 truncate text-[11px] text-muted-foreground">{item.description}</p> : null}
            </div>
          </div>
        );
      })}
    </section>
  );
}

export function MetricPill({ label, value, tone = "default", variant = "default" }) {
  const toneClasses =
    tone === "success" ? "border-emerald-500/20 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300" :
    tone === "warning" ? "border-amber-500/20 bg-amber-500/10 text-amber-700 dark:text-amber-300" :
    tone === "danger" ? "border-rose-500/20 bg-rose-500/10 text-rose-700 dark:text-rose-300" :
    "border-border bg-secondary text-foreground";
  const compact = variant === "console";

  return (
    <div className={`inline-flex items-center gap-2 rounded-full border font-medium ${compact ? "min-h-7 px-2.5 py-1 text-[10px]" : "px-3 py-1 text-xs"} ${toneClasses}`}>
      {label ? <span className="font-data text-[10px] uppercase tracking-[0.14em] opacity-70">{label}</span> : null}
      <span>{value}</span>
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
    const badgeTone =
      tone === "danger" ? "border-rose-500/25 bg-rose-500/10 text-rose-700 dark:text-rose-300" :
      tone === "warning" ? "border-amber-500/25 bg-amber-500/10 text-amber-700 dark:text-amber-300" :
      tone === "success" ? "border-emerald-500/25 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300" :
      "border-sky-500/20 bg-sky-500/10 text-sky-700 dark:text-sky-300";

    return <span className={`inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-[10px] font-semibold whitespace-nowrap ${badgeTone}`}>{children}</span>;
  }

  const cssVar = STATUS_TONE_VAR[tone] || STATUS_TONE_VAR.info;
  return (
    <span className="case-stamp" style={{ borderColor: `hsl(var(${cssVar}))`, color: `hsl(var(${cssVar}))` }}>
      {children}
    </span>
  );
}

export function WorkspaceNotice({ title, children, tone = "info", actions }) {
  const toneClasses =
    tone === "danger" ? "border-rose-500/30 bg-rose-500/10" :
    tone === "warning" ? "border-amber-500/30 bg-amber-500/10" :
    tone === "success" ? "border-emerald-500/30 bg-emerald-500/10" :
    "border-border bg-secondary/50";

  return (
    <div role={tone === "danger" ? "alert" : "status"} className={`flex flex-col gap-3 rounded-xl border p-4 sm:flex-row sm:items-start sm:justify-between ${toneClasses}`}>
      <div className="min-w-0">
        <p className="text-sm font-semibold text-foreground">{title}</p>
        {children ? <div className="mt-1 text-sm leading-6 text-muted-foreground">{children}</div> : null}
      </div>
      {actions ? <div className="flex shrink-0 flex-wrap gap-2">{actions}</div> : null}
    </div>
  );
}

export function EmptyState({ title, description, icon: Icon, actions, compact = false }) {
  return (
    <div className={`flex flex-col items-center justify-center text-center ${compact ? "px-4 py-6" : "px-6 py-10"}`}>
      {Icon ? <span className="mb-3 flex h-10 w-10 items-center justify-center rounded-full border border-border bg-secondary text-muted-foreground"><Icon className="h-5 w-5" /></span> : null}
      <p className="text-sm font-semibold text-foreground">{title}</p>
      {description ? <p className="mt-1 max-w-lg text-sm leading-6 text-muted-foreground">{description}</p> : null}
      {actions ? <div className="mt-4 flex flex-wrap justify-center gap-2">{actions}</div> : null}
    </div>
  );
}

export function DefinitionList({ items = [], columns = 2, className = "" }) {
  const columnClass = columns === 1 ? "grid-cols-1" : columns === 3 ? "md:grid-cols-3" : "md:grid-cols-2";
  return (
    <dl className={`grid gap-3 ${columnClass} ${className}`}>
      {items.map((item) => (
        <div key={item.key || item.label} className="min-w-0 rounded-xl border border-border/70 bg-background/40 px-4 py-3">
          <dt className="text-xs font-medium uppercase tracking-[0.14em] text-muted-foreground">{item.label}</dt>
          <dd className={`mt-1 break-words text-sm font-semibold text-foreground ${item.mono ? "font-data" : ""}`}>{item.value ?? "Not available"}</dd>
          {item.description ? <p className="mt-1 text-xs leading-5 text-muted-foreground">{item.description}</p> : null}
        </div>
      ))}
    </dl>
  );
}

export function FormField({ label, htmlFor, hint, error, children }) {
  const generatedId = React.useId().replace(/:/g, "");
  const controlId = htmlFor || children?.props?.id || `field-${generatedId}`;
  const descriptionId = (error || hint) ? `${controlId}-description` : undefined;
  const control = React.isValidElement(children)
    ? React.cloneElement(children, {
        id: children.props.id || controlId,
        "aria-describedby": [
          children.props["aria-describedby"],
          descriptionId,
        ].filter(Boolean).join(" ") || undefined,
        "aria-invalid": error ? true : children.props["aria-invalid"],
      })
    : children;

  return (
    <div className="grid gap-2 text-sm font-medium text-foreground">
      <label htmlFor={controlId}>{label}</label>
      {control}
      {error ? <span id={descriptionId} className="text-xs font-normal text-destructive">{error}</span> : hint ? <span id={descriptionId} className="text-xs font-normal leading-5 text-muted-foreground">{hint}</span> : null}
    </div>
  );
}

export function DataTableShell({ ariaLabel, children, minWidth = "760px" }) {
  return (
    <div className="overflow-x-auto investigator-scrollbar">
      <table aria-label={ariaLabel} className="investigator-table w-full" style={{ minWidth }}>
        {children}
      </table>
    </div>
  );
}

export function TableLoadingRows({ columns, rows = 5 }) {
  return Array.from({ length: rows }, (_, rowIndex) => (
    <tr key={`loading-row-${rowIndex}`} aria-hidden="true">
      {Array.from({ length: columns }, (_unused, columnIndex) => (
        <td key={`loading-cell-${rowIndex}-${columnIndex}`}>
          <span
            className="block h-3 animate-pulse rounded bg-secondary"
            style={{ width: `${Math.max(38, 82 - columnIndex * 5)}%` }}
          />
        </td>
      ))}
    </tr>
  ));
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
    <div role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={clamped} aria-label="Risk score" className={`h-1.5 w-full overflow-hidden rounded-full bg-secondary ${className}`}>
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
