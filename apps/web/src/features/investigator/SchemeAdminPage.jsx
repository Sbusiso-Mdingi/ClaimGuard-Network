import React from "react";
import { useRole } from "../../context/RoleContext";
import { PageFrame, SectionCard } from "./InvestigatorUI";
import { DetectionEngineSettings } from "./DetectionEngineSettings";

function PlannedCapability({ title }) {
  return (
    <div className="rounded-xl border border-dashed border-border p-4 text-sm text-muted-foreground">
      <p className="font-medium text-foreground">{title}</p>
      <p className="mt-1">Planned capability — backend already supports required foundations. No dedicated management API exists yet.</p>
    </div>
  );
}

export function SchemeAdminPage() {
  const { identity } = useRole();

  return (
    <PageFrame
      eyebrow="Scheme Administration"
      title={identity.tenantLabel || identity.tenantId}
      description="Tenant-scoped administrative settings for this medical scheme."
    >
      <SectionCard title="Tenant information" description="Identity currently active in this demo session.">
        <div className="grid gap-3 md:grid-cols-2">
          <div className="rounded-xl border border-border/70 px-4 py-3">
            <p className="text-xs uppercase tracking-[0.16em] text-muted-foreground">Tenant ID</p>
            <p className="mt-1 font-data text-sm">{identity.tenantId}</p>
          </div>
          <div className="rounded-xl border border-border/70 px-4 py-3">
            <p className="text-xs uppercase tracking-[0.16em] text-muted-foreground">Scheme</p>
            <p className="mt-1 text-sm font-semibold">{identity.tenantLabel}</p>
          </div>
        </div>
      </SectionCard>

      <SectionCard title="Administration" description="Planned scheme administrator capabilities.">
        <div className="grid gap-3 md:grid-cols-2">
          <PlannedCapability title="Tenant / scheme configuration" />
          <PlannedCapability title="User management" />
          <DetectionEngineSettings tenantId={identity.tenantId} />
          <PlannedCapability title="Operational metrics for this tenant" />
        </div>
      </SectionCard>
    </PageFrame>
  );
}