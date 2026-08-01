import React from "react";
import { Link } from "react-router-dom";
import AlertTriangle from "lucide-react/dist/esm/icons/alert-triangle.mjs";
import ArrowUpRight from "lucide-react/dist/esm/icons/arrow-up-right.mjs";
import FileText from "lucide-react/dist/esm/icons/file-text.mjs";
import Inbox from "lucide-react/dist/esm/icons/inbox.mjs";
import ListChecks from "lucide-react/dist/esm/icons/list-checks.mjs";
import Radar from "lucide-react/dist/esm/icons/radar.mjs";
import SearchCheck from "lucide-react/dist/esm/icons/search-check.mjs";
import Settings from "lucide-react/dist/esm/icons/settings.mjs";
import ShieldAlert from "lucide-react/dist/esm/icons/shield-alert.mjs";
import { Skeleton } from "../../components/ui/skeleton";
import { useRole } from "../../context/RoleContext";
import {
  formatIdentityRoles,
  hasCapability,
} from "../../lib/capabilities";
import {
  DataTableShell,
  EmptyState,
  MetricPill,
  PageFrame,
  RiskScoreBar,
  SectionCard,
  StatCard,
  StatusIndicator,
  claimStatusTone,
  formatEnumLabel,
  riskScoreTone,
} from "./InvestigatorUI";
import { NetworkGraph } from "./NetworkGraph";

function DashboardSkeleton() {
  return (
    <div className="space-y-6">
      <div className="space-y-2 border-b border-border pb-5">
        <Skeleton className="h-3 w-36" />
        <Skeleton className="h-8 w-72" />
        <Skeleton className="h-4 w-full max-w-xl" />
      </div>
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {Array.from({ length: 4 }).map((_, index) => (
          <div key={index} className="rounded-lg border border-border bg-card p-4">
            <Skeleton className="h-3 w-28" />
            <Skeleton className="mt-4 h-8 w-24" />
            <Skeleton className="mt-3 h-3 w-full" />
          </div>
        ))}
      </div>
      <div className="grid gap-4 xl:grid-cols-3">
        <div className="rounded-lg border border-border bg-card p-5 xl:col-span-2"><Skeleton className="h-72 w-full" /></div>
        <div className="rounded-lg border border-border bg-card p-5"><Skeleton className="h-72 w-full" /></div>
      </div>
    </div>
  );
}

function percentage(part, whole) {
  if (!Number.isFinite(part) || !Number.isFinite(whole) || whole <= 0) return null;
  return Math.max(0, Math.min(100, Math.round((part / whole) * 100)));
}

export function DashboardPage({ metrics, graph, status, lastRefresh }) {
  const { identity } = useRole();

  if (status === "loading") return <DashboardSkeleton />;

  const recentDetections = Array.isArray(metrics?.recentDetections) ? metrics.recentDetections : [];
  const totalClaimsValue = Number.isFinite(metrics?.totalClaims) ? metrics.totalClaims : null;
  const highRiskClaimsValue = Number.isFinite(metrics?.highRiskClaims) ? metrics.highRiskClaims : null;
  const averageRiskScoreValue = Number.isFinite(metrics?.averageRiskScore) ? metrics.averageRiskScore : null;
  const activeNetworksValue = Number.isFinite(metrics?.activeFraudSchemes) ? metrics.activeFraudSchemes : null;
  const highRiskRate = percentage(highRiskClaimsValue, totalClaimsValue);
  const totalClaims = totalClaimsValue ?? "Unavailable";
  const highRiskClaims = highRiskClaimsValue ?? "Unavailable";
  const averageRiskScore = averageRiskScoreValue ?? "Unavailable";
  const activeNetworks = activeNetworksValue ?? "Unavailable";

  const roleTasks = [
    hasCapability(identity, "claims.view_own") ? {
      label: "Review scheme claims",
      description: "Search claims, inspect persisted scores, and open claim evidence.",
      to: "/claims",
      icon: FileText,
    } : null,
    hasCapability(identity, "investigations.view") ? {
      label: "Work investigations",
      description: "Prioritise tenant cases and continue authorised investigation actions.",
      to: "/investigations",
      icon: ListChecks,
    } : null,
    hasCapability(identity, "fraud_registry.search") ? {
      label: "Search shared registry",
      description: "Check authorised member or provider tokens against confirmed records.",
      to: "/committee",
      icon: SearchCheck,
    } : null,
    hasCapability(identity, "users.manage_tenant") ? {
      label: "Manage scheme",
      description: "Review processing health, model policy, users, and tenant settings.",
      to: "/admin/scheme",
      icon: Settings,
    } : null,
  ].filter(Boolean);

  return (
    <PageFrame
      eyebrow="Scheme overview"
      title="Executive dashboard"
      description="Current fraud, waste and abuse posture across screened claims, priority alerts and suspicious relationship networks."
      actions={[
        <MetricPill key="ledger" label="Ledger" value={metrics?.ledgerStatus || "Unknown"} tone={metrics?.ledgerStatus === "Connected" ? "success" : "warning"} />,
        <MetricPill key="refresh" label="Updated" value={lastRefresh ? new Date(lastRefresh).toLocaleTimeString("en-ZA", { hour: "2-digit", minute: "2-digit" }) : "Waiting"} />,
      ]}
    >
      <section aria-label="Key indicators" className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard variant="console" title="Claims screened" value={totalClaims} description="Claims represented by the current operational snapshot." icon={FileText} />
        <StatCard variant="console" title="Priority alerts" value={highRiskClaims} description={highRiskRate === null ? "Claims above the high-risk threshold." : `${highRiskRate}% of screened claims are currently high risk.`} icon={ShieldAlert} tone="danger" />
        <StatCard variant="console" title="Average risk score" value={averageRiskScore} description="Mean persisted detection score across available claims." icon={AlertTriangle} tone={riskScoreTone(averageRiskScoreValue)} />
        <StatCard variant="console" title="Active networks" value={activeNetworks} description="Suspicious linked-entity clusters in the graph projection." icon={Radar} />
      </section>

      <section className="grid gap-4 xl:grid-cols-3">
        <SectionCard
          variant="console"
          className="xl:col-span-2"
          title="Priority queue"
          description="Highest-risk unresolved claims requiring investigator attention."
          actions={<Link to="/claims" className="inline-flex items-center gap-1 text-xs font-semibold text-primary hover:underline">Open explorer <ArrowUpRight className="h-3.5 w-3.5" /></Link>}
        >
          {recentDetections.length === 0 ? (
            <EmptyState
              compact
              icon={Inbox}
              title="No priority claims"
              description="No scored claims currently meet the priority threshold."
            />
          ) : (
            <DataTableShell ariaLabel="Priority claims queue" minWidth="820px">
              <thead>
                <tr>
                  <th>Reference</th>
                  <th>Member</th>
                  <th>Provider</th>
                  <th>Risk</th>
                  <th>Status</th>
                  <th>Updated</th>
                  <th><span className="sr-only">Open claim</span></th>
                </tr>
              </thead>
              <tbody>
                {recentDetections.slice(0, 6).map((item) => (
                  <tr key={item.claimId}>
                    <td><Link to={`/claims/${encodeURIComponent(item.claimId)}`} className="font-semibold text-primary hover:underline">{item.claimId}</Link></td>
                    <td>{item.memberId || "Unknown"}</td>
                    <td>{item.providerId || "Unknown"}</td>
                    <td>
                      {Number.isFinite(item.riskScore) ? (
                        <div className="min-w-[110px] space-y-1.5">
                          <div className="flex items-center justify-between gap-2">
                            <span className="font-data font-semibold">{item.riskScore}</span>
                            <span className="text-[10px] text-muted-foreground">{item.severity || "Unknown"}</span>
                          </div>
                          <RiskScoreBar score={item.riskScore} />
                        </div>
                      ) : "—"}
                    </td>
                    <td><StatusIndicator variant="badge" tone={claimStatusTone(item.status)}>{formatEnumLabel(item.status)}</StatusIndicator></td>
                    <td className="text-muted-foreground">{item.detectionDate ? new Date(item.detectionDate).toLocaleDateString("en-ZA") : "Not available"}</td>
                    <td className="text-right">
                      <Link
                        to={`/claims/${encodeURIComponent(item.claimId)}`}
                        className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-border bg-background text-muted-foreground transition-colors hover:border-primary/40 hover:text-primary"
                        aria-label={`View claim ${item.claimId}`}
                      >
                        <ArrowUpRight className="h-4 w-4" />
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </DataTableShell>
          )}
        </SectionCard>

        <SectionCard
          variant="console"
          title="Risk posture"
          description="A compact view of the current detection workload."
        >
          <div className="space-y-5 p-4">
            <div>
              <div className="flex items-center justify-between gap-3 text-xs">
                <span className="font-medium text-muted-foreground">High-risk share</span>
                <span className="font-data font-semibold">{highRiskRate === null ? "Unavailable" : `${highRiskRate}%`}</span>
              </div>
              <div className="mt-2 h-2 overflow-hidden rounded-full bg-secondary">
                <div className="h-full rounded-full bg-rose-500/80" style={{ width: `${highRiskRate ?? 0}%` }} />
              </div>
            </div>
            <div>
              <div className="flex items-center justify-between gap-3 text-xs">
                <span className="font-medium text-muted-foreground">Average risk score</span>
                <span className="font-data font-semibold">{averageRiskScore}</span>
              </div>
              <RiskScoreBar score={averageRiskScoreValue} className="mt-2 h-2" />
            </div>
            <div className="grid grid-cols-2 gap-3 border-t border-border pt-4">
              <div className="rounded-md bg-secondary/45 p-3">
                <p className="text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">Priority</p>
                <p className="mt-1 font-data text-xl font-semibold">{highRiskClaims}</p>
              </div>
              <div className="rounded-md bg-secondary/45 p-3">
                <p className="text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">Networks</p>
                <p className="mt-1 font-data text-xl font-semibold">{activeNetworks}</p>
              </div>
            </div>
            <Link to="/risk" className="inline-flex items-center gap-1 text-xs font-semibold text-primary hover:underline">
              Open risk intelligence <ArrowUpRight className="h-3.5 w-3.5" />
            </Link>
          </div>
        </SectionCard>
      </section>

      <section className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_360px]">
        <SectionCard
          variant="console"
          title="Suspicious relationship network"
          description="Linked members, providers and shared attributes in the current graph projection."
        >
          <div className="p-4">
            <NetworkGraph graph={graph} height="360px" compact showControls={false} showMiniMap={false} />
            <Link to="/network" className="mt-4 inline-flex items-center gap-1 text-xs font-semibold text-primary hover:underline">
              Open network analysis <ArrowUpRight className="h-3.5 w-3.5" />
            </Link>
          </div>
        </SectionCard>

        {roleTasks.length > 0 ? (
          <SectionCard
            variant="console"
            title="Authorised work"
            description={`Available to ${formatIdentityRoles(identity)} in this workspace.`}
          >
            <div className="divide-y divide-border">
              {roleTasks.map((task) => {
                const Icon = task.icon;
                return (
                  <Link key={task.to} to={task.to} className="group flex gap-3 p-4 transition-colors hover:bg-secondary/45">
                    <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-border bg-background text-primary">
                      <Icon className="h-4 w-4" aria-hidden="true" />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center justify-between gap-2 text-sm font-semibold">
                        {task.label}
                        <ArrowUpRight className="h-3.5 w-3.5 text-muted-foreground group-hover:text-primary" />
                      </span>
                      <span className="mt-1 block text-xs leading-5 text-muted-foreground">{task.description}</span>
                    </span>
                  </Link>
                );
              })}
            </div>
          </SectionCard>
        ) : null}
      </section>
    </PageFrame>
  );
}
