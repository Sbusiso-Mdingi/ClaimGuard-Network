import { useCallback, useEffect, useMemo, useState } from "react";
import { useRole } from "../context/RoleContext";

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

function extractClaimRows(report) {
  return (report?.claims || []).map((claim) => ({
    ...claim,
    policyHolder: claim.memberId,
    status: claim.processingStatus ?? "Unavailable",
    detectionDate: report?.metadata?.generatedAt ?? null,
    triggeredRules: (claim.ruleHits || []).map((rule) => rule.title),
    evidence: claim.evidenceReferences || [],
  }));
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
  const claims = extractClaimRows(report);
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

export function useInvestigatorData() {
  const { authHeaders } = useRole();
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
    snapshots: [],
    lastRefresh: null,
    error: null,
    dataSource: "live",
  });

  const load = useCallback(async () => {
    const fetchedAt = new Date().toISOString();

    try {
      const [reportRes, graphRes, riskRes] = await Promise.all([
        fetch("/api/detection/report", { cache: "no-store", headers: authHeaders }),
        fetch("/api/detection/graph", { cache: "no-store", headers: authHeaders }),
        fetch("/api/detection/risk", { cache: "no-store", headers: authHeaders }),
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

      setState((prev) => ({
        ...buildReadyState(reportPayload.report, graphPayload.graph, riskPayload.risk, fetchedAt, prev.snapshots),
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
  }, [authHeaders]);

  const loadSimulatorStatus = useCallback(async () => {
    try {
      const response = await fetch("/api/simulator/status", { cache: "no-store", headers: authHeaders });
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
  }, [authHeaders]);

  const sendSimulatorCommand = useCallback(async (action, payload = null) => {
    setSimulatorState((previous) => ({ ...previous, controlPending: true, error: null }));
    try {
      const response = await fetch(`/api/simulator/${action}`, {
        method: "POST",
        headers: { ...authHeaders, "content-type": "application/json" },
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
  }, [authHeaders]);

  useEffect(() => {
    load();
    loadSimulatorStatus();
  }, [load, loadSimulatorStatus]);

  useEffect(() => {
    if (!liveRefreshEnabled) return undefined;
    const id = window.setInterval(() => {
      load();
      loadSimulatorStatus();
    }, POLL_INTERVAL_MS);
    return () => window.clearInterval(id);
  }, [liveRefreshEnabled, load, loadSimulatorStatus]);

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
