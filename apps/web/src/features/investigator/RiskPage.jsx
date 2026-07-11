import React from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../../components/ui/card";
import { Badge } from "../../components/ui/badge";

export function RiskPage({ risk, report }) {
  const reasons = risk?.reasons || [];
  const rules = report?.detection?.triggered_rules || [];
  const evidence = report?.detection?.evidence || [];

  return (
    <Card>
      <CardHeader>
        <CardTitle>Risk Panel</CardTitle>
        <CardDescription>Risk score, severity, explainability, triggered rules, and evidence.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-wrap items-center gap-3">
          <Badge variant={risk?.severity === "High" ? "destructive" : risk?.severity === "Medium" ? "warning" : "secondary"}>{risk?.severity || "Low"}</Badge>
          <span className="text-3xl font-bold">{risk?.riskScore ?? 0}</span>
        </div>

        <section>
          <h3 className="mb-2 text-sm font-semibold">Explainability</h3>
          {reasons.length === 0 ? (
            <p className="text-sm text-muted-foreground">No explainability reasons returned.</p>
          ) : (
            <ul className="list-disc space-y-1 pl-5 text-sm">
              {reasons.map((reason) => <li key={reason}>{reason}</li>)}
            </ul>
          )}
        </section>

        <section>
          <h3 className="mb-2 text-sm font-semibold">Triggered Rules</h3>
          {rules.length === 0 ? (
            <p className="text-sm text-muted-foreground">No triggered rules in current snapshot.</p>
          ) : (
            <div className="space-y-2">
              {rules.map((rule) => (
                <div key={`${rule.rule_id}-${rule.title}`} className="rounded-md border border-border p-2">
                  <p className="text-sm font-medium">{rule.title}</p>
                  <p className="text-xs text-muted-foreground">{rule.rule_id} · weight {rule.weight}</p>
                </div>
              ))}
            </div>
          )}
        </section>

        <section>
          <h3 className="mb-2 text-sm font-semibold">Contributing Evidence</h3>
          {evidence.length === 0 ? (
            <p className="text-sm text-muted-foreground">No evidence returned.</p>
          ) : (
            <ul className="list-disc space-y-1 pl-5 text-sm">
              {evidence.slice(0, 20).map((item) => <li key={item}>{item}</li>)}
            </ul>
          )}
        </section>
      </CardContent>
    </Card>
  );
}
