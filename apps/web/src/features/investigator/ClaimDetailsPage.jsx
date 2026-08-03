import React, { useEffect, useMemo, useState } from "react";
import { useParams, Link } from "react-router-dom";
import { Progress } from "../../components/ui/progress";
import { Button } from "../../components/ui/button";
import { PageFrame, SectionCard, MetricPill, StatusIndicator, severityStatusTone } from "./InvestigatorUI";

import { useRole } from "../../context/RoleContext";
import { hasCapability } from "../../lib/capabilities";
import { addTrackedInvestigation } from "../../lib/trackedInvestigations";
import { apiRequest } from "../../lib/apiClient";

function severityFromScore(riskScore) {
  if (!Number.isFinite(riskScore)) return "Unknown";
  if (riskScore >= 75) return "High";
  if (riskScore >= 40) return "Medium";
  return "Low";
}

function mapClaimPayload(claim) {
  if (!claim) return null;
  const score = Number.isFinite(claim?.riskScore) ? claim.riskScore : null;
  const status = claim?.investigation?.status || claim?.status || "SUBMITTED";
  const detectionDate = claim?.detection?.scoredAt || claim?.updatedAt || claim?.submittedAt || null;
  return {
    claimId: claim?.claimId,
    schemeId: claim?.schemeId || null,
    memberId: claim?.memberId || null,
    providerId: claim?.providerId || null,
    member: claim?.member || { displayName: null },
    provider: claim?.provider || {
      displayName: null,
      practiceNumber: null,
      specialty: null,
      region: null,
    },
    policyHolder: claim?.member?.displayName || "Member unavailable",
    status,
    detectionDate,
    riskScore: score,
    severity: claim?.riskLevel || severityFromScore(score),
    triggeredRules: Array.isArray(claim?.triggeredRules) ? claim.triggeredRules : [],
    evidence: Array.isArray(claim?.evidence) ? claim.evidence : [],
    detection: claim?.detection || null,
    processing: claim?.processing || null,
    billedAmount: Number.isFinite(claim?.billedAmount) ? claim.billedAmount : null,
    billingCode: claim?.billingCode || null,
    currentClaimVersion: Number(claim?.currentClaimVersion || 1),
  };
}

function percentageLabel(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return null;
  const percentage = parsed >= 0 && parsed <= 1 ? parsed * 100 : parsed;
  return `${percentage.toFixed(2)}%`;
}

function rulePresentation(rule, claim) {
  const score = claim?.detection?.score || {};
  if (rule === "PROSPECTIVE_ML_REVIEW_RECOMMENDED") {
    const probability = percentageLabel(score.fraudProbability);
    const threshold = percentageLabel(score.threshold);
    return {
      label: "Fraud-risk review recommended",
      explanation: probability && threshold
        ? `The model-estimated risk of ${probability} met the configured ${threshold} review threshold. This recommends human review; it does not establish fraud.`
        : "The prospective model recommended human review. This screening outcome does not establish fraud.",
    };
  }
  if (rule === "MODEL_REVIEW_RECOMMENDED") {
    return {
      label: "Combined model review recommended",
      explanation: "The approved model ensemble recommended human review after combining its component signals.",
    };
  }
  if (rule === "BASELINE_FRAUD") {
    return {
      label: "Baseline model flagged fraud",
      explanation: "The baseline fraud classifier returned a fraud decision for this claim.",
    };
  }
  if (rule === "RING_REVIEW_HIT") {
    return {
      label: "Fraud-ring signal detected",
      explanation: "The provider/member relationship signal met the configured fraud-ring review threshold.",
    };
  }
  if (rule === "PHANTOM_REVIEW_HIT") {
    return {
      label: "Phantom-billing signal detected",
      explanation: "The phantom-billing model met the configured human-review threshold.",
    };
  }
  return {
    label: String(rule || "Review signal").replaceAll("_", " ").toLowerCase().replace(/^./, (character) => character.toUpperCase()),
    explanation: "This configured detection signal contributed to the claim review decision.",
  };
}

function RiskPanel({ claim, ledgerReference }) {
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
  const ruleDetails = (claim.triggeredRules || []).map((rule) => rulePresentation(rule, claim));
  const score = claim?.detection?.score || {};
  const modelProbability = percentageLabel(
    score.fraudProbability ?? score.baselineFraudProbability,
  );
  const modelThreshold = percentageLabel(
    score.threshold ?? score.baselineThreshold,
  );
  const inputDrift = claim?.detection?.inputDrift || null;
  const driftStatus = inputDrift?.status || "NOT_ASSESSED";
  const driftLabel = {
    IN_DISTRIBUTION: "No drift detected",
    WATCH: "Drift watch",
    OUT_OF_DISTRIBUTION: "Outside known inputs",
    PROFILE_UNAVAILABLE: "Profile unavailable",
    NOT_ASSESSED: "Not assessed",
  }[driftStatus] || driftStatus;
  const driftTone = driftStatus === "OUT_OF_DISTRIBUTION"
    ? "danger"
    : driftStatus === "WATCH" || driftStatus === "PROFILE_UNAVAILABLE"
      ? "warning"
      : driftStatus === "IN_DISTRIBUTION"
        ? "success"
        : "info";
  const driftSignals = Array.isArray(inputDrift?.signals) ? inputDrift.signals : [];
  const reviewDecision = score.reviewRecommended === true
    || claim.triggeredRules?.includes("PROSPECTIVE_ML_REVIEW_RECOMMENDED")
    || score.compositeReviewRecommended === true;

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
              {ruleDetails.length > 0
                ? ruleDetails.map((rule) => <StatusIndicator key={rule.label} variant="badge">{rule.label}</StatusIndicator>)
                : <span className="text-sm text-muted-foreground">No review rule was triggered.</span>}
            </div>
          </div>
          <div className="rounded-xl border border-border/70 px-4 py-3">
            <p className="text-xs uppercase tracking-[0.16em] text-muted-foreground">Ledger reference</p>
            <p className="mt-2 text-sm text-muted-foreground">{ledgerLabel}</p>
          </div>
        </div>

        <div className="rounded-xl border border-border/70 px-4 py-3">
          <p className="text-xs uppercase tracking-[0.16em] text-muted-foreground">Why this claim was flagged</p>
          <ul className="mt-2 space-y-2 text-sm leading-6 text-foreground">
            {(claim.evidence || []).length > 0
              ? claim.evidence.slice(0, 6).map((item) => <li key={item} className="rounded-lg bg-secondary/30 px-3 py-2">{item}</li>)
              : ruleDetails.map((rule) => <li key={rule.label} className="rounded-lg bg-secondary/30 px-3 py-2">{rule.explanation}</li>)}
          </ul>
        </div>

        <div className="rounded-xl border border-border/70 px-4 py-3">
          <p className="text-xs uppercase tracking-[0.16em] text-muted-foreground">Model assessment</p>
          <dl className="mt-3 grid gap-3 sm:grid-cols-2">
            <div><dt className="text-xs text-muted-foreground">Review outcome</dt><dd className="mt-1 font-medium">{reviewDecision ? "Human review recommended" : "No review recommended"}</dd></div>
            <div><dt className="text-xs text-muted-foreground">Model-estimated fraud risk</dt><dd className="mt-1 font-data font-medium">{modelProbability || "Not supplied"}</dd></div>
            <div><dt className="text-xs text-muted-foreground">Review threshold</dt><dd className="mt-1 font-data font-medium">{modelThreshold || "Not supplied"}</dd></div>
            <div><dt className="text-xs text-muted-foreground">Model</dt><dd className="mt-1 break-all font-data text-xs font-medium">{claim.detection?.modelDeploymentId || claim.detection?.modelId || "Configured rules"}</dd></div>
          </dl>
        </div>

        <div className="rounded-xl border border-border/70 px-4 py-3">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <p className="text-xs uppercase tracking-[0.16em] text-muted-foreground">Input drift check</p>
              <p className="mt-2 text-sm text-muted-foreground">
                {inputDrift?.message || "This score predates the current drift profile or was produced by a model without one."}
              </p>
            </div>
            <StatusIndicator tone={driftTone}>{driftLabel}</StatusIndicator>
          </div>
          {driftSignals.length > 0 ? (
            <ul className="mt-3 space-y-2">
              {driftSignals.slice(0, 6).map((signal, index) => (
                <li key={`${signal.feature}-${index}`} className="rounded-lg bg-secondary/30 px-3 py-2 text-xs leading-5">
                  <span className="font-semibold">{String(signal.feature || "Input").replaceAll("_", " ")}</span>
                  {": "}{signal.observed === null || signal.observed === undefined ? "missing" : String(signal.observed)}
                  <span className="text-muted-foreground"> · expected {signal.expected || "a known training value"}</span>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      </div>
    </SectionCard>
  );
}

export function ClaimDetailsPage({ report, graph }) {
  const params = useParams();
  const claimId = decodeURIComponent(params.claimId || "");

  const { identity } = useRole();
  const [escalateMessage, setEscalateMessage] = useState(null);
  const [claimState, setClaimState] = useState({
    status: "loading",
    claim: null,
    error: null,
  });
  const canEscalate = hasCapability(identity, "investigations.create");

  const { claim } = claimState;

  useEffect(() => {
    let cancelled = false;

    async function loadClaim() {
      setClaimState({ status: "loading", claim: null, error: null });
      try {
        const response = await apiRequest(`/claims/${encodeURIComponent(claimId)}`, { cache: "no-store" });
        const payload = await response.json().catch(() => null);
        if (cancelled) return;

        if (response.status === 404) {
          setClaimState({ status: "not-found", claim: null, error: payload?.message || "Claim not found." });
          return;
        }
        if (response.status === 403) {
          setClaimState({ status: "forbidden", claim: null, error: payload?.message || "You do not have access to this claim." });
          return;
        }
        if (!response.ok || !payload?.available) {
          setClaimState({ status: "error", claim: null, error: payload?.message || `Claim unavailable (${response.status}).` });
          return;
        }

        setClaimState({ status: "ready", claim: mapClaimPayload(payload.claim), error: null });
      } catch (error) {
        if (cancelled) return;
        setClaimState({
          status: "error",
          claim: null,
          error: error instanceof Error ? error.message : "Failed to load claim details.",
        });
      }
    }

    if (!claimId) {
      setClaimState({ status: "not-found", claim: null, error: "Claim not found." });
      return () => {
        cancelled = true;
      };
    }

    loadClaim();
    return () => {
      cancelled = true;
    };
  }, [claimId]);

  const related = useMemo(() => {
    const relationships = graph?.edges || [];
    const entities = graph?.nodes || [];
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
      const response = await apiRequest("/investigations", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "if-match": `W/\"claim-${claim?.currentClaimVersion || 1}\"`,
        },
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

  if (claimState.status === "loading") {
    return (
      <SectionCard title="Loading claim" description="Fetching authoritative claim details.">
        <p className="text-sm text-muted-foreground">Loading...</p>
      </SectionCard>
    );
  }

  if (claimState.status === "forbidden") {
    return (
      <SectionCard title="Access denied" description={claimState.error || "You do not have access to this claim."}>
        <Link to="/claims" className="text-sm text-primary underline-offset-4 hover:underline">Return to Claims Explorer</Link>
      </SectionCard>
    );
  }

  if (claimState.status === "error") {
    return (
      <SectionCard title="Claim unavailable" description={claimState.error || "Claim details are unavailable."}>
        <Link to="/claims" className="text-sm text-primary underline-offset-4 hover:underline">Return to Claims Explorer</Link>
      </SectionCard>
    );
  }

  if (!claim || claimState.status === "not-found") {
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
      description={`Member ${claim.policyHolder} · ${new Date(claim.detectionDate).toLocaleString()}`}
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
              <p className="text-xs uppercase tracking-[0.16em] text-muted-foreground">Member</p>
              <p className="mt-1 text-sm font-semibold">{claim.policyHolder}</p>
            </div>
            <div className="rounded-xl border border-border/70 px-4 py-3">
              <p className="text-xs uppercase tracking-[0.16em] text-muted-foreground">Provider</p>
              <p className="mt-1 text-sm font-semibold">{claim.provider?.displayName || "Provider unavailable"}</p>
              {[claim.provider?.specialty, claim.provider?.region].filter(Boolean).length > 0 ? (
                <p className="mt-1 text-xs text-muted-foreground">
                  {[claim.provider?.specialty, claim.provider?.region].filter(Boolean).join(" · ")}
                </p>
              ) : null}
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

          <details className="mt-4 rounded-xl border border-border/70">
            <summary className="cursor-pointer px-4 py-3 text-sm font-semibold">
              Technical identifiers
            </summary>
            <dl className="grid gap-3 border-t border-border/70 p-4 text-sm md:grid-cols-2">
              <div>
                <dt className="text-xs text-muted-foreground">Member token</dt>
                <dd className="mt-1 break-all font-data text-xs">{claim.memberId || "Not recorded"}</dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">Provider token</dt>
                <dd className="mt-1 break-all font-data text-xs">{claim.providerId || "Not recorded"}</dd>
              </div>
              {claim.provider?.practiceNumber ? (
                <div>
                  <dt className="text-xs text-muted-foreground">Practice number</dt>
                  <dd className="mt-1 font-data text-xs">{claim.provider.practiceNumber}</dd>
                </div>
              ) : null}
            </dl>
          </details>

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

        <RiskPanel claim={claim} ledgerReference={report?.detection?.ledger_reference} />
      </div>
    </PageFrame>
  );
}
