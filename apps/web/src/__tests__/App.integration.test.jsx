import React from "react";
import { act, render, screen, fireEvent } from "@testing-library/react";
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
      status: "SUBMITTED",
      riskScore: 82,
      riskLevel: "High",
      updatedAt: "2026-07-16T00:00:00.000Z",
      triggeredRules: ["Suspicious repeat billing"],
      evidence: [],
    },
    {
      claimId: "C-2",
      schemeId: "S1",
      memberId: "Blair",
      providerId: "P-200",
      status: "UNDER_INVESTIGATION",
      riskScore: 74,
      riskLevel: "High",
      updatedAt: "2026-07-16T00:00:00.000Z",
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

function mockFetch() {
  global.fetch = vi.fn((url) => {
    if (String(url).includes("/api/detection/report")) return Promise.resolve({ ok: true, json: async () => reportPayload });
    if (String(url).includes("/api/detection/graph")) return Promise.resolve({ ok: true, json: async () => graphPayload });
    if (String(url).includes("/api/detection/risk")) return Promise.resolve({ ok: true, json: async () => riskPayload });
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

beforeEach(() => {
  window.history.pushState({}, "", "/");
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

  expect(await screen.findByRole("heading", { name: /Fraud operations overview/i })).toBeInTheDocument();
  expect(screen.getByText(/Total claims/i)).toBeInTheDocument();

  for (const [, requestOptions] of global.fetch.mock.calls.slice(0, 3)) {
    expect(requestOptions.headers.get("x-claimguard-user")).toBe("analyst-alpha");
    expect(requestOptions.headers.get("x-claimguard-role")).toBe("fraud_analyst");
    expect(requestOptions.headers.get("x-claimguard-user-tenant")).toBe("tenant_alpha");
    expect(requestOptions.headers.get("x-claimguard-tenant")).toBe("tenant_alpha");
  }

  await user.click(screen.getByRole("link", { name: /Claims(?: Explorer| Review Table)?/i }));
  expect(await screen.findByRole("heading", { name: /Claims review table/i })).toBeInTheDocument();

  expect(screen.getAllByText("82").length).toBeGreaterThan(0);

  await user.type(screen.getByLabelText(/Search claims/i), "C-1");
  expect(screen.getByRole("link", { name: "C-1" })).toBeInTheDocument();

  await user.click(screen.getByRole("link", { name: "C-1" }));
  expect(await screen.findByRole("heading", { name: /C-1/i })).toBeInTheDocument();
  expect(screen.getByRole("heading", { name: /Risk summary/i })).toBeInTheDocument();
});

test("live refresh toggle controls browser polling", async () => {
  vi.useFakeTimers();
  render(<AppRoot />);

  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });

  expect(screen.getByRole("heading", { name: /Fraud operations overview/i })).toBeInTheDocument();
  expect(global.fetch).toHaveBeenCalledTimes(4);

  await act(async () => {
    vi.advanceTimersByTime(15000);
    await Promise.resolve();
  });
  expect(global.fetch).toHaveBeenCalledTimes(8);

  fireEvent.click(screen.getByRole("button", { name: /Disable live refresh/i }));

  await act(async () => {
    vi.advanceTimersByTime(30000);
    await Promise.resolve();
  });
  expect(global.fetch).toHaveBeenCalledTimes(8);
}, 10000);

test("shows unavailable state without substituting demo analytics when backend APIs fail", async () => {
  mockFetchFailure();

  render(<AppRoot />);

  expect(await screen.findByText(/Dashboard Unavailable/i)).toBeInTheDocument();
  expect(screen.getByText("ClaimGuard")).toBeInTheDocument();
  expect(screen.queryByText(/Total claims/i)).not.toBeInTheDocument();
});
