import React, { useMemo } from "react";
import { useParams, Link } from "react-router-dom";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../../components/ui/card";
import { Badge } from "../../components/ui/badge";

function RiskPanel({ claim, risk, ledgerReference }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Risk Panel</CardTitle>
        <CardDescription>Explainability and contributing detection evidence.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        <div className="flex items-center justify-between">
          <span>Risk score</span>
          <span className="font-semibold">{Number.isFinite(claim.riskScore) ? claim.riskScore : "Unavailable"}</span>
        </div>
        <div className="flex items-center justify-between">
          <span>Severity</span>
          <Badge variant={claim.severity === "High" ? "destructive" : claim.severity === "Medium" ? "warning" : "secondary"}>{claim.severity}</Badge>
        </div>
        <div>
          <p className="mb-1 text-xs uppercase text-muted-foreground">Triggered rules</p>
          <ul className="list-disc space-y-1 pl-5">
            {(claim.triggeredRules || []).map((rule) => <li key={rule}>{rule}</li>)}
          </ul>
        </div>
        <div>
          <p className="mb-1 text-xs uppercase text-muted-foreground">Evidence</p>
          <ul className="list-disc space-y-1 pl-5">
            {(claim.evidence || []).slice(0, 6).map((item) => <li key={item}>{item}</li>)}
          </ul>
        </div>
        <div>
          <p className="mb-1 text-xs uppercase text-muted-foreground">Global risk explanation</p>
          <ul className="list-disc space-y-1 pl-5">
            {(risk?.reasons || []).slice(0, 4).map((item) => <li key={item}>{item}</li>)}
          </ul>
        </div>
        <div>
          <p className="mb-1 text-xs uppercase text-muted-foreground">Ledger reference</p>
          <p className="text-xs text-muted-foreground">{ledgerReference?.available ? `Connected (${ledgerReference.entry?.entryType || "entry"})` : "Unavailable"}</p>
        </div>
      </CardContent>
    </Card>
  );
}

export function ClaimDetailsPage({ claims, report, graph, risk }) {
  const params = useParams();
  const claimId = decodeURIComponent(params.claimId || "");

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

  if (!claim) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Claim not found</CardTitle>
          <CardDescription>The selected claim is not available in the current snapshot.</CardDescription>
        </CardHeader>
        <CardContent>
          <Link to="/claims" className="text-sm text-primary underline-offset-4 hover:underline">Return to Claims Explorer</Link>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="grid gap-4 xl:grid-cols-[2fr_1fr]">
      <Card>
        <CardHeader>
          <CardTitle>Claim Details · {claim.claimId}</CardTitle>
          <CardDescription>Policy holder {claim.policyHolder} · {new Date(claim.detectionDate).toLocaleString()}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4 text-sm">
          <div className="grid gap-2 md:grid-cols-2">
            <div><span className="text-muted-foreground">Status:</span> {claim.status}</div>
            <div><span className="text-muted-foreground">Risk score:</span> {claim.riskScore}</div>
            <div><span className="text-muted-foreground">Severity:</span> {claim.severity}</div>
            <div><span className="text-muted-foreground">Rules:</span> {(claim.triggeredRules || []).length}</div>
          </div>

          <div>
            <h3 className="mb-2 font-semibold">Entities</h3>
            {related.entities.length === 0 ? (
              <p className="text-muted-foreground">No entities found for this claim.</p>
            ) : (
              <div className="space-y-2">
                {related.entities.map((entity) => (
                  <div key={entity.entity_id} className="rounded-md border border-border p-2">
                    <p className="font-medium">{entity.entity_id}</p>
                    <p className="text-xs text-muted-foreground">{entity.entity_type} · {entity.value || "n/a"}</p>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div>
            <h3 className="mb-2 font-semibold">Relationships</h3>
            {related.claimRelationships.length === 0 ? (
              <p className="text-muted-foreground">No relationships found for this claim.</p>
            ) : (
              <div className="space-y-2">
                {related.claimRelationships.map((rel, idx) => (
                  <div key={`${rel.source_entity_id}-${rel.target_entity_id}-${idx}`} className="rounded-md border border-border p-2 text-xs">
                    {rel.source_entity_id} → {rel.target_entity_id} ({rel.relationship_type})
                  </div>
                ))}
              </div>
            )}
          </div>
        </CardContent>
      </Card>

      <RiskPanel claim={claim} risk={risk} ledgerReference={report?.detection?.ledger_reference} />
    </div>
  );
}
