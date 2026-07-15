import React, { useMemo, useState } from "react";
import { useParams, Link } from "react-router-dom";
import { Progress } from "../../components/ui/progress";
import { Button } from "../../components/ui/button";
import { PageFrame, SectionCard, MetricPill, StatusIndicator, severityStatusTone } from "./InvestigatorUI";

import { useRole } from "../../context/RoleContext";
import { CLAIMGUARD_ROLES } from "../../lib/claimguardRoles";
import { addTrackedInvestigation } from "../../lib/trackedInvestigations";

function RiskPanel({ claim, risk, ledgerReference }) {
  const ledgerLinked =
    ledgerReference?.available === true ||
    ledgerReference?.linked === true ||
    ledgerReference?.configured === true ||
    (ledgerReference?.type === "runtime-ledger" &&
      typeof ledgerReference?.message === "string" &&
      /no\s+.*entries\s+exist\s+yet/i.test(ledgerReference.message));

  const ledgerLabel = ledgerLinked
    ? `Connected (${ledgerReference?.entry?.entryType || "no entries yet"})`
    : "Unavailable";

  return (
    <SectionCard title="Risk summary" description="Explainability, triggered rules, evidence, and ledger linkage for the selected claim.">
      <div className="space-y-5 text-sm">
        <div className="rounded-2xl border border-border/70 bg-secondary/30 p-4">
          <div className="flex items-center justify-between gap-3">
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.16em] text-muted-foreground">Risk score</p>
              <p className="font-data mt-1 text-4xl font-semibold tracking-tight">{Number.isFinite(claim.riskScore) ? claim.riskScore : "Unavailable"}</p>
            </div>
            <StatusIndicator tone={severityStatusTone(claim.severity)}>{claim.severity}</StatusIndicator>
          </div>
          <Progress value={Number.isFinite(claim.riskScore) ? claim.riskScore : 0} className="mt-4 h-2" />
        </div>

        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-1">
          <div className="rounded-xl border border-border/70 px-4 py-3">
            <p className="text-xs uppercase tracking-[0.16em] text-muted-foreground">Triggered rules</p>
            <div className="mt-2 flex flex-wrap gap-2">
              {(claim.triggeredRules || []).map((rule) => <StatusIndicator key={rule} variant="badge">{rule}</StatusIndicator>)}
            </div>
          </div>
          <div className="rounded-xl border border-border/70 px-4 py-3">
            <p className="text-xs uppercase tracking-[0.16em] text-muted-foreground">Ledger reference</p>
            <p className="mt-2 text-sm text-muted-foreground">{ledgerLabel}</p>
          </div>
        </div>

        <div className="rounded-xl border border-border/70 px-4 py-3">
          <p className="text-xs uppercase tracking-[0.16em] text-muted-foreground">Evidence</p>
          <ul className="mt-2 space-y-2 text-sm leading-6 text-foreground">
            {(claim.evidence || []).slice(0, 6).map((item) => <li key={item} className="rounded-lg bg-secondary/30 px-3 py-2">{item}</li>)}
          </ul>
        </div>

        <div className="rounded-xl border border-border/70 px-4 py-3">
          <p className="text-xs uppercase tracking-[0.16em] text-muted-foreground">Global risk explanation</p>
          <ul className="mt-2 space-y-2 text-sm leading-6 text-foreground">
            {(risk?.reasons || []).slice(0, 4).map((item) => <li key={item} className="rounded-lg bg-secondary/30 px-3 py-2">{item}</li>)}
          </ul>
        </div>
      </div>
    </SectionCard>
  );
}

export function ClaimDetailsPage({ claims, report, graph, risk }) {
  const params = useParams();
  const claimId = decodeURIComponent(params.claimId || "");

  const { authHeaders, identity } = useRole();
  const [escalateMessage, setEscalateMessage] = useState(null);
  const canEscalate = [CLAIMGUARD_ROLES.FRAUD_ANALYST, CLAIMGUARD_ROLES.INVESTIGATOR].includes(identity.role);

  const claim = claims.find((row) => row.claimId === claimId);

  const related = useMemo(() => {
    const relationships = graph?.relationships || report?.detection?.relationships || [];
    const entities = graph?.entities || report?.detection?.entities || [];
    const entityMap = new Map(entities.map((entity) => [entity.entity_id, entity]));
    const claimRelationships = relationships.filter((rel) => rel.claim_id === claimId);
    const entityIds = new Set();
    claimRelationships.forEach((rel) => {
      entityIds.add(rel.source_entity_id);
      entityIds.add(rel.target_entity_id);
    });

    return {
      claimRelationships,
      entities: Array.from(entityIds).map((entityId) => entityMap.get(entityId)).filter(Boolean),
    };
  }, [claimId, graph, report]);

  async function handleEscalate() {
    setEscalateMessage(null);
    try {
      const response = await fetch("/api/investigations", {
        method: "POST",
        headers: { "content-type": "application/json", ...authHeaders },
        body: JSON.stringify({ claimId: claim?.claimId }),
      });
      const json = await response.json();
      if (!response.ok || !json.available) {
        setEscalateMessage({ tone: "error", text: json.message || "Escalation failed." });
        return;
      }
      addTrackedInvestigation(json.investigation.investigationId);
      setEscalateMessage({ tone: "success", text: `Escalated as ${json.investigation.investigationId}.` });
    } catch (error) {
      setEscalateMessage({ tone: "error", text: error.message || "Request failed." });
    }
  }

  if (!claim) {
    return (
      <SectionCard title="Claim not found" description="The selected claim is not available in the current snapshot.">
        <Link to="/claims" className="text-sm text-primary underline-offset-4 hover:underline">Return to Claims Explorer</Link>
      </SectionCard>
    );
  }

  return (
    <PageFrame
      eyebrow="Claim Details"
      title={claim.claimId}
      description={`Policy holder ${claim.policyHolder} · ${new Date(claim.detectionDate).toLocaleString()}`}
      actions={[
        <MetricPill key="status" label="Status" value={claim.status} tone={claim.status === "CONFIRMED_FRAUD" ? "danger" : claim.status === "UNDER_INVESTIGATION" ? "warning" : "default"} />,
        <MetricPill key="rules" label="Rules" value={`${(claim.triggeredRules || []).length}`} />,
        canEscalate && (
          <Button key="escalate" size="sm" onClick={handleEscalate} className="rounded-full">
            Escalate to investigation
          </Button>
        )
      ].filter(Boolean)}
    >
      {escalateMessage && (
        <div
          className={`mb-5 rounded-xl border p-4 text-sm ${
            escalateMessage.tone === "success"
              ? "border-emerald-500/20 bg-emerald-500/10 text-emerald-400"
              : "border-destructive/20 bg-destructive/10 text-destructive"
          }`}
        >
          {escalateMessage.text}
        </div>
      )}

      <div className="grid gap-4 xl:grid-cols-[1.6fr_0.95fr]">
        <SectionCard title="Claim information" description="A compact summary of the selected claim, claimant, and current review state.">
          <div className="grid gap-3 md:grid-cols-2">
            <div className="rounded-xl border border-border/70 px-4 py-3">
              <p className="text-xs uppercase tracking-[0.16em] text-muted-foreground">Claim ID</p>
              <p className="font-data mt-1 text-sm font-semibold">{claim.claimId}</p>
            </div>
            <div className="rounded-xl border border-border/70 px-4 py-3">
              <p className="text-xs uppercase tracking-[0.16em] text-muted-foreground">Policy holder</p>
              <p className="mt-1 text-sm font-semibold">{claim.policyHolder}</p>
            </div>
            <div className="rounded-xl border border-border/70 px-4 py-3">
              <p className="text-xs uppercase tracking-[0.16em] text-muted-foreground">Risk score</p>
              <p className="mt-1 text-sm font-semibold">{claim.riskScore}</p>
            </div>
            <div className="rounded-xl border border-border/70 px-4 py-3">
              <p className="text-xs uppercase tracking-[0.16em] text-muted-foreground">Severity</p>
              <p className="mt-1 text-sm font-semibold">{claim.severity}</p>
            </div>
          </div>

          <div className="mt-4 grid gap-4 lg:grid-cols-2">
            <div className="rounded-xl border border-border/70 p-4">
              <h3 className="text-sm font-semibold">Entities</h3>
              {related.entities.length === 0 ? (
                <p className="mt-2 text-sm text-muted-foreground">No entities found for this claim.</p>
              ) : (
                <div className="mt-3 space-y-2">
                  {related.entities.map((entity) => (
                    <div key={entity.entity_id} className="rounded-lg border border-border/70 bg-secondary/30 px-3 py-3">
                      <p className="text-sm font-medium">{entity.entity_id}</p>
                      <p className="text-xs text-muted-foreground">{entity.entity_type} · {entity.value || "n/a"}</p>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div className="rounded-xl border border-border/70 p-4">
              <h3 className="text-sm font-semibold">Relationships</h3>
              {related.claimRelationships.length === 0 ? (
                <p className="mt-2 text-sm text-muted-foreground">No relationships found for this claim.</p>
              ) : (
                <div className="mt-3 space-y-2">
                  {related.claimRelationships.map((rel, idx) => (
                    <div key={`${rel.source_entity_id}-${rel.target_entity_id}-${idx}`} className="rounded-lg border border-border/70 bg-secondary/30 px-3 py-3 text-xs leading-5">
                      {rel.source_entity_id} → {rel.target_entity_id} ({rel.relationship_type})
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </SectionCard>

        <RiskPanel claim={claim} risk={risk} ledgerReference={report?.detection?.ledger_reference} />
      </div>
    </PageFrame>
  );
}