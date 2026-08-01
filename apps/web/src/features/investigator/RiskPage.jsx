import React from "react";
import { Badge } from "../../components/ui/badge";
import { Progress } from "../../components/ui/progress";
import AlertTriangle from "lucide-react/dist/esm/icons/alert-triangle.mjs";
import FileSearch from "lucide-react/dist/esm/icons/file-search.mjs";
import Scale from "lucide-react/dist/esm/icons/scale.mjs";
import ShieldAlert from "lucide-react/dist/esm/icons/shield-alert.mjs";
import { EmptyState, PageFrame, SectionCard, StatusIndicator, SummaryRail, WorkspaceNotice, formatEnumLabel, severityStatusTone } from "./InvestigatorUI";

function formatSeverity(value) {
  const normalized = String(value || "").trim();
  if (!normalized) return "Unavailable";
  return formatEnumLabel(normalized, "Unavailable");
}

export function RiskPage({ risk, report }) {
  const reasons = risk?.reasons || [];
  const rules = report?.history?.ruleExecution?.triggeredRules || [];
  const evidence = report?.claims?.flatMap((claim) => claim.evidenceReferences || []) || [];
  const riskAvailable = Number.isFinite(risk?.riskScore);
  const severity = formatSeverity(risk?.severity);

  return (
    <PageFrame
      eyebrow="Risk Intelligence"
      title="Explainability summary"
      description="Risk score, severity, triggered rules, and evidence are surfaced in a compact review-friendly format."
      actions={[
        <StatusIndicator key="severity" tone={riskAvailable ? severityStatusTone(severity) : "warning"}>{severity}</StatusIndicator>,
      ]}
    >
      <SummaryRail
        ariaLabel="Risk summary"
        items={[
          {
            key: "score",
            label: "Composite score",
            value: riskAvailable ? risk.riskScore : "Unavailable",
            description: "Current claim intelligence score",
            icon: ShieldAlert,
            iconClassName: riskAvailable ? "text-rose-500" : "text-muted-foreground",
          },
          {
            key: "severity",
            label: "Severity",
            value: severity,
            description: "Operational risk band",
            icon: AlertTriangle,
            iconClassName: "text-amber-500",
          },
          {
            key: "rules",
            label: "Triggered rules",
            value: rules.length,
            description: "Rules contributing to score",
            icon: Scale,
          },
          {
            key: "evidence",
            label: "Evidence signals",
            value: evidence.length,
            description: "Evidence references in scope",
            icon: FileSearch,
          },
        ]}
      />

      {!riskAvailable ? (
        <WorkspaceNotice title="Risk score unavailable" tone="warning">
          Current payload does not include a numeric risk score. Explainability details are shown when present.
        </WorkspaceNotice>
      ) : null}

      <SectionCard variant="console" title="Risk score" description="The score and severity indicate how aggressively this claim should be reviewed.">
        <div className="rounded-2xl border border-border/70 bg-secondary/30 p-5 m-5">
          <div className="flex flex-wrap items-end justify-between gap-4">
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.16em] text-muted-foreground">Current score</p>
              <p className="font-data mt-1 text-5xl font-semibold tracking-tight">{riskAvailable ? risk.riskScore : "Unavailable"}</p>
            </div>
            <StatusIndicator tone={riskAvailable ? severityStatusTone(severity) : "warning"}>{severity}</StatusIndicator>
          </div>
          {riskAvailable ? <Progress value={risk.riskScore} className="mt-4 h-2" /> : null}
        </div>
      </SectionCard>

      <div className="grid gap-4 xl:grid-cols-[1fr_1fr]">
        <SectionCard variant="console" title="Explainability" description="Why the engine escalated the claim.">
          {reasons.length === 0 ? (
            <EmptyState compact icon={AlertTriangle} title="No explainability reasons" description="No explainability reasons were returned in the current response." />
          ) : (
            <div className="space-y-2 p-5">
              {reasons.map((reason) => (
                <div key={reason} className="rounded-xl border border-border/70 bg-background/70 px-3 py-3 text-sm leading-6">
                  {reason}
                </div>
              ))}
            </div>
          )}
        </SectionCard>

        <SectionCard variant="console" title="Triggered rules" description="The rules responsible for the current score and severity.">
          {rules.length === 0 ? (
            <EmptyState compact icon={Scale} title="No triggered rules" description="No triggered rules were returned in the current snapshot." />
          ) : (
            <div className="space-y-2 p-5">
              {rules.map((rule) => (
                <div key={`${rule.rule_id}-${rule.title}`} className="rounded-xl border border-border/70 bg-background/70 px-4 py-3">
                  <div className="flex items-start justify-between gap-3">
                    <p className="text-sm font-medium">{rule.title}</p>
                    <Badge variant="outline" className="rounded-full px-2.5 py-1 text-[11px] font-semibold">{rule.rule_id}</Badge>
                  </div>
                  <p className="mt-1 text-xs text-muted-foreground">Weight {rule.weight}</p>
                </div>
              ))}
            </div>
          )}
        </SectionCard>
      </div>

      <SectionCard variant="console" title="Contributing evidence" description="A concise set of signals used to explain the current risk posture.">
        {evidence.length === 0 ? (
          <EmptyState compact icon={FileSearch} title="No evidence returned" description="No evidence signals were included in the current payload." />
        ) : (
          <div className="grid gap-2 p-5 md:grid-cols-2 xl:grid-cols-1">
            {evidence.slice(0, 20).map((item) => (
              <div key={item} className="rounded-xl border border-border/70 bg-secondary/30 px-3 py-3 text-sm leading-6">
                {item}
              </div>
            ))}
          </div>
        )}
      </SectionCard>
    </PageFrame>
  );
}
