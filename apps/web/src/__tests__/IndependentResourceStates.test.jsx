import React from "react";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import AppRoot from "../AppRoot";

const graphPayload = {
  available: true,
  graph: { nodes: [], edges: [], summary: { entity_count: 0, relationship_count: 0 } },
};

const riskPayload = {
  available: true,
  risk: { riskScore: 82, severity: "High", reasons: ["High-confidence anomaly"] },
};

const pageOneClaims = {
  available: true,
  claims: [
    {
      claimId: "C-QUEUED-1",
      schemeId: "S1",
      memberId: "Member Queued",
      providerId: "P-1",
      status: "AWAITING_SCORING",
      processingStatus: "queued",
      processing: { status: "queued", updatedAt: "2026-07-25T08:00:00.000Z" },
      riskScore: null,
      riskLevel: null,
      updatedAt: "2026-07-25T08:00:00.000Z",
      triggeredRules: [],
      evidence: [],
    },
    {
      claimId: "C-FAILED-1",
      schemeId: "S1",
      memberId: "Member Failed",
      providerId: "P-2",
      status: "PROCESSING_FAILED",
      processingStatus: "failed",
      processing: {
        status: "failed",
        failureCode: "WORKER_DEAD_LETTER",
        lastError: "Detection worker exhausted retries.",
        updatedAt: "2026-07-25T08:05:00.000Z",
      },
      riskScore: null,
      riskLevel: null,
      updatedAt: "2026-07-25T08:05:00.000Z",
      triggeredRules: [],
      evidence: [],
    },
  ],
  pagination: { page: 1, pageSize: 2, total: 3, totalPages: 2, hasNextPage: true },
};

const pageTwoClaims = {
  available: true,
  claims: [
    {
      claimId: "C-RETRY-1",
      schemeId: "S1",
      memberId: "Member Retrying",
      providerId: "P-3",
      status: "AWAITING_SCORING",
      processingStatus: "retrying",
      processing: {
        status: "retrying",
        attemptCount: 2,
        maxAttempts: 5,
        lastError: "Temporary model endpoint failure.",
        updatedAt: "2026-07-25T08:10:00.000Z",
      },
      riskScore: null,
      riskLevel: null,
      updatedAt: "2026-07-25T08:10:00.000Z",
      triggeredRules: [],
      evidence: [],
    },
  ],
  pagination: { page: 2, pageSize: 2, total: 3, totalPages: 2, hasNextPage: false },
};

function claimsNavigationLink() {
  return within(screen.getByRole("complementary")).getByRole("link", { name: /Claims/i });
}

beforeEach(() => {
  window.history.pushState({}, "", "/dashboard");
  window.localStorage.setItem("claimguard-dev-identity", "analyst-alpha");
  global.fetch = vi.fn((url) => {
    const requestUrl = String(url);
    if (requestUrl.includes("/api/detection/report")) {
      return Promise.resolve({
        ok: false,
        status: 503,
        json: async () => ({ available: false, message: "Report service unavailable" }),
      });
    }
    if (requestUrl.includes("/api/detection/graph")) {
      return Promise.resolve({ ok: true, status: 200, json: async () => graphPayload });
    }
    if (requestUrl.includes("/api/detection/risk")) {
      return Promise.resolve({ ok: true, status: 200, json: async () => riskPayload });
    }
    if (requestUrl.includes("/api/claims?page=2")) {
      return Promise.resolve({ ok: true, status: 200, json: async () => pageTwoClaims });
    }
    if (requestUrl.includes("/api/claims")) {
      return Promise.resolve({ ok: true, status: 200, json: async () => pageOneClaims });
    }
    return Promise.resolve({
      ok: false,
      status: 404,
      json: async () => ({ available: false, message: "not found" }),
    });
  });
});

test("keeps claims and other healthy resources usable when the report request fails", async () => {
  const user = userEvent.setup();
  render(<AppRoot />);

  expect(await screen.findByRole("heading", { name: /Claims risk intelligence/i })).toBeInTheDocument();
  expect(screen.queryByText(/Dashboard Unavailable/i)).not.toBeInTheDocument();

  await user.click(claimsNavigationLink());

  expect(await screen.findByRole("heading", { name: /Claims review table/i })).toBeInTheDocument();
  expect(screen.getByRole("link", { name: "C-QUEUED-1" })).toBeInTheDocument();
});

test("shows truthful processing and failure states", async () => {
  const user = userEvent.setup();
  render(<AppRoot />);

  await screen.findByRole("heading", { name: /Claims risk intelligence/i });
  await user.click(claimsNavigationLink());

  expect((await screen.findAllByText("Awaiting scoring")).length).toBeGreaterThan(0);
  expect(screen.getAllByText("Scoring failed").length).toBeGreaterThan(0);
  expect(screen.getByText(/WORKER_DEAD_LETTER: Detection worker exhausted retries/i)).toBeInTheDocument();

  const claimsTable = screen.getByRole("table", { name: "Claims table" });
  expect(within(claimsTable).queryByText(/^Unavailable$/i)).not.toBeInTheDocument();
});

test("uses server pagination and loads the requested page only", async () => {
  const user = userEvent.setup();
  render(<AppRoot />);

  await screen.findByRole("heading", { name: /Claims risk intelligence/i });
  await user.click(claimsNavigationLink());

  expect(await screen.findByText(/Page 1 \/ 2/i)).toBeInTheDocument();
  expect(screen.getByText(/Showing server records 1–2 of 3/i)).toBeInTheDocument();

  await user.click(screen.getByRole("button", { name: /Next/i }));

  expect(await screen.findByRole("link", { name: "C-RETRY-1" })).toBeInTheDocument();
  expect(screen.getAllByText("Retrying").length).toBeGreaterThan(0);
  expect(screen.getByText(/Attempt 2 of 5/i)).toBeInTheDocument();
  expect(screen.getByText(/Showing server records 3–3 of 3/i)).toBeInTheDocument();

  await waitFor(() => {
    expect(global.fetch.mock.calls.some(([url]) => String(url).includes("/api/claims?page=2&pageSize=25"))).toBe(true);
  });
});

test("manual claims refresh does not refetch report, graph or aggregate risk", async () => {
  const user = userEvent.setup();
  render(<AppRoot />);

  await screen.findByRole("heading", { name: /Claims risk intelligence/i });
  await user.click(claimsNavigationLink());
  await screen.findByRole("heading", { name: /Claims review table/i });

  const aggregateCallsBefore = global.fetch.mock.calls.filter(([url]) => String(url).includes("/api/detection/")).length;
  const claimsCallsBefore = global.fetch.mock.calls.filter(([url]) => String(url).includes("/api/claims")).length;

  await user.click(screen.getByRole("button", { name: /Refresh claims/i }));

  await waitFor(() => {
    const claimsCallsAfter = global.fetch.mock.calls.filter(([url]) => String(url).includes("/api/claims")).length;
    expect(claimsCallsAfter).toBe(claimsCallsBefore + 1);
  });
  const aggregateCallsAfter = global.fetch.mock.calls.filter(([url]) => String(url).includes("/api/detection/")).length;
  expect(aggregateCallsAfter).toBe(aggregateCallsBefore);
});
