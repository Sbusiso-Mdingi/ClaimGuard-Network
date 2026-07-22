import React, { useMemo } from "react";
import { Link } from "react-router-dom";
import AlertTriangle from "lucide-react/dist/esm/icons/alert-triangle.mjs";
import FileText from "lucide-react/dist/esm/icons/file-text.mjs";
import Radar from "lucide-react/dist/esm/icons/radar.mjs";
import ShieldAlert from "lucide-react/dist/esm/icons/shield-alert.mjs";
import ArrowUpRight from "lucide-react/dist/esm/icons/arrow-up-right.mjs";
import { Skeleton } from "../../components/ui/skeleton";
import { PageFrame, SectionCard, StatCard, MetricPill, StatusIndicator, riskScoreTone, claimStatusTone } from "./InvestigatorUI";
import { NetworkGraph } from "./NetworkGraph";

function formatStatus(status) {
  if (!status) return "Unknown";
  if (status === "UNDER_INVESTIGATION") return "Under investigation";
  if (status === "CONFIRMED_FRAUD") return "Confirmed fraud";
  if (status === "DISMISSED") return "Dismissed";
  if (status === "SUBMITTED") return "Submitted";
  // Convert snake_case to Title case for any unexpected enums
  return status.split("_").map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(" ");
}

export function DashboardPage({ metrics, graph, status, lastRefresh }) {
  const totalClaims = Number.isFinite(metrics.totalClaims) ? metrics.totalClaims : "Unavailable";
  const highRiskClaims = Number.isFinite(metrics.highRiskClaims) ? metrics.highRiskClaims : "Unavailable";
  const averageRiskScore = Number.isFinite(metrics.averageRiskScore) ? metrics.averageRiskScore : "Unavailable";
  const activeNetworks = Number.isFinite(metrics.activeFraudSchemes) ? metrics.activeFraudSchemes : "Unavailable";

  if (status === "loading") {
    return (
      <div className="space-y-5">
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        {Array.from({ length: 4 }).map((_, idx) => (
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
    <div className="space-y-6">
      <header className="flex flex-col gap-4 border-b border-border-soft pb-5 lg:flex-row lg:items-end lg:justify-between">
        <div className="space-y-1.5">
          <p className="font-data text-[11px] font-semibold uppercase tracking-[0.2em] text-primary/80">Investigator Dashboard</p>
          <h1 className="font-display text-[28px] font-semibold tracking-[-0.02em] text-foreground">Claims risk intelligence</h1>
          <p className="max-w-2xl text-xs leading-6 text-muted-2">
            Real-time fraud detection and operational monitoring across the scheme partition.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <MetricPill variant="console" key="ledger" label="Ledger" value={metrics.ledgerStatus} tone={metrics.ledgerStatus === "Connected" ? "success" : "warning"} />
          <MetricPill variant="console" key="refresh" label="Refreshed" value={lastRefresh ? new Date(lastRefresh).toLocaleTimeString() : "waiting"} />
        </div>
      </header>

      <section className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard variant="console" title="Claims Screened" value={totalClaims} description="Total volume in current snapshot" icon={FileText} />
        <StatCard variant="console" title="Priority Alerts" value={highRiskClaims} description="Claims exceeding risk threshold" icon={ShieldAlert} tone="danger" />
        <StatCard variant="console" title="Avg Risk Score" value={averageRiskScore} description="Mean engine confidence" icon={AlertTriangle} tone={riskScoreTone(averageRiskScore)} />
        <StatCard variant="console" title="Active Networks" value={activeNetworks} description="Suspicious clusters identified" icon={Radar} />
      </section>

      <section className="grid gap-5 xl:grid-cols-[1fr_400px]">
        <SectionCard variant="console" title="Priority claims queue" description="The most critical items flagged by the detection engine, sorted by descending risk severity.">
          {metrics.recentDetections.length === 0 ? (
            <div className="p-8 text-center">
              <p className="text-sm text-muted">No priority claims available.</p>
            </div>
          ) : (
            <div className="overflow-x-auto investigator-scrollbar">
              <table className="investigator-table w-full whitespace-nowrap">
                <thead>
                  <tr>
                    <th className="font-sans text-[10px] text-muted-2 px-[18px] py-3 tracking-widest border-b border-border-soft">Reference</th>
                    <th className="font-sans text-[10px] text-muted-2 px-[18px] py-3 tracking-widest border-b border-border-soft">Member ID</th>
                    <th className="font-sans text-[10px] text-muted-2 px-[18px] py-3 tracking-widest border-b border-border-soft">Provider ID</th>
                    <th className="font-sans text-[10px] text-muted-2 px-[18px] py-3 tracking-widest border-b border-border-soft">Risk / Sev</th>
                    <th className="font-sans text-[10px] text-muted-2 px-[18px] py-3 tracking-widest border-b border-border-soft">Investigation Status</th>
                    <th className="font-sans text-[10px] text-muted-2 px-[18px] py-3 tracking-widest border-b border-border-soft">Updated</th>
                    <th className="w-[40px] px-2 py-3 border-b border-border-soft"></th>
                  </tr>
                </thead>
                <tbody>
                  {metrics.recentDetections.map((item) => (
                    <tr key={item.claimId} className="group hover:bg-white/[0.02] transition-colors border-b border-border-soft/50 last:border-0">
                      <td className="px-[18px] py-[14px]">
                        <Link to={`/claims/${encodeURIComponent(item.claimId)}`} className="text-primary hover:underline font-semibold text-[13px]">{item.claimId}</Link>
                      </td>
                      <td className="px-[18px] py-[14px] text-[13px] text-foreground">{item.memberId || "Unknown"}</td>
                      <td className="px-[18px] py-[14px] text-[13px] text-foreground">{item.providerId || "Unknown"}</td>
                      <td className="px-[18px] py-[14px]">
                        <div className="flex items-center gap-2">
                          <span className={`font-semibold text-[13px] ${item.riskScore >= 75 ? "text-[#ee716b]" : item.riskScore >= 40 ? "text-[#e6a74d]" : "text-[#62ce9b]"}`}>{item.riskScore}</span>
                          <span className="text-[11px] text-muted-2 uppercase tracking-wider">{item.severity}</span>
                        </div>
                      </td>
                      <td className="px-[18px] py-[14px]">
                        <StatusIndicator variant="badge" tone={claimStatusTone(item.status)}>{formatStatus(item.status)}</StatusIndicator>
                      </td>
                      <td className="px-[18px] py-[14px] text-[12px] text-muted-2">
                        {item.detectionDate ? new Date(item.detectionDate).toLocaleDateString() : "—"}
                      </td>
                      <td className="px-[18px] py-[14px] text-right">
                        <Link to={`/claims/${encodeURIComponent(item.claimId)}`} className="inline-flex items-center justify-center w-8 h-8 rounded-full bg-white/5 text-muted hover:bg-primary/20 hover:text-primary transition-colors focus:outline-none focus:ring-2 focus:ring-primary" aria-label={`View claim ${item.claimId}`}>
                          <ArrowUpRight className="w-4 h-4" />
                        </Link>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </SectionCard>

        <SectionCard variant="console" title="Suspicious relationship network" description="Live graph of linked entities and known collusive structures.">
          <div className="p-3">
             <NetworkGraph 
                graph={graph} 
                height="360px"
                compact={true}
                showControls={false}
                showMiniMap={false}
              />
              <div className="mt-4 px-2">
                 <Link to="/network" className="text-[11px] font-semibold uppercase tracking-[0.15em] text-primary hover:underline flex items-center gap-1.5 w-fit">
                    Open network intelligence <ArrowUpRight className="w-3.5 h-3.5" />
                 </Link>
              </div>
          </div>
        </SectionCard>
      </section>
    </div>
  );
}
