import { useCallback, useEffect, useMemo, useState } from "react";

const POLL_INTERVAL_MS = 15000;

function selectClaimantForClaim(relationships, claimId) {
  const row = relationships.find((rel) => rel.claim_id === claimId && String(rel.source_entity_id).startsWith("claimant:"));
  return row?.source_entity_id?.replace("claimant:", "") || "Unknown";
}

function extractClaimRows(report, riskResponse, fetchedAt) {
  const relationships = report?.detection?.relationships || [];
  const claimIds = Array.from(new Set(relationships.map((rel) => rel.claim_id).filter(Boolean))).sort();
  const backendRiskScore = Number.isFinite(riskResponse?.riskScore)
    ? riskResponse.riskScore
    : Number.isFinite(report?.detection?.risk_score?.riskScore)
      ? report.detection.risk_score.riskScore
      : null;
  const backendSeverity =
    typeof riskResponse?.severity === "string"
      ? riskResponse.severity
      : typeof report?.detection?.risk_score?.severity === "string"
        ? report.detection.risk_score.severity
        : null;
  const triggeredRules = (report?.detection?.triggered_rules || []).map((rule) => rule.title);
  const evidence = report?.detection?.evidence || [];

  return claimIds.map((claimId) => {
    const claimant = selectClaimantForClaim(relationships, claimId);

    return {
      claimId,
      riskScore: backendRiskScore,
      severity: backendSeverity || "Unavailable",
      status: riskResponse?.status || "Unavailable",
      policyHolder: claimant,
      detectionDate: fetchedAt,
      triggeredRules,
      evidence,
    };
  });
}

function createSnapshot(report, graph, risk, fetchedAt, claims) {
  const backendRiskScore = Number.isFinite(risk?.riskScore)
    ? risk.riskScore
    : Number.isFinite(report?.detection?.risk_score?.riskScore)
      ? report.detection.risk_score.riskScore
      : null;
  const backendHighRiskClaims = Number.isFinite(risk?.highRiskClaims)
    ? risk.highRiskClaims
    : Number.isFinite(report?.detection?.risk_score?.highRiskClaims)
      ? report.detection.risk_score.highRiskClaims
      : null;

  return {
    id: `${fetchedAt}-${claims.length}`,
    timestamp: fetchedAt,
    totalClaims: claims.length,
    highRiskClaims: backendHighRiskClaims,
    avgRisk: backendRiskScore,
    schemes: (report?.schemes || []).length,
    risk,
    graphSummary: graph?.summary || null,
  };
}

export function useInvestigatorData() {
  const [mode, setMode] = useState("live");
  const [state, setState] = useState({
    status: "loading",
    report: null,
    graph: null,
    risk: null,
    claims: [],
    snapshots: [],
    lastRefresh: null,
    error: null,
  });

  const load = useCallback(async () => {
    try {
      const [reportRes, graphRes, riskRes] = await Promise.all([
        fetch("/api/detection/report", { cache: "no-store" }),
        fetch("/api/detection/graph", { cache: "no-store" }),
        fetch("/api/detection/risk", { cache: "no-store" }),
      ]);

      const [reportPayload, graphPayload, riskPayload] = await Promise.all([
        reportRes.json(),
        graphRes.json(),
        riskRes.json(),
      ]);

      if (!reportRes.ok || !reportPayload.available) {
        throw new Error(reportPayload.message || `Report unavailable (${reportRes.status})`);
      }
      if (!graphRes.ok || !graphPayload.available) {
        throw new Error(graphPayload.message || `Graph unavailable (${graphRes.status})`);
      }
      if (!riskRes.ok || !riskPayload.available) {
        throw new Error(riskPayload.message || `Risk unavailable (${riskRes.status})`);
      }

      const fetchedAt = new Date().toISOString();
      const claims = extractClaimRows(reportPayload.report, riskPayload.risk, fetchedAt);
      const snapshot = createSnapshot(reportPayload.report, graphPayload.graph, riskPayload.risk, fetchedAt, claims);

      setState((prev) => ({
        status: "ready",
        report: reportPayload.report,
        graph: graphPayload.graph,
        risk: riskPayload.risk,
        claims,
        snapshots: [snapshot, ...(prev.snapshots || [])].slice(0, 25),
        lastRefresh: fetchedAt,
        error: null,
      }));
    } catch (error) {
      setState((prev) => ({
        ...prev,
        status: prev.report ? "ready" : "error",
        error: error instanceof Error ? error.message : "Failed to load investigator data.",
      }));
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    if (mode !== "live") return undefined;
    const id = window.setInterval(() => {
      load();
    }, POLL_INTERVAL_MS);
    return () => window.clearInterval(id);
  }, [mode, load]);

  const metrics = useMemo(() => {
    const report = state.report;
    const claims = state.claims;
    const highRisk = Number.isFinite(state.risk?.highRiskClaims)
      ? state.risk.highRiskClaims
      : Number.isFinite(report?.detection?.risk_score?.highRiskClaims)
        ? report.detection.risk_score.highRiskClaims
        : "Unavailable";
    const avgRisk = Number.isFinite(state.risk?.riskScore)
      ? state.risk.riskScore
      : Number.isFinite(report?.detection?.risk_score?.riskScore)
        ? report.detection.risk_score.riskScore
        : "Unavailable";

    const activeFraudSchemes = Number.isFinite(report?.detection?.risk_score?.activeFraudSchemes)
      ? report.detection.risk_score.activeFraudSchemes
      : "Unavailable";

    const recentDetections = claims
      .slice()
      .slice(0, 8);

    return {
      totalClaims: claims.length,
      highRiskClaims: highRisk,
      averageRiskScore: avgRisk,
      activeFraudSchemes,
      recentDetections,
      ledgerStatus: report?.detection?.ledger_reference?.available ? "Connected" : "Not linked",
    };
  }, [state.report, state.claims, state.risk]);

  return {
    ...state,
    mode,
    metrics,
    pollingIntervalMs: POLL_INTERVAL_MS,
    setMode,
    refreshNow: load,
  };
}
