import React, { useMemo } from "react";
import { Link } from "react-router-dom";
import { AlertTriangle, ArrowUpRight, Building2, FileText, Gauge, Radar, ShieldAlert, ShieldCheck } from "lucide-react";
import { Skeleton } from "../../components/ui/skeleton";
import { PageFrame, SectionCard, StatCard, MetricPill, StatusIndicator, RiskScoreBar, severityStatusTone } from "./InvestigatorUI";

function metricTone(value) {
  if (typeof value !== "number") return "default";
  if (value >= 75) return "danger";
  if (value >= 50) return "warning";
  return "success";
}

const SEVERITY_SEGMENTS = [
  { key: "High", barClass: "bg-rose-500/80", dotClass: "bg-rose-500" },
  { key: "Medium", barClass: "bg-amber-500/80", dotClass: "bg-amber-500" },
  { key: "Low", barClass: "bg-emerald-500/80", dotClass: "bg-emerald-500" },
];

function SeverityBreakdown({ detections }) {
  const counts = useMemo(() => {
    const tally = { High: 0, Medium: 0, Low: 0 };
    for (const item of detections) {
      if (tally[item.severity] !== undefined) tally[item.severity] += 1;
      else tally.Low += 1;
    }
    return tally;
  }, [detections]);
  const total = detections.length;

  if (total === 0) {
    return <p className="rounded-xl border border-dashed border-border p-4 text-sm text-muted-foreground">No severity data available yet.</p>;
  }

  return (
    <div className="space-y-3">
      <div className="flex h-3 w-full overflow-hidden rounded-full bg-secondary" role="img" aria-label="Severity distribution of recent detections">
        {SEVERITY_SEGMENTS.map(({ key, barClass }) =>
          counts[key] > 0 ? (
            <div key={key} className={`h-full ${barClass}`} style={{ width: `${(counts[key] / total) * 100}%` }} />
          ) : null,
        )}
      </div>
      <div className="grid grid-cols-3 gap-2">
        {SEVERITY_SEGMENTS.map(({ key, dotClass }) => (
          <div key={key} className="rounded-xl border border-border/70 px-3 py-2">
            <div className="flex items-center gap-1.5">
              <span className={`h-2 w-2 rounded-full ${dotClass}`} aria-hidden="true" />
              <p className="text-xs uppercase tracking-[0.12em] text-muted-foreground">{key}</p>
            </div>
            <p className="font-data mt-1 text-lg font-semibold">{counts[key]}</p>
          </div>
        ))}
      </div>
    </div>
  );
}

export function DashboardPage({ metrics, status, lastRefresh }) {
  const totalClaims = metrics.totalClaims ?? 0;
  const highRiskClaims = Number.isFinite(metrics.highRiskClaims) ? metrics.highRiskClaims : 0;
  const averageRiskScore = Number.isFinite(metrics.averageRiskScore) ? metrics.averageRiskScore : 0;
  const confirmedFraud = metrics.recentDetections.filter((item) => item.status === "CONFIRMED_FRAUD").length;
  const openInvestigations = metrics.recentDetections.filter((item) => item.status === "UNDER_INVESTIGATION").length;
  const providersFlagged = metrics.recentDetections.length;
  const activeNetworks = Number.isFinite(metrics.activeFraudSchemes) ? metrics.activeFraudSchemes : 0;

  if (status === "loading") {
    return (
      <div className="space-y-5">
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        {Array.from({ length: 6 }).map((_, idx) => (
          <div key={idx} className="investigator-surface p-5">
            <Skeleton className="h-3 w-28" />
            <Skeleton className="mt-4 h-8 w-24" />
            <Skeleton className="mt-4 h-3 w-full" />
          </div>
        ))}
        </div>
        <div className="grid gap-4 xl:grid-cols-[2fr_1fr]">
          <div className="investigator-surface p-5">
            <Skeleton className="h-5 w-40" />
            <Skeleton className="mt-4 h-64 w-full" />
          </div>
          <div className="investigator-surface p-5">
            <Skeleton className="h-5 w-36" />
            <Skeleton className="mt-4 h-64 w-full" />
          </div>
        </div>
      </div>
    );
  }

  return (
    <PageFrame
      eyebrow="Dashboard"
      title="Fraud operations overview"
      description="A compact operational view of the current investigator snapshot, with the most important risk indicators surfaced first."
      actions={[
        <MetricPill key="ledger" label="Ledger" value={metrics.ledgerStatus} tone={metrics.ledgerStatus === "Connected" ? "success" : "warning"} />,
        <MetricPill key="refresh" label="Refreshed" value={lastRefresh ? new Date(lastRefresh).toLocaleTimeString() : "waiting"} />,
      ]}
    >
      <section className="grid gap-4 md:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-6">
        <StatCard title="Total Claims" value={totalClaims} description="Claims available in the current snapshot" icon={FileText} />
        <StatCard title="High Risk Claims" value={highRiskClaims} description="Claims above the operational risk threshold" icon={ShieldAlert} tone={metricTone(highRiskClaims)} />
        <StatCard title="Confirmed Fraud" value={confirmedFraud} description="Claims already confirmed by investigators" icon={ShieldCheck} tone="danger" />
        <StatCard title="Open Investigations" value={openInvestigations} description="Cases still in active review" icon={Gauge} tone="warning" />
        <StatCard title="Providers Flagged" value={providersFlagged} description="High-impact providers surfaced by the engine" icon={Building2} />
        <StatCard title="Active Networks" value={activeNetworks} description="Scheme clusters with meaningful fraud activity" icon={Radar} />
      </section>

      <section className="grid gap-4 xl:grid-cols-[2fr_1fr]">
        <SectionCard title="Recent Detections" description="The latest high-impact claims sorted by severity and score. Select a claim to open its full case file.">
          {metrics.recentDetections.length === 0 ? (
            <p className="rounded-xl border border-dashed border-border p-6 text-sm text-muted-foreground">No detections available yet.</p>
          ) : (
            <div className="space-y-3">
              {metrics.recentDetections.map((item) => (
                <Link
                  key={item.claimId}
                  to={`/claims/${encodeURIComponent(item.claimId)}`}
                  className="group block rounded-xl border border-border/70 bg-background/70 px-4 py-4 transition-colors hover:border-primary/50 hover:bg-secondary/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div className="space-y-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <p className="font-data text-sm font-semibold tracking-tight">{item.claimId}</p>
                        <StatusIndicator tone={severityStatusTone(item.severity)}>{item.severity}</StatusIndicator>
                        <ArrowUpRight className="h-3.5 w-3.5 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100" aria-hidden="true" />
                      </div>
                      <p className="text-sm text-muted-foreground">Policy holder: {item.policyHolder}</p>
                      <p className="text-xs text-muted-foreground">Triggered rules: {(item.triggeredRules || []).slice(0, 2).join(" · ") || "No rules"}</p>
                    </div>
                    <div className="w-24 text-right">
                      <p className="font-data text-2xl font-semibold tracking-tight">{item.riskScore}</p>
                      <p className="text-xs text-muted-foreground">Risk score</p>
                      <RiskScoreBar score={item.riskScore} className="mt-2" />
                    </div>
                  </div>
                </Link>
              ))}
            </div>
          )}
        </SectionCard>

        <SectionCard title="Investigation Summary" description="Compact snapshot of operational posture and workflow status.">
          <div className="space-y-4">
            <div className="rounded-2xl border border-border/70 bg-secondary/30 p-4">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <p className="text-xs font-semibold uppercase tracking-[0.18em] text-muted-foreground">Average risk score</p>
                  <p className="mt-1 text-3xl font-semibold tracking-tight">{averageRiskScore}</p>
                </div>
                <AlertTriangle className="h-6 w-6 text-primary" />
              </div>
              <RiskScoreBar score={averageRiskScore} className="mt-3" />
              <p className="mt-2 text-sm text-muted-foreground">Mean score across the currently indexed claims.</p>
            </div>

            <div>
              <p className="mb-2 text-xs font-semibold uppercase tracking-[0.18em] text-muted-foreground">Severity breakdown</p>
              <SeverityBreakdown detections={metrics.recentDetections} />
            </div>

            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-1">
              <div className="rounded-xl border border-border/70 px-4 py-3">
                <p className="text-xs uppercase tracking-[0.16em] text-muted-foreground">High-risk claim rate</p>
                <p className="mt-1 text-lg font-semibold">{totalClaims ? `${Math.round((highRiskClaims / totalClaims) * 100)}%` : "0%"}</p>
              </div>
              <div className="rounded-xl border border-border/70 px-4 py-3">
                <p className="text-xs uppercase tracking-[0.16em] text-muted-foreground">Recent activity</p>
                <p className="mt-1 text-lg font-semibold">{metrics.recentDetections.length} claims surfaced</p>
              </div>
              <div className="rounded-xl border border-border/70 px-4 py-3">
                <p className="text-xs uppercase tracking-[0.16em] text-muted-foreground">Ledger link</p>
                <p className="mt-1 text-lg font-semibold">{metrics.ledgerStatus}</p>
              </div>
              <div className="rounded-xl border border-border/70 px-4 py-3">
                <p className="text-xs uppercase tracking-[0.16em] text-muted-foreground">Refresh status</p>
                <p className="mt-1 text-lg font-semibold">{lastRefresh ? "Current" : "Waiting"}</p>
              </div>
            </div>
          </div>
        </SectionCard>
      </section>
    </PageFrame>
  );
}
