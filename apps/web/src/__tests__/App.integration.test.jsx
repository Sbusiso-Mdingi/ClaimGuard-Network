import React from "react";
import { act, render, screen, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import AppRoot from "../AppRoot";

const reportPayload = {
  available: true,
  report: {
    schemes: [
      {
        scheme_id: "S1",
        provider_findings: [{ score: 80 }],
        member_findings: [],
      },
    ],
    detection: {
      relationships: [
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
      triggered_rules: [
        {
          rule_id: "R-1",
          title: "Suspicious repeat billing",
          weight: 10,
          evidence: ["claimant:Alex", "provider:P-100"],
        },
        {
          rule_id: "R-2",
          title: "Rapid provider hopping",
          weight: 5,
          evidence: ["claimant:Blair"],
        },
      ],
      evidence: ["claimant:Alex linked to provider:P-100"],
      ledger_reference: {
        available: true,
        entry: { entryType: "ledger_event" },
      },
    },
  },
};

const graphPayload = {
  available: true,
  graph: {
    entities: [
      { entity_id: "claimant:Alex", entity_type: "claimant" },
      { entity_id: "provider:P-100", entity_type: "provider" },
      { entity_id: "claimant:Blair", entity_type: "claimant" },
      { entity_id: "provider:P-200", entity_type: "provider" },
    ],
    relationships: reportPayload.report.detection.relationships,
  },
};

const riskPayload = {
  available: true,
  risk: {
    riskScore: 82,
    severity: "High",
    reasons: ["Cross-entity collision", "Multiple high-weight rules triggered"],
  },
};

function mockFetch() {
  global.fetch = vi.fn((url) => {
    if (String(url).includes("/api/detection/report")) return Promise.resolve({ ok: true, json: async () => reportPayload });
    if (String(url).includes("/api/detection/graph")) return Promise.resolve({ ok: true, json: async () => graphPayload });
    if (String(url).includes("/api/detection/risk")) return Promise.resolve({ ok: true, json: async () => riskPayload });
    return Promise.resolve({ ok: false, json: async () => ({ available: false, message: "not found" }) });
  });
}

beforeEach(() => {
  window.history.pushState({}, "", "/");
  vi.useRealTimers();
  mockFetch();
});

afterEach(() => {
  vi.useRealTimers();
});

test("renders dashboard and routes to claim details", async () => {
  const user = userEvent.setup();
  render(<AppRoot />);

  expect(await screen.findByText(/Fraud Investigator Workspace/i)).toBeInTheDocument();
  expect(screen.getByText(/Total claims/i)).toBeInTheDocument();

  await user.click(screen.getByRole("link", { name: /Claims Explorer/i }));
  expect(await screen.findByText(/Search, sort, and filter claims/i)).toBeInTheDocument();

  expect(screen.getAllByText("82").length).toBeGreaterThan(0);

  await user.type(screen.getByLabelText(/Search claims/i), "C-1");
  expect(screen.getByRole("link", { name: "C-1" })).toBeInTheDocument();

  await user.click(screen.getByRole("link", { name: "C-1" }));
  expect(await screen.findByText(/Claim Details/i)).toBeInTheDocument();
  expect(screen.getByRole("heading", { name: /Risk Panel/i })).toBeInTheDocument();
});

test("static snapshot mode stops polling while live mode continues", async () => {
  vi.useFakeTimers();
  render(<AppRoot />);

  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });

  expect(screen.getByText(/Fraud Investigator Workspace/i)).toBeInTheDocument();
  expect(global.fetch).toHaveBeenCalledTimes(3);

  await act(async () => {
    vi.advanceTimersByTime(15000);
    await Promise.resolve();
  });
  expect(global.fetch).toHaveBeenCalledTimes(6);

  fireEvent.click(screen.getByRole("button", { name: /Enable static snapshot/i }));

  await act(async () => {
    vi.advanceTimersByTime(30000);
    await Promise.resolve();
  });
  expect(global.fetch).toHaveBeenCalledTimes(6);
}, 10000);
