import React from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../../components/ui/card";

export function HistoryPage({ snapshots }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Detection History</CardTitle>
        <CardDescription>Chronological snapshots captured on each successful API refresh.</CardDescription>
      </CardHeader>
      <CardContent>
        {snapshots.length === 0 ? (
          <p className="rounded-md border border-dashed border-border p-6 text-sm text-muted-foreground">No snapshots captured yet.</p>
        ) : (
          <div className="space-y-2">
            {snapshots.map((snapshot) => (
              <div key={snapshot.id} className="rounded-md border border-border p-3 text-sm">
                <div className="mb-1 flex flex-wrap items-center justify-between gap-2">
                  <p className="font-semibold">{new Date(snapshot.timestamp).toLocaleString()}</p>
                  <span className="text-xs text-muted-foreground">Risk {snapshot.risk?.riskScore ?? snapshot.avgRisk}</span>
                </div>
                <p className="text-xs text-muted-foreground">
                  Claims: {snapshot.totalClaims} · High-risk: {snapshot.highRiskClaims} · Avg risk: {snapshot.avgRisk} · Schemes: {snapshot.schemes}
                </p>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
