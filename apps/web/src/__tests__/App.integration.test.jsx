import React from "react";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import AppRoot from "../AppRoot";
import { createSessionFetch, SESSION_FIXTURES } from "./helpers/sessionFixtures";

const reportPayload = {
  available: true,
  report: {
    metadata: { generatedAt: "2026-07-16T00:00:00.000Z" },
    summary: { totalClaims: 2, highRiskClaims: 2, averageRiskScore: 82, activeFraudPatterns: 2 },
    claims: [
      { claimId: "C-1", schemeId: "S1", memberId: "Alex", providerId: "P-100", riskScore: 82, severity: "High", processingStatus: null, ruleHits: [{ title: "Suspicious repeat billing" }], evidenceReferences: [] },
      { claimId: "C-2", schemeId: "S1", memberId: "Blair", providerId: "P-200", riskScore: 74, severity: "High", processingStatus: null, ruleHits: [{ title: "Rapid provider hopping" }], evidenceReferences: [] },
    ],
    history: {
      ruleExecution: { triggeredRules: [
        { rule_id: "R-1", title: "Suspicious repeat billing", weight: 10 },
        { rule_id: "R-2", title: "Rapid provider hopping", weight: 5 },
      ] },
    },
    graph: {
      nodes: [
        { entity_id: "claimant:Alex", entity_type: "claimant" },
        { entity_id: "provider:P-100", entity_type: "provider" },
        { entity_id: "claimant:Blair", entity_type: "claimant" },
        { entity_id: "provider:P-200", entity_type: "provider" },
      ],
      edges: [
        {
          source_entity_id: "claimant:Alex",
          target_entity_id: "provider:P-100",
          relationship_type: "submitted_to",
          claim_id: "C-1",
        },
        {
          source_entity_id: "claimant:Blair",
          target_entity_id: "provider:P-200",
          relationship_type: "submitted_to",
          claim_id: "C-2",
        },
      ],
      summary: { entity_count: 4, relationship_count: 2 },
    },
  },
};

const graphPayload = {
  available: true,
  graph: reportPayload.report.graph,
};

const riskPayload = {
  available: true,
  risk: {
    riskScore: 82,
    severity: "High",
    reasons: ["Cross-entity collision", "Multiple high-weight rules triggered"],
  },
};

const claimsPayload = {
  available: true,
  claims: [
    {
      claimId: "C-1",
      schemeId: "S1",
      memberId: "Alex",
      providerId: "P-100",
      status: "SCORED",
      processingStatus: "scored",
      processing: { status: "scored", updatedAt: "2026-07-16T00:00:00.000Z" },
      riskScore: 82,
      riskLevel: "High",
      updatedAt: "2026-07-16T00:00:00.000Z",
      detection: {
        scoredAt: "2026-07-16T00:00:00.000Z",
        modelDeploymentId: "claimguard-claim-fraud-ensemble:2.1.1",
        score: { fraudProbability: 0.82, threshold: 0.45, predictedClass: "FRAUD" },
        inputDrift: {
          status: "WATCH",
          decisionReliability: "CAUTION",
          message: "One unfamiliar model input was detected; retain human review and monitor the pattern.",
          signals: [{ feature: "benefit_option", observed: "STANDARD", expected: "One of: COMPREHENSIVE, CORE, EXECUTIVE, FLEX" }],
        },
      },
      triggeredRules: ["PROSPECTIVE_ML_REVIEW_RECOMMENDED"],
      evidence: [],
    },
    {
      claimId: "C-2",
      schemeId: "S1",
      memberId: "Blair",
      providerId: "P-200",
      status: "UNDER_INVESTIGATION",
      processingStatus: "scored",
      processing: { status: "scored", updatedAt: "2026-07-16T00:00:00.000Z" },
      riskScore: 74,
      riskLevel: "High",
      updatedAt: "2026-07-16T00:00:00.000Z",
      detection: { scoredAt: "2026-07-16T00:00:00.000Z" },
      triggeredRules: ["Rapid provider hopping"],
      evidence: [],
    },
  ],
  pagination: {
    page: 1,
    pageSize: 25,
    requestedPageSize: 25,
    maxPageSize: 100,
    total: 2,
    totalPages: 1,
    hasNextPage: false,
  },
};

const claimsOverviewPayload = {
  available: true,
  overview: {
    generatedAt: "2026-07-16T00:00:00.000Z",
    summary: {
      totalClaims: 37,
      scoredClaims: 9,
      unscoredClaims: 28,
      highRiskClaims: 4,
      averageRiskScore: 61.5,
      riskDistribution: { critical: 1, high: 3, medium: 3, low: 2, unscored: 28 },
      inputDrift: { inDistribution: 5, watch: 2, outOfDistribution: 1, profileUnavailable: 0, unassessed: 1 },
    },
    recentDetections: claimsPayload.claims,
    graph: reportPayload.report.graph,
  },
};

const claimDetailPayload = {
  available: true,
  claim: claimsPayload.claims[0],
};

const investigationsPayload = {
  available: true,
  investigations: [
    {
      investigationId: "INV-100",
      claimId: "C-2",
      status: "UNDER_REVIEW",
      priority: "CRITICAL",
      assignedInvestigator: null,
      noteCount: 2,
      evidenceCount: 1,
      updatedAt: "2026-07-16T00:00:00.000Z",
    },
    {
      investigationId: "INV-101",
      claimId: "C-1",
      status: "AWAITING_EVIDENCE",
      priority: "NORMAL",
      assignedInvestigator: "investigator-alpha",
      noteCount: 1,
      evidenceCount: 0,
      updatedAt: "2026-07-15T00:00:00.000Z",
    },
  ],
  pagination: {
    page: 1,
    pageSize: 25,
    total: 27,
    totalPages: 2,
    hasNextPage: true,
    hasPreviousPage: false,
  },
};

let activeSession = SESSION_FIXTURES.analyst;

function operationalResponse(requestUrl) {
  if (requestUrl.includes("/api/detection/report")) return Promise.resolve({ ok: true, status: 200, json: async () => reportPayload });
  if (requestUrl.includes("/api/detection/graph")) return Promise.resolve({ ok: true, status: 200, json: async () => graphPayload });
  if (requestUrl.includes("/api/detection/risk")) return Promise.resolve({ ok: true, status: 200, json: async () => riskPayload });
  if (requestUrl.includes("/api/investigations/missing-case")) {
    return Promise.resolve({
      ok: true,
      status: 200,
      json: async () => ({
        available: false,
        message: "Investigation not found for the active tenant.",
      }),
    });
  }
  if (requestUrl.includes("/api/investigations/queue")) {
    return Promise.resolve({ ok: true, status: 200, json: async () => investigationsPayload });
  }
  if (requestUrl.includes("/api/claims/overview")) return Promise.resolve({ ok: true, status: 200, json: async () => claimsOverviewPayload });
  if (requestUrl.includes("/api/claims/C-1")) return Promise.resolve({ ok: true, status: 200, json: async () => claimDetailPayload });
  if (requestUrl.includes("/api/claims")) return Promise.resolve({ ok: true, status: 200, json: async () => claimsPayload });
  return Promise.resolve({ ok: false, status: 404, json: async () => ({ available: false, message: "not found" }) });
}

function mockFetch(session = activeSession) {
  global.fetch = createSessionFetch(session, operationalResponse);
}

function mockFetchFailure(session = activeSession) {
  global.fetch = createSessionFetch(session, (requestUrl) => {
    if (requestUrl.includes("/api/detection/report")) {
      return Promise.resolve({ ok: false, status: 503, json: async () => ({ available: false, message: "Report unavailable (503)" }) });
    }
    if (requestUrl.includes("/api/detection/graph")) {
      return Promise.resolve({ ok: false, status: 503, json: async () => ({ available: false, message: "Graph unavailable (503)" }) });
    }
    if (requestUrl.includes("/api/detection/risk")) {
      return Promise.resolve({ ok: false, status: 503, json: async () => ({ available: false, message: "Risk unavailable (503)" }) });
    }
    if (requestUrl.includes("/api/claims")) {
      return Promise.resolve({ ok: false, status: 503, json: async () => ({ available: false, message: "Claims unavailable (503)" }) });
    }
    return Promise.resolve({ ok: false, status: 404, json: async () => ({ available: false, message: "not found" }) });
  });
}

function claimsNavigationLink() {
  const workspaceNavigationRegion = screen.getByRole("complementary", { name: /workspace navigation/i });
  const primaryNav = within(workspaceNavigationRegion).getByRole("navigation");
  return within(primaryNav).getByRole("link", { name: /^Claims Explorer$/i });
}

function networkNavigationLink() {
  const workspaceNavigationRegion = screen.getByRole("complementary", { name: /workspace navigation/i });
  const primaryNav = within(workspaceNavigationRegion).getByRole("navigation");
  return within(primaryNav).getByRole("link", { name: /^Network Analysis$/i });
}

beforeEach(() => {
  activeSession = SESSION_FIXTURES.analyst;
  window.history.pushState({}, "", "/dashboard");
  vi.useRealTimers();
  mockFetch();
});

afterEach(() => {
  vi.useRealTimers();
});

test("renders dashboard and routes to claim details", async () => {
  const user = userEvent.setup();
  render(<AppRoot />);

  expect(
    await screen.findByRole(
      "heading",
      { name: /Executive dashboard/i },
      { timeout: 10_000 },
    ),
  ).toBeInTheDocument();
  expect(screen.getByText(/Claims received/i)).toBeInTheDocument();
  const detectionSummary = screen.getByRole("region", { name: "Detection summary" });
  expect(within(detectionSummary).getByText("37")).toBeInTheDocument();
  expect(within(detectionSummary).getByText("4")).toBeInTheDocument();
  expect(within(detectionSummary).getByText("61.5")).toBeInTheDocument();
  expect(within(detectionSummary).getByText(/9 scored · 28 awaiting/i)).toBeInTheDocument();
  expect(screen.getByText("Drift watch")).toBeInTheDocument();

  const operationalCalls = global.fetch.mock.calls.filter(([url]) => {
    const requestUrl = String(url);
    return requestUrl.includes("/api/detection/") || requestUrl.includes("/api/claims");
  });
  for (const [, requestOptions] of operationalCalls.slice(0, 3)) {
    for (const name of ["x-claimguard-user", "x-claimguard-role", "x-claimguard-user-tenant", "x-claimguard-tenant"]) {
      expect(requestOptions.headers.has(name)).toBe(false);
    }
  }

  await user.click(claimsNavigationLink());
  expect(
    await screen.findByRole(
      "heading",
      { name: /^Claims$/i },
      { timeout: 10_000 },
    ),
  ).toBeInTheDocument();

  expect(screen.getAllByText("82").length).toBeGreaterThan(0);

  await user.type(screen.getByLabelText(/Search claims/i), "C-1");
  expect(screen.getByRole("link", { name: "C-1" })).toBeInTheDocument();

  await user.click(screen.getByRole("link", { name: "C-1" }));
  expect(
    await screen.findByRole(
      "heading",
      { name: /C-1/i },
      { timeout: 10_000 },
    ),
  ).toBeInTheDocument();
  expect(screen.getByRole("heading", { name: /Risk summary/i })).toBeInTheDocument();
  expect(screen.getByText("Fraud-risk review recommended")).toBeInTheDocument();
  expect(screen.getByText("Drift watch")).toBeInTheDocument();
  expect(screen.getByText(/benefit option/i)).toBeInTheDocument();
  expect(screen.getByText("82.00%")).toBeInTheDocument();
  expect(screen.getByText("45.00%")).toBeInTheDocument();
  expect(screen.queryByText("PROSPECTIVE_ML_REVIEW_RECOMMENDED")).not.toBeInTheDocument();

  await user.click(networkNavigationLink());
  expect(
    await screen.findByRole(
      "heading",
      { name: /Fraud network candidates/i },
      { timeout: 10_000 },
    ),
  ).toBeInTheDocument();
  expect(screen.getAllByText("Members").length).toBeGreaterThan(0);
  expect(screen.getAllByText("Providers").length).toBeGreaterThan(0);
  expect(screen.queryByText("Bank links")).not.toBeInTheDocument();
});

test("automatic refresh polls claims and the operational overview without refetching reports", async () => {
  vi.useFakeTimers();
  render(<AppRoot />);

  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });

  const requestCount = (path) =>
    global.fetch.mock.calls.filter(([url]) => String(url).includes(path)).length;

  expect(screen.getByRole("heading", { name: /Executive dashboard/i })).toBeInTheDocument();
  expect(requestCount("/api/detection/report")).toBe(1);
  expect(requestCount("/api/detection/graph")).toBe(1);
  expect(requestCount("/api/detection/risk")).toBe(1);
  expect(requestCount("/api/claims?page=1&pageSize=25")).toBe(1);
  expect(requestCount("/api/claims/overview")).toBe(1);

  await act(async () => {
    vi.advanceTimersByTime(30000);
    await Promise.resolve();
    await Promise.resolve();
  });

  expect(requestCount("/api/claims?page=1&pageSize=25")).toBe(3);
  expect(requestCount("/api/claims/overview")).toBe(3);
  expect(requestCount("/api/detection/report")).toBe(1);
  expect(requestCount("/api/detection/graph")).toBe(1);
  expect(requestCount("/api/detection/risk")).toBe(1);

  await act(async () => {
    vi.advanceTimersByTime(30000);
    await Promise.resolve();
    await Promise.resolve();
  });

  expect(requestCount("/api/claims?page=1&pageSize=25")).toBe(5);
  expect(requestCount("/api/claims/overview")).toBe(5);
  expect(requestCount("/api/detection/report")).toBe(1);
  expect(requestCount("/api/detection/graph")).toBe(1);
  expect(requestCount("/api/detection/risk")).toBe(1);
  expect(screen.queryByRole("button", { name: /live refresh/i })).not.toBeInTheDocument();
}, 10000);

test("shows unavailable state without substituting demo analytics when backend APIs fail", async () => {
  mockFetchFailure();

  render(<AppRoot />);

  expect(await screen.findByText(/Dashboard Unavailable/i)).toBeInTheDocument();
  expect(within(screen.getByRole("complementary")).getByText(/^Sequrin$/i)).toBeInTheDocument();
  expect(screen.queryByText(/Claims Screened/i)).not.toBeInTheDocument();
});

test("renders the tenant investigation queue and applies operational filters", async () => {
  const user = userEvent.setup();
  activeSession = SESSION_FIXTURES.investigator;
  mockFetch(activeSession);
  window.history.pushState({}, "", "/investigations");

  render(<AppRoot />);

  expect(
    await screen.findByRole("heading", { name: "Investigation queue" }),
  ).toBeInTheDocument();
  expect(screen.getByText(/authoritative tenant-scoped cases for Bonitas/i)).toBeInTheDocument();
  expect(await screen.findByText("INV-100")).toBeInTheDocument();
  expect(screen.getAllByText("Critical").length).toBeGreaterThan(0);
  expect(screen.getAllByText("Unassigned").length).toBeGreaterThan(0);

  await user.type(screen.getByLabelText("Search"), " INV-100 ");
  await user.selectOptions(screen.getByLabelText("Status"), "UNDER_REVIEW");
  await user.selectOptions(screen.getByLabelText("Priority"), "CRITICAL");
  await user.selectOptions(screen.getByLabelText("Assignment"), "unassigned");
  await user.click(screen.getByRole("button", { name: "Apply filters" }));

  await waitFor(() => {
    expect(global.fetch.mock.calls.some(([url]) => {
      const requestUrl = String(url);
      return requestUrl.includes("/api/investigations/queue?")
        && requestUrl.includes("search=INV-100")
        && requestUrl.includes("status=UNDER_REVIEW")
        && requestUrl.includes("priority=CRITICAL")
        && requestUrl.includes("assignment=unassigned");
    })).toBe(true);
  });

  await user.click(screen.getByRole("button", { name: "Next" }));
  await waitFor(() => {
    expect(global.fetch.mock.calls.some(([url]) =>
      String(url).includes("/api/investigations/queue?page=2"),
    )).toBe(true);
  });

  await user.type(screen.getByLabelText("Investigation ID"), "missing-case");
  await user.click(screen.getByRole("button", { name: "Open investigation" }));
  expect(
    await screen.findByRole("alert"),
  ).toHaveTextContent("Investigation not found for the active tenant.");

  global.fetch.mockImplementationOnce(() => Promise.resolve({
    ok: false,
    status: 500,
    json: async () => ({
      message: "Incorrect arguments to mysqld_stmt_execute",
      requestId: "req-investigations-1",
    }),
  }));
  await user.click(screen.getByRole("button", { name: "Refresh queue" }));

  expect(await screen.findByText("Showing the last loaded investigation queue"))
    .toBeInTheDocument();
  expect(screen.getByText("INV-100")).toBeInTheDocument();
  expect(screen.getByText(/Request ID: req-investigations-1/))
    .toBeInTheDocument();
  expect(screen.queryByText(/mysqld|stmt_execute/i)).not.toBeInTheDocument();
});
