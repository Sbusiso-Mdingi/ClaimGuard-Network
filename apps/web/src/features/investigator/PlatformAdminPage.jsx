import React, { useEffect, useState } from "react";
import { PageFrame, SectionCard, StatusIndicator } from "./InvestigatorUI";

function PlannedCapability({ title }) {
  return (
    <div className="rounded-xl border border-dashed border-border p-4 text-sm text-muted-foreground">
      <p className="font-medium text-foreground">{title}</p>
      <p className="mt-1">Planned capability — backend already supports required foundations. No dedicated platform-operations API exists yet.</p>
    </div>
  );
}

export function PlatformAdminPage() {
  const [health, setHealth] = useState(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const [healthRes, readyRes] = await Promise.all([
        fetch("/api/health").then((r) => r.json()).catch(() => null),
        fetch("/api/ready").then((r) => r.json()).catch(() => null),
      ]);
      if (!cancelled) setHealth({ health: healthRes, ready: readyRes });
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <PageFrame
      eyebrow="Platform Administration"
      title="ClaimGuard platform operations"
      description="Cross-tenant operational view for ClaimGuard staff. Platform administrators do not investigate or confirm fraud."
    >
      <SectionCard title="API health" description="Live read from the API's existing /health and /ready endpoints.">
        <div className="flex flex-wrap gap-3">
          <StatusIndicator variant="badge" tone={health?.health?.status === "ok" ? "success" : "info"}>
            /health: {health?.health?.status || "checking..."}
          </StatusIndicator>
          <StatusIndicator variant="badge" tone={health?.ready?.ready ? "success" : "info"}>
            /ready: {health?.ready?.status || "checking..."}
          </StatusIndicator>
        </div>
      </SectionCard>

      <SectionCard title="Platform operations" description="Planned platform administrator capabilities.">
        <div className="grid gap-3 md:grid-cols-2">
          <PlannedCapability title="Tenant onboarding" />
          <PlannedCapability title="Storage & deployment monitoring" />
          <PlannedCapability title="Telemetry dashboards" />
          <PlannedCapability title="Cross-tenant investigation oversight" />
        </div>
      </SectionCard>
    </PageFrame>
  );
}