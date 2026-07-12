import React from "react";
import { Badge } from "../../components/ui/badge";
import { Progress } from "../../components/ui/progress";
import { PageFrame, SectionCard, StatusBadge } from "./InvestigatorUI";

export function RiskPage({ risk, report }) {
  const reasons = risk?.reasons || [];
  const rules = report?.detection?.triggered_rules || [];
  const evidence = report?.detection?.evidence || [];

  return (
    <PageFrame
      eyebrow="Risk Panel"
      title="Explainability summary"
      description="Risk score, severity, triggered rules, and evidence are surfaced in a compact review-friendly format."
      actions={[
        <StatusBadge key="severity" variant={risk?.severity === "High" ? "destructive" : risk?.severity === "Medium" ? "secondary" : "outline"}>{risk?.severity || "Low"}</StatusBadge>,
      ]}
    >
      <SectionCard title="Risk score" description="The score and severity indicate how aggressively this claim should be reviewed.">
        <div className="rounded-2xl border border-border/70 bg-secondary/30 p-5">
          <div className="flex flex-wrap items-end justify-between gap-4">
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.16em] text-muted-foreground">Current score</p>
              <p className="mt-1 text-5xl font-semibold tracking-tight">{risk?.riskScore ?? 0}</p>
            </div>
            <Badge variant={risk?.severity === "High" ? "destructive" : risk?.severity === "Medium" ? "warning" : "secondary"} className="rounded-full px-3 py-1.5 text-[11px] font-semibold">
              {risk?.severity || "Low"}
            </Badge>
          </div>
          <Progress value={risk?.riskScore ?? 0} className="mt-4 h-2" />
        </div>
      </SectionCard>

      <div className="grid gap-4 xl:grid-cols-[1fr_1fr]">
        <SectionCard title="Explainability" description="Why the engine escalated the claim.">
          {reasons.length === 0 ? (
            <p className="text-sm text-muted-foreground">No explainability reasons returned.</p>
          ) : (
            <div className="space-y-2">
              {reasons.map((reason) => (
                <div key={reason} className="rounded-xl border border-border/70 bg-background/70 px-3 py-3 text-sm leading-6">
                  {reason}
                </div>
              ))}
            </div>
          )}
        </SectionCard>

        <SectionCard title="Triggered rules" description="The rules responsible for the current score and severity.">
          {rules.length === 0 ? (
            <p className="text-sm text-muted-foreground">No triggered rules in current snapshot.</p>
          ) : (
            <div className="space-y-2">
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

      <SectionCard title="Contributing evidence" description="A concise set of signals used to explain the current risk posture.">
        {evidence.length === 0 ? (
          <p className="text-sm text-muted-foreground">No evidence returned.</p>
        ) : (
          <div className="grid gap-2 md:grid-cols-2 xl:grid-cols-1">
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
