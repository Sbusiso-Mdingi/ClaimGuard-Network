import React from "react";
import Clock3 from "lucide-react/dist/esm/icons/clock-3.mjs";
import Activity from "lucide-react/dist/esm/icons/activity.mjs";
import AlertTriangle from "lucide-react/dist/esm/icons/alert-triangle.mjs";
import Building2 from "lucide-react/dist/esm/icons/building-2.mjs";
import { EmptyState, PageFrame, SectionCard, MetricPill, SummaryRail } from "./InvestigatorUI";

export function HistoryPage({ snapshots }) {
  const newestSnapshot = snapshots[0] || null;

  return (
    <PageFrame
      eyebrow="Detection History"
      title="Snapshot timeline"
      description="Chronological refresh points captured by the investigator workspace when the snapshot updates."
      actions={[
        <MetricPill key="count" label="Snapshots" value={snapshots.length} />,
      ]}
    >
      <SummaryRail
        ariaLabel="Snapshot summary"
        items={[
          {
            key: "latest-claims",
            label: "Latest claims",
            value: newestSnapshot?.totalClaims ?? "—",
            description: "Most recent refresh",
            icon: Activity,
          },
          {
            key: "latest-high",
            label: "Latest high-risk",
            value: newestSnapshot?.highRiskClaims ?? "—",
            description: "Most recent refresh",
            icon: AlertTriangle,
            iconClassName: Number(newestSnapshot?.highRiskClaims) > 0 ? "text-rose-500" : "text-emerald-500",
          },
          {
            key: "latest-schemes",
            label: "Latest schemes",
            value: newestSnapshot?.schemes ?? "—",
            description: "Distinct schemes represented",
            icon: Building2,
          },
        ]}
      />

      <SectionCard variant="console" title="Refresh timeline" description="Each entry summarizes the investigator state at the moment of refresh.">
        {snapshots.length === 0 ? (
          <EmptyState compact icon={Clock3} title="No snapshots captured" description="Snapshots appear after successful workspace refreshes." />
        ) : (
          <div className="space-y-3 p-5">
            {snapshots.map((snapshot) => (
              <div key={snapshot.id} className="relative rounded-2xl border border-border/70 bg-background/70 px-4 py-4 pl-12 text-sm">
                <span className="absolute left-4 top-4 flex h-7 w-7 items-center justify-center rounded-full bg-primary/10 text-primary">
                  <Clock3 className="h-4 w-4" />
                </span>
                <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                  <p className="font-semibold tracking-tight">{new Date(snapshot.timestamp).toLocaleString()}</p>
                  <span className="text-xs uppercase tracking-[0.18em] text-muted-foreground">Risk {snapshot.risk?.riskScore ?? snapshot.avgRisk}</span>
                </div>
                <div className="grid gap-2 text-xs text-muted-foreground sm:grid-cols-2 xl:grid-cols-4">
                  <p>Claims: {snapshot.totalClaims}</p>
                  <p>High-risk: {snapshot.highRiskClaims}</p>
                  <p>Avg risk: {snapshot.avgRisk}</p>
                  <p>Schemes: {snapshot.schemes}</p>
                </div>
              </div>
            ))}
          </div>
        )}
      </SectionCard>
    </PageFrame>
  );
}
