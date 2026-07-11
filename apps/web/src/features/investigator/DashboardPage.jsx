import React from "react";
import { AlertTriangle, Clock3, Database, FileText, Radar, ShieldAlert } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../../components/ui/card";
import { Badge } from "../../components/ui/badge";
import { Skeleton } from "../../components/ui/skeleton";

function KpiCard({ title, value, description, icon: Icon }) {
  return (
    <Card>
      <CardHeader className="pb-3">
        <CardDescription className="flex items-center justify-between">
          {title}
          <Icon className="h-4 w-4 text-muted-foreground" />
        </CardDescription>
        <CardTitle className="text-2xl">{value}</CardTitle>
      </CardHeader>
      <CardContent>
        <p className="text-xs text-muted-foreground">{description}</p>
      </CardContent>
    </Card>
  );
}

export function DashboardPage({ metrics, status, lastRefresh }) {
  if (status === "loading") {
    return (
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {Array.from({ length: 6 }).map((_, idx) => (
          <Card key={idx}>
            <CardHeader>
              <Skeleton className="h-4 w-28" />
              <Skeleton className="h-8 w-24" />
            </CardHeader>
            <CardContent>
              <Skeleton className="h-3 w-full" />
            </CardContent>
          </Card>
        ))}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        <KpiCard title="Total claims" value={metrics.totalClaims} description="Claims available in current snapshot" icon={FileText} />
        <KpiCard title="High-risk claims" value={metrics.highRiskClaims} description="Claims with risk score >= 70" icon={ShieldAlert} />
        <KpiCard title="Average risk score" value={metrics.averageRiskScore} description="Mean score across indexed claims" icon={AlertTriangle} />
        <KpiCard title="Active fraud schemes" value={metrics.activeFraudSchemes} description="Schemes with high-risk findings" icon={Radar} />
        <KpiCard title="Ledger status" value={metrics.ledgerStatus} description="Runtime ledger linkage state" icon={Database} />
        <KpiCard
          title="Last refresh"
          value={lastRefresh ? new Date(lastRefresh).toLocaleTimeString() : "waiting"}
          description="Most recent successful investigator fetch"
          icon={Clock3}
        />
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Recent detections</CardTitle>
          <CardDescription>Latest high-impact detections sorted by risk score.</CardDescription>
        </CardHeader>
        <CardContent>
          {metrics.recentDetections.length === 0 ? (
            <p className="rounded-md border border-dashed border-border p-4 text-sm text-muted-foreground">No detections available yet.</p>
          ) : (
            <div className="space-y-2">
              {metrics.recentDetections.map((item) => (
                <div key={item.claimId} className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border p-3">
                  <div>
                    <p className="text-sm font-semibold">{item.claimId}</p>
                    <p className="text-xs text-muted-foreground">Policy holder: {item.policyHolder}</p>
                  </div>
                  <div className="flex items-center gap-2">
                    <Badge variant={item.severity === "High" ? "destructive" : item.severity === "Medium" ? "warning" : "secondary"}>{item.severity}</Badge>
                    <span className="text-sm font-medium">{item.riskScore}</span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
