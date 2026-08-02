import React, { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import Building2 from "lucide-react/dist/esm/icons/building-2.mjs";
import FileClock from "lucide-react/dist/esm/icons/file-clock.mjs";
import Network from "lucide-react/dist/esm/icons/network.mjs";
import Settings from "lucide-react/dist/esm/icons/settings.mjs";
import ShieldCheck from "lucide-react/dist/esm/icons/shield-check.mjs";

import { Button } from "../../components/ui/button";
import { useRole } from "../../context/RoleContext";
import { apiJson } from "../../lib/apiClient";
import { canAccessNavItem, NAV_ITEMS } from "../../lib/roleNav";
import {
  PageFrame,
  SectionCard,
  StatCard,
  WorkspaceNotice,
} from "./InvestigatorUI";
import { GlobalDetectionEngineSettings } from "./GlobalDetectionEngineSettings";
import { PlatformAdministratorAccessPanel } from "./PlatformAdministratorAccessPanel";
import { ReleaseGovernancePanel } from "./ReleaseGovernancePanel";

const PLATFORM_DESTINATIONS = [
  { navKey: "platform-schemes", to: "/admin/platform/schemes", title: "Schemes & provisioning", description: "Register medical schemes, review infrastructure plans, and govern lifecycle operations.", icon: Building2 },
  { navKey: "platform-integrations", to: "/admin/platform/integrations", title: "Claims integrations", description: "Issue and revoke scheme claims-server credentials without exposing control-plane secrets.", icon: Network },
  { navKey: "platform-releases", to: "/admin/platform/releases", title: "Releases & promotions", description: "Review immutable artifacts and record two-person production promotion decisions.", icon: FileClock },
  { navKey: "platform-administrators", to: "/admin/platform/administrators", title: "Platform administrators", description: "Invite and review the separate identities authorised for platform governance.", icon: ShieldCheck },
  { navKey: "platform-detection", to: "/admin/platform/detection-engine", title: "Detection engine", description: "Review the governed model catalogue and fleet-managed deployment.", icon: Settings },
];

function DestinationCard({ destination }) {
  const Icon = destination.icon;
  return (
    <SectionCard
      title={destination.title}
      description={destination.description}
      actions={<span className="rounded-lg border border-border bg-secondary p-2 text-muted-foreground"><Icon className="h-4 w-4" /></span>}
      className="h-full"
    >
      <Button variant="outline" size="sm" asChild><Link to={destination.to}>Open workspace</Link></Button>
    </SectionCard>
  );
}

export function PlatformOperationsOverviewPage() {
  const { identity } = useRole();
  const [status, setStatus] = useState({ loading: true, health: null, ready: null, organisations: null, error: "" });
  const destinations = useMemo(() => PLATFORM_DESTINATIONS.filter((destination) => {
    const navItem = NAV_ITEMS.find((item) => item.key === destination.navKey);
    return canAccessNavItem(identity, navItem);
  }), [identity]);

  useEffect(() => {
    let active = true;
    Promise.allSettled([
      apiJson("/health", { cache: "no-store" }),
      apiJson("/ready", { cache: "no-store" }),
      apiJson("/admin/platform/organisations", { cache: "no-store" }),
    ]).then(([health, ready, organisations]) => {
      if (!active) return;
      setStatus({
        loading: false,
        health: health.status === "fulfilled" ? health.value : null,
        ready: ready.status === "fulfilled" ? ready.value : null,
        organisations: organisations.status === "fulfilled" ? organisations.value.organisations || [] : null,
        error: [health, ready, organisations].every((result) => result.status === "rejected")
          ? "Platform status could not be loaded. The management workspaces remain available according to your capabilities."
          : "",
      });
    });
    return () => { active = false; };
  }, []);

  return (
    <PageFrame
      eyebrow="Platform Administration"
      title="Platform operations overview"
      description="Use focused workspaces for scheme lifecycle, integrations, production releases, privileged access, and detection-engine governance."
    >
      {status.error ? <WorkspaceNotice title="Platform overview unavailable" tone="warning">{status.error}</WorkspaceNotice> : null}
      <section aria-label="Platform status" className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        <StatCard title="API status" value={status.loading ? "…" : status.health?.status || "Unavailable"} description="Public process health reported by the current API deployment." />
        <StatCard title="Deployment readiness" value={status.loading ? "…" : status.ready?.ready ? "Ready" : "Attention"} description={status.ready?.status || "Readiness checks are unavailable."} tone={status.ready?.ready ? "success" : "warning"} />
        <StatCard title="Medical schemes" value={status.loading ? "…" : status.organisations?.length ?? "—"} description="Registered control-plane organisations visible to this account." />
      </section>
      <section aria-label="Platform management workspaces" className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {destinations.map((destination) => <DestinationCard key={destination.to} destination={destination} />)}
      </section>
    </PageFrame>
  );
}

export function PlatformReleasesPage() {
  return <PageFrame eyebrow="Platform Administration" title="Releases & promotions" description="Review immutable release evidence and record governed production promotion decisions."><ReleaseGovernancePanel /></PageFrame>;
}

export function PlatformAdministratorsPage() {
  return <PageFrame eyebrow="Platform Administration" title="Platform administrators" description="Manage audited, persistent access for the separate administrators required by production governance."><PlatformAdministratorAccessPanel /></PageFrame>;
}

export function PlatformDetectionEnginePage() {
  const [organisations, setOrganisations] = useState([]);
  useEffect(() => {
    let active = true;
    apiJson("/admin/platform/organisations", { cache: "no-store" })
      .then((payload) => { if (active) setOrganisations(payload.organisations || []); })
      .catch(() => undefined);
    return () => { active = false; };
  }, []);
  return (
    <PageFrame eyebrow="Platform Administration" title="Detection engine" description="Review and govern the fleet-managed model catalogue without changing runtime traffic from the browser.">
      <SectionCard title="Global ClaimGuard engine" description="Managed schemes adopt validated model updates through audited prospective transitions."><GlobalDetectionEngineSettings organisations={organisations} /></SectionCard>
    </PageFrame>
  );
}
