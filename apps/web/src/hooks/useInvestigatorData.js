import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ApiError, apiRequest, safeApiErrorMessage } from "../lib/apiClient";

const CLAIMS_POLL_INTERVAL_MS = 15000;
const CLAIMS_PAGE_SIZE = 25;

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

function positiveInteger(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function severityFromScore(riskScore) {
  if (!Number.isFinite(riskScore)) return "Unknown";
  if (riskScore >= 75) return "High";
  if (riskScore >= 40) return "Medium";
  return "Low";
}

function mapApiClaimToView(claim) {
  const score = Number.isFinite(claim?.riskScore) ? claim.riskScore : null;
  const processingStatus = claim?.processingStatus || claim?.processing?.status || (score === null ? "not_scored" : "scored");
  const processing = {
    ...(claim?.processing || {}),
    status: processingStatus,
  };
  const status = claim?.investigation?.status || claim?.status || "SUBMITTED";

  return {
    claimId: claim?.claimId,
    currentClaimVersion: claim?.currentClaimVersion || null,
    schemeId: claim?.schemeId || null,
    memberId: claim?.memberId || null,
    providerId: claim?.providerId || null,
    policyHolder: claim?.memberId || "Unknown",
    billedAmount: Number.isFinite(claim?.billedAmount) ? claim.billedAmount : null,
    billingCode: claim?.billingCode || null,
    submittedAt: claim?.submittedAt || null,
    updatedAt: claim?.updatedAt || null,
    status,
    processingStatus,
    processing,
    detectionDate: claim?.detection?.scoredAt || null,
    scoringUpdatedAt: processing.updatedAt || claim?.detection?.scoredAt || claim?.updatedAt || claim?.submittedAt || null,
    riskScore: score,
    severity: claim?.riskLevel || severityFromScore(score),
    triggeredRules: Array.isArray(claim?.triggeredRules) ? claim.triggeredRules : [],
    evidence: Array.isArray(claim?.evidence) ? claim.evidence : [],
    detection: claim?.detection || null,
    investigation: claim?.investigation || null,
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
    throw new ApiError(payload?.message || `${label} unavailable (${response.status})`, {
      status: response.status,
      code: payload?.code || null,
      payload,
    });
  }
  return payload[key];
}

async function fetchClaims({ page = 1, pageSize = CLAIMS_PAGE_SIZE } = {}) {
  const requestedPage = positiveInteger(page, 1);
  const requestedPageSize = positiveInteger(pageSize, CLAIMS_PAGE_SIZE);
  const response = await apiRequest(`/claims?page=${requestedPage}&pageSize=${requestedPageSize}`, { cache: "no-store" });
  const payload = await response.json().catch(() => null);
  if (!response.ok || payload?.available !== true) {
    throw new ApiError(payload?.message || `Claims unavailable (${response.status})`, {
      status: response.status,
      code: payload?.code || null,
      payload,
    });
  }
  return {
    claims: (payload.claims || []).map(mapApiClaimToView).filter((claim) => Boolean(claim.claimId)),
    pagination: payload.pagination || {
      page: requestedPage,
      pageSize: requestedPageSize,
      total: (payload.claims || []).length,
      totalPages: 1,
      hasNextPage: false,
    },
  };
}

function settledResource(result, previousValue, hasPreviousValue = Boolean(previousValue)) {
  if (result.status === "fulfilled") {
    return { value: result.value, status: "ready", error: null };
  }
  return {
    value: previousValue,
    status: hasPreviousValue ? "stale" : "error",
    error: safeApiErrorMessage(result.reason, "The resource is temporarily unavailable."),
  };
}

function resourceError(error, fallback) {
  return safeApiErrorMessage(error, fallback);
}

export function useInvestigatorData({ enabled = true } = {}) {
  const claimsPageRef = useRef(1);
  const claimsRequestSequenceRef = useRef(0);
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
    claimsOverview: null,
    claimsOverviewStatus: "loading",
    claimsOverviewError: null,
    claims: [],
    claimsStatus: "loading",
    claimsError: null,
    claimsPagination: null,
    snapshots: [],
    lastRefresh: null,
    lastClaimsRefresh: null,
    error: null,
    dataSource: "live",
  });

  const load = useCallback(async () => {
    const fetchedAt = new Date().toISOString();

    setState((previous) => ({
      ...previous,
      status: previous.lastRefresh ? "ready" : "loading",
      reportStatus: previous.report ? "refreshing" : "loading",
      reportError: null,
      graphStatus: previous.graph ? "refreshing" : "loading",
      graphError: null,
      riskStatus: previous.risk ? "refreshing" : "loading",
      riskError: null,
      claimsOverviewStatus: previous.claimsOverview ? "refreshing" : "loading",
      claimsOverviewError: null,
      claimsStatus: previous.claims.length > 0 ? "refreshing" : "loading",
      claimsError: null,
      error: null,
    }));

    const [reportResult, graphResult, riskResult, claimsOverviewResult, claimsResult] = await Promise.allSettled([
      fetchAvailableResource("/detection/report", "report", "Report"),
      fetchAvailableResource("/detection/graph", "graph", "Graph"),
      fetchAvailableResource("/detection/risk", "risk", "Risk"),
      fetchAvailableResource("/claims/overview", "overview", "Claims overview"),
      fetchClaims({ page: claimsPageRef.current }),
    ]);

    if (claimsResult.status === "fulfilled") {
      claimsPageRef.current = positiveInteger(claimsResult.value.pagination?.page, claimsPageRef.current);
    }

    setState((previous) => {
      const reportResource = settledResource(reportResult, previous.report, Boolean(previous.report));
      const graphResource = settledResource(graphResult, previous.graph, Boolean(previous.graph));
      const riskResource = settledResource(riskResult, previous.risk, Boolean(previous.risk));
      const claimsOverviewResource = settledResource(
        claimsOverviewResult,
        previous.claimsOverview,
        Boolean(previous.claimsOverview),
      );
      const claimsResource = settledResource(claimsResult, {
        claims: previous.claims,
        pagination: previous.claimsPagination,
      }, previous.claims.length > 0);
      const claims = claimsResource.value?.claims || [];
      const pagination = claimsResource.value?.pagination || null;
      const successfulResources = [reportResult, graphResult, riskResult, claimsOverviewResult, claimsResult]
        .filter((result) => result.status === "fulfilled").length;
      const hadPreviousData = Boolean(
        previous.report
        || previous.graph
        || previous.risk
        || previous.claimsOverview
        || previous.claims.length > 0,
      );
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
        claimsOverview: claimsOverviewResource.value,
        claimsOverviewStatus: claimsOverviewResource.status,
        claimsOverviewError: claimsOverviewResource.error,
        claims,
        claimsStatus: claimsResource.status,
        claimsError: claimsResource.error,
        claimsPagination: pagination,
        snapshots,
        lastRefresh: successfulResources > 0 ? fetchedAt : previous.lastRefresh,
        lastClaimsRefresh: claimsResult.status === "fulfilled" ? fetchedAt : previous.lastClaimsRefresh,
        error: successfulResources === 0 && !hadPreviousData ? "All investigator data resources are unavailable." : null,
        dataSource: successfulResources > 0 ? "live" : hadPreviousData ? "stale" : "unavailable",
      };
    });
  }, []);

  const refreshClaims = useCallback(async (page = claimsPageRef.current) => {
    const requestedPage = positiveInteger(page, claimsPageRef.current);
    const requestSequence = claimsRequestSequenceRef.current + 1;
    const fetchedAt = new Date().toISOString();
    claimsRequestSequenceRef.current = requestSequence;
    claimsPageRef.current = requestedPage;

    setState((previous) => ({
      ...previous,
      claimsStatus: previous.claims.length > 0 ? "refreshing" : "loading",
      claimsError: null,
    }));

    try {
      const result = await fetchClaims({ page: requestedPage });
      if (requestSequence !== claimsRequestSequenceRef.current) return;
      claimsPageRef.current = positiveInteger(result.pagination?.page, requestedPage);
      setState((previous) => ({
        ...previous,
        claims: result.claims,
        claimsPagination: result.pagination,
        claimsStatus: "ready",
        claimsError: null,
        lastClaimsRefresh: fetchedAt,
        lastRefresh: fetchedAt,
        dataSource: "live",
      }));
    } catch (error) {
      if (requestSequence !== claimsRequestSequenceRef.current) return;
      setState((previous) => ({
        ...previous,
        claimsStatus: previous.claims.length > 0 ? "stale" : "error",
        claimsError: resourceError(error, "Failed to refresh claims."),
        dataSource: previous.claims.length > 0 ? "stale" : previous.dataSource,
      }));
    }
  }, []);

  const refreshClaimsOverview = useCallback(async () => {
    setState((previous) => ({
      ...previous,
      claimsOverviewStatus: previous.claimsOverview ? "refreshing" : "loading",
      claimsOverviewError: null,
    }));

    try {
      const overview = await fetchAvailableResource(
        "/claims/overview",
        "overview",
        "Claims overview",
      );
      const fetchedAt = new Date().toISOString();
      setState((previous) => ({
        ...previous,
        claimsOverview: overview,
        claimsOverviewStatus: "ready",
        claimsOverviewError: null,
        lastRefresh: fetchedAt,
        dataSource: "live",
      }));
    } catch (error) {
      setState((previous) => ({
        ...previous,
        claimsOverviewStatus: previous.claimsOverview ? "stale" : "error",
        claimsOverviewError: resourceError(error, "Failed to refresh claims overview."),
        dataSource: previous.claimsOverview ? "stale" : previous.dataSource,
      }));
    }
  }, []);

  useEffect(() => {
    if (!enabled) {
      setState((previous) => ({
        ...previous,
        status: "ready",
        reportStatus: "idle",
        graphStatus: "idle",
        riskStatus: "idle",
        claimsOverviewStatus: "idle",
        claimsStatus: "idle",
        error: null,
      }));
      return;
    }
    load();
  }, [enabled, load]);

  useEffect(() => {
    if (!enabled) return undefined;
    const id = window.setInterval(() => {
      void refreshClaims();
      void refreshClaimsOverview();
    }, CLAIMS_POLL_INTERVAL_MS);
    return () => window.clearInterval(id);
  }, [enabled, refreshClaims, refreshClaimsOverview]);

  const metrics = useMemo(() => {
    const { report, claimsOverview, claims, claimsPagination } = state;
    const overviewSummary = claimsOverview?.summary || null;
    const highRisk = overviewSummary
      ? Number.isFinite(overviewSummary.highRiskClaims)
        ? overviewSummary.highRiskClaims
        : "Unavailable"
      : Number.isFinite(report?.summary?.highRiskClaims)
        ? report.summary.highRiskClaims
      : "Unavailable";
    const avgRisk = overviewSummary
      ? Number.isFinite(overviewSummary.averageRiskScore)
        ? overviewSummary.averageRiskScore
        : "Unavailable"
      : Number.isFinite(report?.summary?.averageRiskScore)
        ? report.summary.averageRiskScore
      : "Unavailable";

    const activeFraudSchemes = Number.isFinite(claimsOverview?.graph?.summary?.active_cluster_count)
      ? claimsOverview.graph.summary.active_cluster_count
      : Number.isFinite(report?.summary?.activeFraudPatterns)
        ? report.summary.activeFraudPatterns
      : "Unavailable";

    const recentDetections = Array.isArray(claimsOverview?.recentDetections)
      ? claimsOverview.recentDetections
      : claims
        .filter((claim) => Number.isFinite(claim.riskScore))
        .slice()
        .sort((a, b) => {
          const riskDiff = b.riskScore - a.riskScore;
          if (riskDiff !== 0) return riskDiff;
          const dateA = a.detectionDate ? new Date(a.detectionDate).getTime() : 0;
          const dateB = b.detectionDate ? new Date(b.detectionDate).getTime() : 0;
          return dateB - dateA;
        })
        .slice(0, 8);

    return {
      totalClaims: Number.isFinite(overviewSummary?.totalClaims)
        ? overviewSummary.totalClaims
        : Number.isFinite(claimsPagination?.total)
          ? claimsPagination.total
          : Number.isFinite(report?.summary?.totalClaims)
            ? report.summary.totalClaims
            : "Unavailable",
      scoredClaims: Number.isFinite(overviewSummary?.scoredClaims)
        ? overviewSummary.scoredClaims
        : "Unavailable",
      unscoredClaims: Number.isFinite(overviewSummary?.unscoredClaims)
        ? overviewSummary.unscoredClaims
        : "Unavailable",
      highRiskClaims: highRisk,
      averageRiskScore: avgRisk,
      activeFraudSchemes,
      recentDetections,
      riskDistribution: overviewSummary?.riskDistribution || null,
      inputDrift: overviewSummary?.inputDrift || null,
      allClaims: claims,
      ledgerStatus: isLedgerLinked(report?.ledgerReference) ? "Connected" : "Unavailable",
    };
  }, [state.report, state.claimsOverview, state.claims, state.claimsPagination]);

  return {
    ...state,
    metrics,
    pollingIntervalMs: CLAIMS_POLL_INTERVAL_MS,
    refreshNow: load,
    refreshClaims,
    refreshClaimsOverview,
    loadClaimsPage: refreshClaims,
  };
}
