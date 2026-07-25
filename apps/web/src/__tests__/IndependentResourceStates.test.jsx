import React from "react";
import { render, screen } from "@testing-library/react";
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

const claimsPayload = {
  available: true,
  claims: [
    {
      claimId: "C-PARTIAL-1",
      schemeId: "S1",
      memberId: "Member One",
      providerId: "P-1",
      status: "SUBMITTED",
      riskScore: 82,
      riskLevel: "High",
      updatedAt: "2026-07-25T08:00:00.000Z",
      triggeredRules: ["Duplicate billing"],
      evidence: [],
    },
  ],
  pagination: { page: 1, pageSize: 25, total: 1, totalPages: 1, hasNextPage: false },
};

beforeEach(() => {
  window.history.pushState({}, "", "/");
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
    if (requestUrl.includes("/api/claims")) {
      return Promise.resolve({ ok: true, status: 200, json: async () => claimsPayload });
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

  await user.click(screen.getByRole("link", { name: /Claims(?: Explorer| Review Table)?/i }));

  expect(await screen.findByRole("heading", { name: /Claims review table/i })).toBeInTheDocument();
  expect(screen.getByRole("link", { name: "C-PARTIAL-1" })).toBeInTheDocument();
});
