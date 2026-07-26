import React from "react";
import { Link } from "react-router-dom";
import AlertTriangle from "lucide-react/dist/esm/icons/alert-triangle.mjs";
import FileText from "lucide-react/dist/esm/icons/file-text.mjs";
import Radar from "lucide-react/dist/esm/icons/radar.mjs";
import ShieldAlert from "lucide-react/dist/esm/icons/shield-alert.mjs";
import ArrowUpRight from "lucide-react/dist/esm/icons/arrow-up-right.mjs";
import Inbox from "lucide-react/dist/esm/icons/inbox.mjs";
import ListChecks from "lucide-react/dist/esm/icons/list-checks.mjs";
import SearchCheck from "lucide-react/dist/esm/icons/search-check.mjs";
import Settings from "lucide-react/dist/esm/icons/settings.mjs";
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
      <div className="space-y-2 border-b border-border/70 pb-5">
        <Skeleton className="h-3 w-36" />
        <Skeleton className="h-8 w-72" />
        <Skeleton className="h-4 w-full max-w-xl" />
      </div>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {Array.from({ length: 4 }).map((_, index) => (
          <div key={index} className="rounded-xl border border-border/70 bg-card p-4">
            <Skeleton className="h-3 w-28" />
            <Skeleton className="mt-4 h-8 w-24" />
            <Skeleton className="mt-3 h-3 w-full" />
          </div>
        ))}
      </div>
      <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_400px]">
        <div className="rounded-xl border border-border/70 bg-card p-5"><Skeleton className="h-72 w-full" /></div>
        <div className="rounded-xl border border-border/70 bg-card p-5"><Skeleton className="h-72 w-full" /></div>
      </div>
    </div>
  );
}

export function DashboardPage({ metrics, graph, status, lastRefresh }) {
  const { identity } = useRole();

  if (status === "loading") return <DashboardSkeleton />;

  const recentDetections = Array.isArray(metrics?.recentDetections) ? metrics.recentDetections : [];
  const totalClaims = Number.isFinite(metrics?.totalClaims) ? metrics.totalClaims : "Unavailable";
  const highRiskClaims = Number.isFinite(metrics?.highRiskClaims) ? metrics.highRiskClaims : "Unavailable";
  const averageRiskScore = Number.isFinite(metrics?.averageRiskScore) ? metrics.averageRiskScore : "Unavailable";
  const activeNetworks = Number.isFinite(metrics?.activeFraudSchemes) ? metrics.activeFraudSchemes : "Unavailable";
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
      eyebrow="Investigator workspace"
      title="Claims risk intelligence"
      description="Fraud detection, investigation prioritisation, and suspicious relationship monitoring for the active scheme partition."
      actions={[
        <MetricPill key="ledger" label="Ledger" value={metrics?.ledgerStatus || "Unknown"} tone={metrics?.ledgerStatus === "Connected" ? "success" : "warning"} />,
        <MetricPill key="refresh" label="Refreshed" value={lastRefresh ? new Date(lastRefresh).toLocaleTimeString("en-GB") : "Waiting"} />,
      ]}
    >
      <section aria-label="Detection summary" className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard variant="console" title="Claims screened" value={totalClaims} description="Total volume represented by the current operational snapshot." icon={FileText} />
        <StatCard variant="console" title="Priority alerts" value={highRiskClaims} description="Scored claims currently above the high-risk threshold." icon={ShieldAlert} tone="danger" />
        <StatCard variant="console" title="Average risk score" value={averageRiskScore} description="Mean persisted detection score for the current snapshot." icon={AlertTriangle} tone={riskScoreTone(averageRiskScore)} />
        <StatCard variant="console" title="Active networks" value={activeNetworks} description="Suspicious linked-entity clusters identified by the graph projection." icon={Radar} />
      </section>

      {roleTasks.length > 0 ? (
        <SectionCard
          variant="console"
          title="Your authorised work"
          description={`Available to ${formatIdentityRoles(identity)} in the active scheme. Actions are derived from session capabilities, including multi-role assignments.`}
        >
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
            {roleTasks.map((task) => {
              const Icon = task.icon;
              return (
                <Link
                  key={task.to}
                  to={task.to}
                  className="group rounded-xl border border-border/70 bg-background/35 p-4 transition-colors hover:border-primary/40 hover:bg-primary/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <span className="flex h-9 w-9 items-center justify-center rounded-lg border border-border/70 bg-card text-primary">
                    <Icon className="h-4 w-4" aria-hidden="true" />
                  </span>
                  <span className="mt-3 flex items-center justify-between gap-3 font-semibold">
                    {task.label}
                    <ArrowUpRight className="h-4 w-4 text-muted-foreground transition-colors group-hover:text-primary" aria-hidden="true" />
                  </span>
                  <span className="mt-1 block text-sm leading-6 text-muted-foreground">{task.description}</span>
                </Link>
              );
            })}
          </div>
        </SectionCard>
      ) : null}

      <section className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_400px]">
        <SectionCard
          variant="console"
          title="Priority claims queue"
          description="Highest-risk scored claims, ordered by descending risk severity."
          actions={<Link to="/claims" className="text-xs font-semibold text-primary hover:underline">Open all claims</Link>}
        >
          {recentDetections.length === 0 ? (
            <EmptyState
              compact
              icon={Inbox}
              title="No priority claims"
              description="No scored claims currently meet the priority threshold. Claims still awaiting scoring are available in Claims Explorer."
            />
          ) : (
            <DataTableShell ariaLabel="Priority claims queue" minWidth="820px">
              <thead>
                <tr>
                  <th>Reference</th>
                  <th>Member</th>
                  <th>Provider</th>
                  <th>Risk</th>
                  <th>Investigation status</th>
                  <th>Updated</th>
                  <th><span className="sr-only">Open claim</span></th>
                </tr>
              </thead>
              <tbody>
                {recentDetections.map((item) => (
                  <tr key={item.claimId}>
                    <td><Link to={`/claims/${encodeURIComponent(item.claimId)}`} className="font-semibold text-primary hover:underline">{item.claimId}</Link></td>
                    <td>{item.memberId || "Unknown"}</td>
                    <td>{item.providerId || "Unknown"}</td>
                    <td>
                      <div className="flex items-center gap-2">
                        <span className="font-data font-semibold">{Number.isFinite(item.riskScore) ? item.riskScore : "—"}</span>
                        <span className="text-xs text-muted-foreground">{item.severity || "Unknown"}</span>
                      </div>
                    </td>
                    <td><StatusIndicator variant="badge" tone={claimStatusTone(item.status)}>{formatEnumLabel(item.status)}</StatusIndicator></td>
                    <td className="text-muted-foreground">{item.detectionDate ? new Date(item.detectionDate).toLocaleDateString("en-GB") : "Not available"}</td>
                    <td className="text-right">
                      <Link
                        to={`/claims/${encodeURIComponent(item.claimId)}`}
                        className="inline-flex h-8 w-8 items-center justify-center rounded-full border border-border bg-background text-muted-foreground transition-colors hover:border-primary/40 hover:text-primary focus:outline-none focus:ring-2 focus:ring-ring"
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
          title="Suspicious relationship network"
          description="Linked members, providers, and shared attributes represented by the current graph projection."
        >
          <div className="p-4">
            <NetworkGraph graph={graph} height="340px" compact showControls={false} showMiniMap={false} />
            <Link to="/network" className="mt-4 inline-flex items-center gap-1.5 text-xs font-semibold text-primary hover:underline">
              Open network intelligence <ArrowUpRight className="h-3.5 w-3.5" />
            </Link>
          </div>
        </SectionCard>
      </section>
    </PageFrame>
  );
}
