import React from "react";
import { AlertTriangle, Building2, FileText, Gauge, Radar, ShieldAlert, ShieldCheck } from "lucide-react";
import { Skeleton } from "../../components/ui/skeleton";
import { PageFrame, SectionCard, StatCard, MetricPill, StatusIndicator, severityStatusTone } from "./InvestigatorUI";

function metricTone(value) {
  if (typeof value !== "number") return "default";
  if (value >= 75) return "danger";
  if (value >= 50) return "warning";
  return "success";
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
        <SectionCard title="Recent Detections" description="The latest high-impact claims sorted by severity and score.">
          {metrics.recentDetections.length === 0 ? (
            <p className="rounded-xl border border-dashed border-border p-6 text-sm text-muted-foreground">No detections available yet.</p>
          ) : (
            <div className="space-y-3">
              {metrics.recentDetections.map((item) => (
                <div key={item.claimId} className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border/70 bg-background/70 px-4 py-4 transition-colors hover:bg-secondary/40">
                  <div className="space-y-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="font-data text-sm font-semibold tracking-tight">{item.claimId}</p>
                      <StatusIndicator tone={severityStatusTone(item.severity)}>{item.severity}</StatusIndicator>
                    </div>
                    <p className="text-sm text-muted-foreground">Policy holder: {item.policyHolder}</p>
                    <p className="text-xs text-muted-foreground">Triggered rules: {(item.triggeredRules || []).slice(0, 2).join(" · ") || "No rules"}</p>
                  </div>
                  <div className="text-right">
                    <p className="font-data text-2xl font-semibold tracking-tight">{item.riskScore}</p>
                    <p className="text-xs text-muted-foreground">Risk score</p>
                  </div>
                </div>
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
              <p className="mt-2 text-sm text-muted-foreground">Mean score across the currently indexed claims.</p>
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
