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

function buildReadyState(report, graph, risk, fetchedAt, previousSnapshots = []) {
  const claims = [];
  const snapshot = createSnapshot(report, graph, risk, fetchedAt, claims);

  return {
    status: "ready",
    report,
    graph,
    risk,
    claims,
    snapshots: [snapshot, ...(previousSnapshots || [])].slice(0, 25),
    lastRefresh: fetchedAt,
    error: null,
  };
}

export function useInvestigatorData({ enabled = true } = {}) {
  const [liveRefreshEnabled, setLiveRefreshEnabled] = useState(true);
  const [simulatorState, setSimulatorState] = useState({
    status: "loading",
    simulator: null,
    error: null,
    controlPending: false,
  });
  const [state, setState] = useState({
    status: "loading",
    report: null,
    graph: null,
    risk: null,
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

    try {
      const [reportRes, graphRes, riskRes, claimsRes] = await Promise.all([
        apiRequest("/detection/report", { cache: "no-store" }),
        apiRequest("/detection/graph", { cache: "no-store" }),
        apiRequest("/detection/risk", { cache: "no-store" }),
        apiRequest("/claims", { cache: "no-store" }),
      ]);

      const [reportPayload, graphPayload, riskPayload, claimsPayload] = await Promise.all([
        reportRes.json(),
        graphRes.json(),
        riskRes.json(),
        claimsRes.json(),
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

      const claimsReady = claimsRes.ok && claimsPayload?.available === true;
      const claims = claimsReady
        ? (claimsPayload.claims || []).map(mapApiClaimToView).filter((claim) => Boolean(claim.claimId))
        : [];

      setState((prev) => ({
        ...buildReadyState(reportPayload.report, graphPayload.graph, riskPayload.risk, fetchedAt, prev.snapshots),
        claims,
        claimsStatus: claimsReady ? "ready" : "error",
        claimsError: claimsReady
          ? null
          : claimsPayload?.message || `Claims unavailable (${claimsRes.status})`,
        claimsPagination: claimsReady ? claimsPayload.pagination || null : null,
        dataSource: "live",
      }));
    } catch (error) {
      setState((previous) => ({
        ...previous,
        status: "error",
        error: error instanceof Error ? error.message : "Failed to load investigator data.",
        dataSource: "unavailable",
        lastRefresh: fetchedAt,
      }));
    }
  }, []);

  const loadSimulatorStatus = useCallback(async () => {
    try {
      const response = await apiRequest("/simulator/status", { cache: "no-store" });
      const payload = await response.json();
      if (!response.ok || !payload.available || !payload.simulator) {
        throw new Error(payload.message || `Simulator status unavailable (${response.status})`);
      }
      setSimulatorState((previous) => ({ ...previous, status: "ready", simulator: payload.simulator, error: null }));
    } catch (error) {
      setSimulatorState((previous) => ({
        ...previous,
        status: "error",
        error: error instanceof Error ? error.message : "Simulator status unavailable.",
      }));
    }
  }, []);

  const sendSimulatorCommand = useCallback(async (action, payload = null) => {
    setSimulatorState((previous) => ({ ...previous, controlPending: true, error: null }));
    try {
      const response = await apiRequest(`/simulator/${action}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: payload ? JSON.stringify(payload) : undefined,
      });
      const result = await response.json();
      if (!response.ok || !result.available) {
        throw new Error(result.message || `Simulator command failed (${response.status})`);
      }
      setSimulatorState({ status: "ready", simulator: result.simulator, error: null, controlPending: false });
      return true;
    } catch (error) {
      setSimulatorState((previous) => ({
        ...previous,
        status: "error",
        error: error instanceof Error ? error.message : "Simulator command failed.",
        controlPending: false,
      }));
      return false;
    }
  }, []);

  useEffect(() => {
    if (!enabled) {
      setState((previous) => ({ ...previous, status: "ready", error: null }));
      setSimulatorState((previous) => ({ ...previous, status: "ready", error: null }));
      return;
    }
    load();
    loadSimulatorStatus();
  }, [enabled, load, loadSimulatorStatus]);

  useEffect(() => {
    if (!enabled || !liveRefreshEnabled) return undefined;
    const id = window.setInterval(() => {
      load();
      loadSimulatorStatus();
    }, POLL_INTERVAL_MS);
    return () => window.clearInterval(id);
  }, [enabled, liveRefreshEnabled, load, loadSimulatorStatus]);

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
      .slice(0, 8);

    return {
      totalClaims: Number.isFinite(report?.summary?.totalClaims) ? report.summary.totalClaims : "Unavailable",
      highRiskClaims: highRisk,
      averageRiskScore: avgRisk,
      activeFraudSchemes,
      recentDetections,
      ledgerStatus: isLedgerLinked(report?.ledgerReference) ? "Connected" : "Unavailable",
    };
  }, [state.report, state.claims, state.risk]);

  return {
    ...state,
    mode: liveRefreshEnabled ? "live" : "static",
    liveRefreshEnabled,
    setLiveRefreshEnabled,
    simulatorState,
    loadSimulatorStatus,
    sendSimulatorCommand,
    metrics,
    pollingIntervalMs: POLL_INTERVAL_MS,
    setMode: (mode) => setLiveRefreshEnabled(mode === "live"),
    refreshNow: async () => {
      await Promise.all([load(), loadSimulatorStatus()]);
    },
  };
}
