import React from "react";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import AppRoot from "../AppRoot";

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
      detection: { scoredAt: "2026-07-16T00:00:00.000Z" },
      triggeredRules: ["Suspicious repeat billing"],
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

function mockFetch() {
  global.fetch = vi.fn((url) => {
    if (String(url).includes("/api/detection/report")) return Promise.resolve({ ok: true, json: async () => reportPayload });
    if (String(url).includes("/api/detection/graph")) return Promise.resolve({ ok: true, json: async () => graphPayload });
    if (String(url).includes("/api/detection/risk")) return Promise.resolve({ ok: true, json: async () => riskPayload });
    if (String(url).includes("/api/investigations/missing-case")) {
      return Promise.resolve({
        ok: true,
        json: async () => ({
          available: false,
          message: "Investigation not found for the active tenant.",
        }),
      });
    }
    if (String(url).includes("/api/investigations/queue")) {
      return Promise.resolve({ ok: true, json: async () => investigationsPayload });
    }
    if (String(url).includes("/api/claims/C-1")) return Promise.resolve({ ok: true, json: async () => claimDetailPayload });
    if (String(url).includes("/api/claims")) return Promise.resolve({ ok: true, json: async () => claimsPayload });
    return Promise.resolve({ ok: false, json: async () => ({ available: false, message: "not found" }) });
  });
}

function mockFetchFailure() {
  global.fetch = vi.fn((url) => {
    if (String(url).includes("/api/detection/report")) {
      return Promise.resolve({ ok: false, json: async () => ({ available: false, message: "Report unavailable (503)" }) });
    }
    if (String(url).includes("/api/detection/graph")) {
      return Promise.resolve({ ok: false, json: async () => ({ available: false, message: "Graph unavailable (503)" }) });
    }
    if (String(url).includes("/api/detection/risk")) {
      return Promise.resolve({ ok: false, json: async () => ({ available: false, message: "Risk unavailable (503)" }) });
    }
    if (String(url).includes("/api/claims")) {
      return Promise.resolve({ ok: false, json: async () => ({ available: false, message: "Claims unavailable (503)" }) });
    }
    return Promise.resolve({ ok: false, json: async () => ({ available: false, message: "not found" }) });
  });
}

function claimsNavigationLink() {
  return within(screen.getByRole("complementary")).getByRole("link", { name: /Claims/i });
}

beforeEach(() => {
  window.history.pushState({}, "", "/dashboard");
  window.localStorage.setItem("claimguard-dev-identity", "analyst-alpha");
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
    await screen.findByRole("heading", { name: /Claims risk intelligence/i }, { timeout: 5_000 })
  ).toBeInTheDocument();
  expect(screen.getByText(/Claims Screened/i)).toBeInTheDocument();

  for (const [, requestOptions] of global.fetch.mock.calls.slice(0, 3)) {
    expect(requestOptions.headers.get("x-claimguard-user")).toBe("analyst-alpha");
    expect(requestOptions.headers.get("x-claimguard-role")).toBe("fraud_analyst");
    expect(requestOptions.headers.get("x-claimguard-user-tenant")).toBe("tenant_alpha");
    expect(requestOptions.headers.get("x-claimguard-tenant")).toBe("tenant_alpha");
  }

  await user.click(claimsNavigationLink());
  expect(await screen.findByRole("heading", { name: /^Claims$/i })).toBeInTheDocument();

  expect(screen.getAllByText("82").length).toBeGreaterThan(0);

  await user.type(screen.getByLabelText(/Search claims/i), "C-1");
  expect(screen.getByRole("link", { name: "C-1" })).toBeInTheDocument();

  await user.click(screen.getByRole("link", { name: "C-1" }));
  expect(await screen.findByRole("heading", { name: /C-1/i })).toBeInTheDocument();
  expect(screen.getByRole("heading", { name: /Risk summary/i })).toBeInTheDocument();
});

test("automatic refresh polls claims without refetching aggregate resources", async () => {
  vi.useFakeTimers();
  render(<AppRoot />);

  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });

  const requestCount = (path) =>
    global.fetch.mock.calls.filter(([url]) => String(url).includes(path)).length;

  expect(screen.getByRole("heading", { name: /Claims risk intelligence/i })).toBeInTheDocument();
  expect(requestCount("/api/detection/report")).toBe(1);
  expect(requestCount("/api/detection/graph")).toBe(1);
  expect(requestCount("/api/detection/risk")).toBe(1);
  expect(requestCount("/api/claims?page=1&pageSize=25")).toBe(1);

  await act(async () => {
    vi.advanceTimersByTime(30000);
    await Promise.resolve();
    await Promise.resolve();
  });

  expect(requestCount("/api/claims?page=1&pageSize=25")).toBe(3);
  expect(requestCount("/api/detection/report")).toBe(1);
  expect(requestCount("/api/detection/graph")).toBe(1);
  expect(requestCount("/api/detection/risk")).toBe(1);

  await act(async () => {
    vi.advanceTimersByTime(30000);
    await Promise.resolve();
    await Promise.resolve();
  });

  expect(requestCount("/api/claims?page=1&pageSize=25")).toBe(5);
  expect(requestCount("/api/detection/report")).toBe(1);
  expect(requestCount("/api/detection/graph")).toBe(1);
  expect(requestCount("/api/detection/risk")).toBe(1);
  expect(screen.queryByRole("button", { name: /live refresh/i })).not.toBeInTheDocument();
}, 10000);

test("shows unavailable state without substituting demo analytics when backend APIs fail", async () => {
  mockFetchFailure();

  render(<AppRoot />);

  expect(await screen.findByText(/Dashboard Unavailable/i)).toBeInTheDocument();
  expect(screen.getByText("ClaimGuard")).toBeInTheDocument();
  expect(screen.queryByText(/Claims Screened/i)).not.toBeInTheDocument();
});

test("renders the tenant investigation queue and applies operational filters", async () => {
  const user = userEvent.setup();
  window.localStorage.setItem("claimguard-dev-identity", "investigator-alpha");
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
});
