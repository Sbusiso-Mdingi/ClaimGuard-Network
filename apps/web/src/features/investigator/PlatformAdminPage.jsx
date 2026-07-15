import React, { useEffect, useState } from "react";
import { PageFrame, SectionCard, StatusIndicator } from "./InvestigatorUI";

const HEALTH_REQUEST_TIMEOUT_MS = 15000;

async function fetchJsonWithTimeout(url, timeoutMs = HEALTH_REQUEST_TIMEOUT_MS) {
  const controller = new AbortController();
  const timeoutId = window.setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, { signal: controller.signal, cache: "no-store" });
    if (!response.ok) {
      return {
        status: "error",
        ready: false,
        message: `Request failed (${response.status})`,
      };
    }

    return await response.json();
  } catch (error) {
    if (error?.name === "AbortError") {
      return {
        status: "timeout",
        ready: false,
        message: "Request timed out.",
      };
    }

    return {
      status: "unreachable",
      ready: false,
      message: "Request failed.",
    };
  } finally {
    window.clearTimeout(timeoutId);
  }
}

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
      const [healthRes, readyRes] = await Promise.allSettled([
        fetchJsonWithTimeout("/api/health"),
        fetchJsonWithTimeout("/api/ready"),
      ]);

      if (cancelled) {
        return;
      }

      setHealth({
        health: healthRes.status === "fulfilled" ? healthRes.value : { status: "unreachable" },
        ready: readyRes.status === "fulfilled" ? readyRes.value : { status: "unreachable", ready: false },
      });
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