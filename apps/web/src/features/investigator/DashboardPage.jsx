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
import FileSearch from "lucide-react/dist/esm/icons/file-search.mjs";
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

const CHART_WIDTH = 560;
const CHART_HEIGHT = 220;

function monthKey(date) {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
}

function monthLabel(key) {
  const [year, month] = String(key).split("-").map((value) => Number.parseInt(value, 10));
  if (!Number.isFinite(year) || !Number.isFinite(month)) return key;
  return new Date(Date.UTC(year, month - 1, 1)).toLocaleDateString("en-GB", { month: "short" });
}

function detectionDateFromClaim(claim) {
  const source = claim?.detectionDate || claim?.scoringUpdatedAt || claim?.updatedAt || claim?.submittedAt;
  if (!source) return null;
  const parsed = new Date(source);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function buildDetectionTrend(claims = []) {
  const datedClaims = claims
    .map((claim) => ({
      claim,
      date: detectionDateFromClaim(claim),
    }))
    .filter((entry) => Boolean(entry.date));

  if (datedClaims.length === 0) {
    return [];
  }

  const sorted = datedClaims.slice().sort((a, b) => a.date.getTime() - b.date.getTime());
  const monthCounts = new Map();

  for (const { claim, date } of sorted) {
    const key = monthKey(date);
    const aggregate = monthCounts.get(key) || { screened: 0, priority: 0, confirmed: 0 };
    aggregate.screened += 1;
    if (Number.isFinite(claim?.riskScore) && claim.riskScore >= 75) {
      aggregate.priority += 1;
    }
    if (String(claim?.status || "").toUpperCase() === "CONFIRMED_FRAUD") {
      aggregate.confirmed += 1;
    }
    monthCounts.set(key, aggregate);
  }

  const monthKeys = Array.from(monthCounts.keys());
  const lastKeys = monthKeys.slice(-6);

  return lastKeys.map((key) => ({
    month: monthLabel(key),
    ...monthCounts.get(key),
  }));
}

function buildRiskDistribution(claims = []) {
  const counters = {
    High: 0,
    Medium: 0,
    Low: 0,
    Unknown: 0,
  };

  for (const claim of claims) {
    const severity = String(claim?.severity || "").toLowerCase();
    if (severity.includes("high")) counters.High += 1;
    else if (severity.includes("medium")) counters.Medium += 1;
    else if (severity.includes("low")) counters.Low += 1;
    else counters.Unknown += 1;
  }

  return [
    { severity: "High", count: counters.High, tone: "bg-rose-500/80" },
    { severity: "Medium", count: counters.Medium, tone: "bg-amber-500/80" },
    { severity: "Low", count: counters.Low, tone: "bg-emerald-500/80" },
    { severity: "Unknown", count: counters.Unknown, tone: "bg-slate-400/80" },
  ];
}

function buildSchemeRiskDistribution(counts) {
  if (!counts || typeof counts !== "object") return null;
  return [
    { severity: "Critical", count: Number(counts.critical) || 0, tone: "bg-rose-600/85" },
    { severity: "High", count: Number(counts.high) || 0, tone: "bg-orange-500/85" },
    { severity: "Medium", count: Number(counts.medium) || 0, tone: "bg-amber-500/80" },
    { severity: "Low", count: Number(counts.low) || 0, tone: "bg-emerald-500/80" },
    { severity: "Awaiting", count: Number(counts.unscored) || 0, tone: "bg-slate-400/80" },
  ];
}

function polylinePoints(points, key, maxValue) {
  if (points.length === 0 || maxValue <= 0) return "";
  const stepX = points.length > 1 ? CHART_WIDTH / (points.length - 1) : CHART_WIDTH;
  return points
    .map((point, index) => {
      const x = Math.round(index * stepX);
      const y = Math.round(CHART_HEIGHT - (point[key] / maxValue) * CHART_HEIGHT);
      return `${x},${y}`;
    })
    .join(" ");
}

function MiniTrendChart({ trend }) {
  if (!trend.length) {
    return (
      <EmptyState
        compact
        icon={FileSearch}
        title="Detection trend unavailable"
        description="More scored claims are required before trend telemetry can be rendered."
      />
    );
  }

  const maxValue = Math.max(1, ...trend.map((point) => Math.max(point.screened, point.priority, point.confirmed)));
  const screenedLine = polylinePoints(trend, "screened", maxValue);
  const priorityLine = polylinePoints(trend, "priority", maxValue);
  const confirmedLine = polylinePoints(trend, "confirmed", maxValue);

  return (
    <div className="space-y-3 p-4">
      <div className="overflow-x-auto">
        <svg viewBox={`0 0 ${CHART_WIDTH} ${CHART_HEIGHT + 26}`} className="h-[230px] min-w-[480px] w-full" role="img" aria-label="Detection trend chart">
          <line x1="0" y1={CHART_HEIGHT} x2={CHART_WIDTH} y2={CHART_HEIGHT} stroke="hsl(var(--border))" strokeWidth="1" />
          {[0.25, 0.5, 0.75].map((ratio) => {
            const y = Math.round(CHART_HEIGHT - CHART_HEIGHT * ratio);
            return <line key={ratio} x1="0" y1={y} x2={CHART_WIDTH} y2={y} stroke="hsl(var(--border))" strokeWidth="1" strokeDasharray="4 6" opacity="0.6" />;
          })}

          <polyline fill="none" stroke="hsl(var(--accent))" strokeWidth="2" points={screenedLine} />
          <polyline fill="none" stroke="hsl(var(--primary))" strokeWidth="2" points={priorityLine} />
          <polyline fill="none" stroke="hsl(var(--destructive))" strokeWidth="2" points={confirmedLine} strokeDasharray="4 4" />

          {trend.map((point, index) => {
            const x = trend.length > 1 ? Math.round((index * CHART_WIDTH) / (trend.length - 1)) : CHART_WIDTH;
            return (
              <text key={point.month} x={x} y={CHART_HEIGHT + 18} textAnchor="middle" className="fill-muted-foreground text-[10px] font-medium">
                {point.month}
              </text>
            );
          })}
        </svg>
      </div>
      <div className="flex flex-wrap items-center gap-3 px-1 text-xs text-muted-foreground">
        <span className="inline-flex items-center gap-1.5"><span className="h-2 w-2 rounded-full" style={{ backgroundColor: "hsl(var(--accent))" }} /> Screened</span>
        <span className="inline-flex items-center gap-1.5"><span className="h-2 w-2 rounded-full" style={{ backgroundColor: "hsl(var(--primary))" }} /> Priority</span>
        <span className="inline-flex items-center gap-1.5"><span className="h-2 w-2 rounded-full" style={{ backgroundColor: "hsl(var(--destructive))" }} /> Confirmed</span>
      </div>
    </div>
  );
}

function ActivityFeed({ items = [] }) {
  if (items.length === 0) {
    return (
      <EmptyState
        compact
        icon={Inbox}
        title="No recent activity"
        description="Activity appears after claim scoring and investigation updates are written."
      />
    );
  }

  return (
    <ol className="divide-y divide-border/60 px-5">
      {items.map((item) => (
        <li key={item.id} className="flex items-start gap-3 py-3">
          <span className="mt-0.5 grid h-6 w-6 shrink-0 place-items-center rounded-full border border-border bg-background/70">
            <FileSearch className="h-3.5 w-3.5 text-muted-foreground" aria-hidden="true" />
          </span>
          <div className="min-w-0">
            <p className="text-sm leading-5 text-foreground">
              <span className="font-medium">{item.claimId}</span>
              <span className="text-muted-foreground"> {item.message}</span>
            </p>
            <p className="mt-0.5 text-xs text-muted-foreground">{item.timeLabel}</p>
          </div>
        </li>
      ))}
    </ol>
  );
}

function RiskDistributionChart({ distribution, highestBand }) {
  return (
    <div className="px-5 pt-5">
      <div className="flex h-36 items-end gap-3 border-b border-border/80 px-1" aria-label="Risk distribution chart">
        {distribution.map((band) => {
          const height = band.count > 0
            ? Math.max(10, (band.count / highestBand) * 100)
            : 3;
          return (
            <div key={band.severity} className="flex h-full min-w-0 flex-1 items-end">
              <span
                className={`block w-full rounded-t-md ${band.tone}`}
                style={{ height: `${height}%` }}
                title={`${band.severity}: ${band.count}`}
              />
            </div>
          );
        })}
      </div>
      <div
        className="grid gap-3 px-1 pt-2 text-center text-[10px] text-muted-foreground"
        style={{ gridTemplateColumns: `repeat(${distribution.length}, minmax(0, 1fr))` }}
      >
        {distribution.map((band) => <span key={band.severity}>{band.severity}</span>)}
      </div>
    </div>
  );
}

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
  const allClaims = Array.isArray(metrics?.allClaims) ? metrics.allClaims : recentDetections;
  const totalClaims = Number.isFinite(metrics?.totalClaims) ? metrics.totalClaims : "Unavailable";
  const highRiskClaims = Number.isFinite(metrics?.highRiskClaims) ? metrics.highRiskClaims : "Unavailable";
  const averageRiskScore = Number.isFinite(metrics?.averageRiskScore) ? metrics.averageRiskScore : "Unavailable";
  const scoredClaims = Number.isFinite(metrics?.scoredClaims) ? metrics.scoredClaims : null;
  const unscoredClaims = Number.isFinite(metrics?.unscoredClaims) ? metrics.unscoredClaims : null;
  const activeNetworks = Number.isFinite(metrics?.activeFraudSchemes) ? metrics.activeFraudSchemes : "Unavailable";
  const trend = buildDetectionTrend(allClaims);
  const distribution = buildSchemeRiskDistribution(metrics?.riskDistribution)
    || buildRiskDistribution(allClaims);
  const highestBand = Math.max(1, ...distribution.map((band) => band.count));
  const activity = allClaims
    .slice()
    .sort((a, b) => {
      const dateA = detectionDateFromClaim(a)?.getTime() || 0;
      const dateB = detectionDateFromClaim(b)?.getTime() || 0;
      return dateB - dateA;
    })
    .slice(0, 6)
    .map((claim) => ({
      id: claim.claimId,
      claimId: claim.claimId,
      message: claim.status === "CONFIRMED_FRAUD"
        ? "confirmed as fraud"
        : claim.status === "UNDER_INVESTIGATION"
          ? "moved into investigation"
          : "received a scoring update",
      timeLabel: detectionDateFromClaim(claim)
        ? detectionDateFromClaim(claim).toLocaleString("en-GB", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" })
        : "Timestamp unavailable",
    }));
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
      eyebrow="Scheme intelligence"
      title="Executive dashboard"
      description="Scheme-wide fraud, waste and abuse posture across screened claims, active investigations, and suspicious relationship signals."
      actions={[
        <MetricPill key="scheme" label="Scheme" value={identity?.tenantLabel || identity?.tenantSlug || "Active scheme"} />,
        <MetricPill key="ledger" label="Ledger" value={metrics?.ledgerStatus || "Unknown"} tone={metrics?.ledgerStatus === "Connected" ? "success" : "warning"} />,
        <MetricPill key="refresh" label="Refreshed" value={lastRefresh ? new Date(lastRefresh).toLocaleTimeString("en-GB") : "Waiting"} />,
      ]}
    >
      <section aria-label="Detection summary" className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          variant="console"
          title="Claims received"
          value={totalClaims}
          description={scoredClaims === null || unscoredClaims === null
            ? "Scheme-wide submitted claim volume."
            : `${scoredClaims} scored · ${unscoredClaims} awaiting a persisted score.`}
          icon={FileText}
        />
        <StatCard variant="console" title="Flagged for review" value={highRiskClaims} description="Scheme-wide scored claims meeting a review or high-risk threshold." icon={ShieldAlert} tone="danger" />
        <StatCard variant="console" title="Average risk score" value={averageRiskScore} description="Mean persisted score across all currently scored scheme claims." icon={AlertTriangle} tone={riskScoreTone(averageRiskScore)} />
        <StatCard variant="console" title="Active networks" value={activeNetworks} description="Suspicious linked-entity clusters identified by the graph projection." icon={Radar} />
      </section>

      <section className="grid gap-5 xl:grid-cols-3">
        <SectionCard
          variant="console"
          className="xl:col-span-2"
          title="Detection trend"
          description="Monthly screened, priority, and confirmed counts derived from live claim updates."
        >
          <MiniTrendChart trend={trend} />
        </SectionCard>

        <SectionCard
          variant="console"
          title="Risk distribution"
          description="Scheme-wide current-version claim severity, with unscored volume shown separately."
        >
          <RiskDistributionChart distribution={distribution} highestBand={highestBand} />
          <div className="space-y-4 p-5">
            {distribution.map((band) => (
              <div key={band.severity} className="space-y-1.5">
                <div className="flex items-center justify-between gap-2 text-xs">
                  <span className="font-medium text-foreground">{band.severity}</span>
                  <span className="font-data text-muted-foreground">{band.count}</span>
                </div>
                <span className="block h-1.5 overflow-hidden rounded-full bg-secondary">
                  <span className={`block h-full rounded-full ${band.tone}`} style={{ width: `${(band.count / highestBand) * 100}%` }} />
                </span>
              </div>
            ))}
          </div>
        </SectionCard>
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

      <section className="grid gap-5 xl:grid-cols-3">
        <SectionCard
          variant="console"
          className="xl:col-span-2"
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
                        <span className="text-xs text-muted-foreground">{item.severity || item.riskLevel || "Unknown"}</span>
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
          title="Recent activity"
          description="Latest scoring and case status events from live claim records."
        >
          <ActivityFeed items={activity} />
        </SectionCard>
      </section>

      <section className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_400px]">
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
