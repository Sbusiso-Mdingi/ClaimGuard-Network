import React, { useState } from "react";
import { Link } from "react-router-dom";
import { useRole } from "../../context/RoleContext";
import { PageFrame, SectionCard } from "./InvestigatorUI";
import { Input } from "../../components/ui/input";
import { Button } from "../../components/ui/button";
import { listTrackedInvestigations, addTrackedInvestigation } from "../../lib/trackedInvestigations";

export function InvestigationsPage() {
  const { authHeaders, identity } = useRole();
  const [tracked, setTracked] = useState(() => listTrackedInvestigations());
  const [lookupId, setLookupId] = useState("");
  const [lookupError, setLookupError] = useState(null);
  const [checking, setChecking] = useState(false);

  async function handleOpenById(event) {
    event.preventDefault();
    if (!lookupId.trim()) return;
    setChecking(true);
    setLookupError(null);
    try {
      const response = await fetch(`/api/investigations/${encodeURIComponent(lookupId.trim())}`, { headers: authHeaders });
      const json = await response.json();
      if (!response.ok || !json.available) {
        setLookupError(json.message || "Investigation not found for the active tenant.");
        return;
      }
      addTrackedInvestigation(lookupId.trim());
      setTracked(listTrackedInvestigations());
      window.location.assign(`/investigations/${encodeURIComponent(lookupId.trim())}`);
    } catch {
      setLookupError("Could not reach the API.");
    } finally {
      setChecking(false);
    }
  }

  return (
    <PageFrame
      eyebrow="Investigations"
      title="Investigation workspace"
      description={`Investigations tracked in this browser for ${identity.label}. No backend endpoint currently lists all investigations for a tenant — this view tracks investigations you create or open by ID.`}
    >
      <SectionCard title="Open an investigation" description="Enter an investigation ID (returned when a claim is escalated) to open its workspace.">
        <form onSubmit={handleOpenById} className="flex flex-wrap gap-3">
          <Input value={lookupId} onChange={(e) => setLookupId(e.target.value)} placeholder="investigation-id" className="max-w-xs" />
          <Button type="submit" disabled={checking}>{checking ? "Checking..." : "Open"}</Button>
        </form>
        {lookupError && <p className="mt-2 text-sm text-destructive">{lookupError}</p>}
      </SectionCard>

      <SectionCard title="Tracked investigations" description="Investigations opened or created from this browser session.">
        {tracked.length === 0 ? (
          <p className="text-sm text-muted-foreground">No investigations tracked yet. Escalate a claim from Claims Explorer, or open one by ID above.</p>
        ) : (
          <div className="space-y-2">
            {tracked.map((id) => (
              <div key={id} className="flex items-center justify-between rounded-xl border border-border/70 bg-background/70 px-4 py-3">
                <span className="font-data text-sm">{id}</span>
                <Link to={`/investigations/${encodeURIComponent(id)}`} className="text-sm text-primary underline-offset-4 hover:underline">
                  Open workspace
                </Link>
              </div>
            ))}
          </div>
        )}
      </SectionCard>
    </PageFrame>
  );
}