import { useCallback, useEffect, useMemo, useState } from "react";
import { apiRequest } from "../lib/apiClient";

const POLL_INTERVAL_MS = 15000;

function isLedgerLinked(ledgerReference) {
  if (!ledgerReference || typeof ledgerReference !== "object") {
    return false;
  }

  if (ledgerReference.available === true || ledgerReference.linked === true || ledgerReference.configured === true) {
    return true;
  }

  if (
    ledgerReference.type === "runtime-ledger" &&
    typeof ledgerReference.message === "string" &&
    /no\s+.*entries\s+exist\s+yet/i.test(ledgerReference.message)
  ) {
    return true;
  }

  return false;
}

function severityFromScore(riskScore) {
  if (!Number.isFinite(riskScore)) return "Unknown";
  if (riskScore >= 75) return "High";
  if (riskScore >= 40) return "Medium";
  return "Low";
}

function mapApiClaimToView(claim) {
  const score = Number.isFinite(claim?.riskScore) ? claim.riskScore : null;
  const status = claim?.investigation?.status || claim?.status || "SUBMITTED";
  return {
    claimId: claim?.claimId,
    schemeId: claim?.schemeId || null,
    memberId: claim?.memberId || null,
    providerId: claim?.providerId || null,
    policyHolder: claim?.memberId || "Unknown",
    status,
    detectionDate: claim?.updatedAt || claim?.submittedAt || null,
    riskScore: score,
    severity: claim?.riskLevel || severityFromScore(score),
    triggeredRules: Array.isArray(claim?.triggeredRules) ? claim.triggeredRules : [],
    evidence: Array.isArray(claim?.evidence) ? claim.evidence : [],
  };
}

function createSnapshot(report, graph, risk, fetchedAt, claims) {
  const backendRiskScore = Number.isFinite(risk?.riskScore) ? risk.riskScore : null;
  const backendHighRiskClaims = Number.isFinite(risk?.highRiskClaims) ? risk.highRiskClaims : null;

  return {
    id: `${fetchedAt}-${claims.length}`,
    timestamp: fetchedAt,
    totalClaims: Number.isFinite(report?.summary?.totalClaims) ? report.summary.totalClaims : null,
    highRiskClaims: Number.isFinite(report?.summary?.highRiskClaims) ? report.summary.highRiskClaims : backendHighRiskClaims,
    avgRisk: Number.isFinite(report?.summary?.averageRiskScore) ? report.summary.averageRiskScore : backendRiskScore,
    schemes: new Set(claims.map((claim) => claim.schemeId)).size,
    risk,
    graphSummary: graph?.summary || null,
  };
}

async function fetchAvailableResource(path, key, label) {
  const response = await apiRequest(path, { cache: "no-store" });
  const payload = await response.json().catch(() => null);
  if (!response.ok || payload?.available !== true) {
    throw new Error(payload?.message || `${label} unavailable (${response.status})`);
  }
  return payload[key];
}

async function fetchClaims() {
  const response = await apiRequest("/claims", { cache: "no-store" });
  const payload = await response.json().catch(() => null);
  if (!response.ok || payload?.available !== true) {
    throw new Error(payload?.message || `Claims unavailable (${response.status})`);
  }
  return {
    claims: (payload.claims || []).map(mapApiClaimToView).filter((claim) => Boolean(claim.claimId)),
    pagination: payload.pagination || null,
  };
}

function settledResource(result, previousValue) {
  if (result.status === "fulfilled") {
    return { value: result.value, status: "ready", error: null };
  }
  return {
    value: previousValue,
    status: "error",
    error: result.reason instanceof Error ? result.reason.message : "Resource unavailable.",
  };
}

export function useInvestigatorData({ enabled = true } = {}) {
  const [liveRefreshEnabled, setLiveRefreshEnabled] = useState(true);
  const [state, setState] = useState({
    status: "loading",
    report: null,
    reportStatus: "loading",
    reportError: null,
    graph: null,
    graphStatus: "loading",
    graphError: null,
    risk: null,
    riskStatus: "loading",
    riskError: null,
    claims: [],
    claimsStatus: "loading",
    claimsError: null,
    claimsPagination: null,
    snapshots: [],
    lastRefresh: null,
    error: null,
    dataSource: "live",
  });

  const load = useCallback(async () => {
    const fetchedAt = new Date().toISOString();

    setState((previous) => ({
      ...previous,
      status: previous.lastRefresh ? "ready" : "loading",
      reportStatus: "loading",
      reportError: null,
      graphStatus: "loading",
      graphError: null,
      riskStatus: "loading",
      riskError: null,
      claimsStatus: "loading",
      claimsError: null,
      error: null,
    }));

    const [reportResult, graphResult, riskResult, claimsResult] = await Promise.allSettled([
      fetchAvailableResource("/detection/report", "report", "Report"),
      fetchAvailableResource("/detection/graph", "graph", "Graph"),
      fetchAvailableResource("/detection/risk", "risk", "Risk"),
      fetchClaims(),
    ]);

    setState((previous) => {
      const reportResource = settledResource(reportResult, previous.report);
      const graphResource = settledResource(graphResult, previous.graph);
      const riskResource = settledResource(riskResult, previous.risk);
      const claimsResource = settledResource(claimsResult, {
        claims: previous.claims,
        pagination: previous.claimsPagination,
      });
      const claims = claimsResource.value?.claims || [];
      const pagination = claimsResource.value?.pagination || null;
      const successfulResources = [reportResult, graphResult, riskResult, claimsResult]
        .filter((result) => result.status === "fulfilled").length;
      const report = reportResource.value;
      const graph = graphResource.value;
      const risk = riskResource.value;
      const snapshots = reportResult.status === "fulfilled"
        ? [createSnapshot(report, graph, risk, fetchedAt, claims), ...(previous.snapshots || [])].slice(0, 25)
        : previous.snapshots;

      return {
        ...previous,
        status: "ready",
        report,
        reportStatus: reportResource.status,
        reportError: reportResource.error,
        graph,
        graphStatus: graphResource.status,
        graphError: graphResource.error,
        risk,
        riskStatus: riskResource.status,
        riskError: riskResource.error,
        claims,
        claimsStatus: claimsResource.status,
        claimsError: claimsResource.error,
        claimsPagination: pagination,
        snapshots,
        lastRefresh: fetchedAt,
        error: successfulResources === 0 ? "All investigator data resources are unavailable." : null,
        dataSource: successfulResources > 0 ? "live" : "unavailable",
      };
    });
  }, []);

  useEffect(() => {
    if (!enabled) {
      setState((previous) => ({
        ...previous,
        status: "ready",
        reportStatus: "idle",
        graphStatus: "idle",
        riskStatus: "idle",
        claimsStatus: "idle",
        error: null,
      }));
      return;
    }
    load();
  }, [enabled, load]);

  useEffect(() => {
    if (!enabled || !liveRefreshEnabled) return undefined;
    const id = window.setInterval(() => {
      load();
    }, POLL_INTERVAL_MS);
    return () => window.clearInterval(id);
  }, [enabled, liveRefreshEnabled, load]);

  const metrics = useMemo(() => {
    const { report, claims } = state;
    const highRisk = Number.isFinite(report?.summary?.highRiskClaims)
      ? report.summary.highRiskClaims
      : "Unavailable";
    const avgRisk = Number.isFinite(report?.summary?.averageRiskScore)
      ? report.summary.averageRiskScore
      : "Unavailable";

    const activeFraudSchemes = Number.isFinite(report?.summary?.activeFraudPatterns)
      ? report.summary.activeFraudPatterns
      : "Unavailable";

    const recentDetections = claims
      .slice()
      .sort((a, b) => {
        const riskDiff = (b.riskScore || 0) - (a.riskScore || 0);
        if (riskDiff !== 0) return riskDiff;
        const dateA = a.detectionDate ? new Date(a.detectionDate).getTime() : 0;
        const dateB = b.detectionDate ? new Date(b.detectionDate).getTime() : 0;
        return dateB - dateA;
      })
      .slice(0, 8);

    return {
      totalClaims: Number.isFinite(report?.summary?.totalClaims) ? report.summary.totalClaims : "Unavailable",
      highRiskClaims: highRisk,
      averageRiskScore: avgRisk,
      activeFraudSchemes,
      recentDetections,
      allClaims: claims,
      ledgerStatus: isLedgerLinked(report?.ledgerReference) ? "Connected" : "Unavailable",
    };
  }, [state.report, state.claims]);

  return {
    ...state,
    mode: liveRefreshEnabled ? "live" : "static",
    liveRefreshEnabled,
    setLiveRefreshEnabled,
    metrics,
    pollingIntervalMs: POLL_INTERVAL_MS,
    setMode: (mode) => setLiveRefreshEnabled(mode === "live"),
    refreshNow: load,
  };
}
