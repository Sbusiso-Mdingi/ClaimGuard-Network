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

export function SectionCard({ title, description, actions, children, className = "", variant = "default" }) {
  const isConsole = variant === "console";
  return (
    <Card className={`${isConsole ? "rounded-[14px] border border-border-soft bg-gradient-to-br from-[#151c24] to-[#11171e] shadow-xl shadow-black/20" : "rounded-xl border border-border/70 bg-card shadow-none"} ${className}`}>
      <CardHeader className={`${isConsole ? "px-[18px] py-[15px] border-b border-border-soft" : "space-y-2 pb-4"}`}>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="space-y-1">
            <CardTitle className={isConsole ? "font-display text-[18px] font-semibold m-0" : "font-display text-base font-semibold tracking-tight"}>{title}</CardTitle>
            {description ? <CardDescription className={isConsole ? "text-[11px] leading-[1.55] text-muted mt-1.5 max-w-3xl" : "max-w-3xl text-sm leading-6"}>{description}</CardDescription> : null}
          </div>
          {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
        </div>
      </CardHeader>
      <CardContent className={isConsole ? "p-0" : "pt-0"}>{children}</CardContent>
    </Card>
  );
}

export function StatCard({ title, value, description, icon: Icon, tone = "default", variant = "default" }) {
  const isConsole = variant === "console";

  const toneStyles = {
    success: {
      border: isConsole ? "border-emerald-500/20" : "border-emerald-500/40",
      accent: "bg-emerald-500/70",
      chip: isConsole ? "bg-emerald-500/10 text-[#62ce9b] border border-border-soft" : "bg-emerald-500/10 text-emerald-600 dark:text-emerald-300",
      value: isConsole ? "text-[#62ce9b]" : "",
    },
    warning: {
      border: isConsole ? "border-amber-500/20" : "border-amber-500/40",
      accent: "bg-amber-500/70",
      chip: isConsole ? "bg-amber-500/10 text-[#e6a74d] border border-border-soft" : "bg-amber-500/10 text-amber-600 dark:text-amber-300",
      value: isConsole ? "text-[#e6a74d]" : "",
    },
    danger: {
      border: isConsole ? "border-rose-500/20" : "border-rose-500/40",
      accent: "bg-rose-500/70",
      chip: isConsole ? "bg-rose-500/10 text-[#ee716b] border border-border-soft" : "bg-rose-500/10 text-rose-600 dark:text-rose-300",
      value: isConsole ? "text-[#ee716b]" : "",
    },
    default: {
      border: isConsole ? "border-border-soft" : "border-border/80",
      accent: "bg-primary/50",
      chip: isConsole ? "bg-white/5 text-muted border border-border-soft" : "bg-primary/10 text-primary",
      value: "",
    },
  };
  const styles = toneStyles[tone] || toneStyles.default;

  if (isConsole) {
    return (
      <Card className={`relative overflow-hidden rounded-[14px] bg-gradient-to-br from-[#151c24] to-[#11171e] shadow-xl shadow-black/20 border ${styles.border} min-h-[116px] p-[17px]`}>
        <div className="flex items-center justify-between gap-3">
          <span className="text-[11px] text-muted">{title}</span>
          {Icon ? (
            <span className={`flex h-[27px] w-[27px] items-center justify-center rounded-lg font-data text-[11px] ${styles.chip}`}>
              <Icon className="h-3.5 w-3.5" />
            </span>
          ) : null}
        </div>
        <div className={`mt-[15px] text-[27px] font-semibold tracking-[-0.035em] ${styles.value}`}>{value}</div>
        {description && <div className="mt-1.5 text-[10px] text-muted">{description}</div>}
      </Card>
    );
  }

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

export function MetricPill({ label, value, tone = "default", variant = "default" }) {
  const isConsole = variant === "console";
  
  const toneClasses = isConsole ? (
    tone === "success" ? "border-[#62ce9b]/30 bg-[#62ce9b]/10 text-[#8fd5b3]" :
    tone === "warning" ? "border-primary/35 bg-primary/10 text-[#efbf78]" :
    tone === "danger" ? "border-[#ee716b]/30 bg-[#ee716b]/10 text-[#ff9a94]" :
    "border-border bg-black/25 text-[#c6ccd3]"
  ) : (
    tone === "success" ? "border-emerald-500/20 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300" :
    tone === "warning" ? "border-amber-500/20 bg-amber-500/10 text-amber-700 dark:text-amber-300" :
    tone === "danger" ? "border-rose-500/20 bg-rose-500/10 text-rose-700 dark:text-rose-300" :
    "border-border bg-secondary text-foreground"
  );

  return (
    <div className={`inline-flex items-center gap-2 rounded-full border ${isConsole ? "min-h-[28px] px-2.5 py-1.5 text-[9px] font-semibold" : "px-3 py-1 text-xs font-medium"} ${toneClasses}`}>
      {label && <span className={isConsole ? "uppercase tracking-[0.11em] font-data opacity-80" : "uppercase tracking-[0.18em] text-[10px] opacity-70"}>{label}</span>}
      <span className={isConsole ? "font-sans font-semibold" : "font-data"}>{value}</span>
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
    // Console style badge
    const badgeTone = 
      tone === "danger" ? "text-[#ff9a94] border-[#ee716b]/30 bg-[#ee716b]/10" :
      tone === "warning" ? "text-[#efba69] border-primary/30 bg-primary/10" :
      tone === "success" ? "text-[#8fd5b3] border-[#62ce9b]/30 bg-[#62ce9b]/10" :
      "text-[#9eb7ca] border-[#71a8d9]/25 bg-[#71a8d9]/10";
      
    return (
      <span className={`inline-flex items-center gap-[5px] px-2 py-1.5 border rounded-full text-[9px] font-semibold whitespace-nowrap ${badgeTone}`}>
        {children}
      </span>
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
