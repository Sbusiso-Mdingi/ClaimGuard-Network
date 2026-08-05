import React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("../lib/apiClient", () => ({ apiRequest: vi.fn() }));

import { apiRequest } from "../lib/apiClient";
import { GovernedCaseActionPanel } from "../features/investigator/GovernedCaseActionPanel";

function response(status, body) {
  return Promise.resolve({ ok: status >= 200 && status < 300, status, json: async () => body });
}

function detail(stateVersion = 2) {
  return {
    available: true,
    case: {
      caseId: "CASE-1",
      currentState: "TRIAGE_PENDING",
      stateVersion,
      legacyStatus: "CONFIRMED_FRAUD",
      migrationReviewStatus: "REVIEW_REQUIRED",
    },
    allowedActions: ["begin-monitoring", "publish-registry", "activate-network-notice"],
    correlationId: "request-1",
  };
}

describe("GovernedCaseActionPanel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal("crypto", { randomUUID: () => "idem-generated" });
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  test("shows authoritative state, historical status, and only non-deferred server actions", async () => {
    apiRequest.mockReturnValue(response(200, detail()));
    render(<GovernedCaseActionPanel legacyInvestigationId="INV-1" historicalStatus="CONFIRMED_FRAUD" />);

    expect(await screen.findByText("Triage Pending")).toBeInTheDocument();
    expect(screen.getByText("Confirmed Fraud")).toBeInTheDocument();
    expect(screen.getByText("Read-only compatibility data")).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Begin Monitoring" })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: /publish registry/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("option", { name: /activate network notice/i })).not.toBeInTheDocument();
  });

  test("submits idempotency header and loaded version without target or trusted context", async () => {
    apiRequest
      .mockReturnValueOnce(response(200, detail(7)))
      .mockReturnValueOnce(response(201, {
        caseId: "CASE-1",
        state: "MONITORING",
        stateVersion: 8,
        transitionEventId: "EVENT-1",
        operationId: "a".repeat(64),
        correlationId: "request-2",
        replayed: false,
      }))
      .mockReturnValueOnce(response(200, {
        ...detail(8),
        case: { ...detail(8).case, currentState: "MONITORING", stateVersion: 8 },
        allowedActions: [],
      }));

    render(<GovernedCaseActionPanel legacyInvestigationId="INV-1" historicalStatus="OPEN" />);
    await screen.findByRole("button", { name: "Apply governed action" });
    fireEvent.change(screen.getByLabelText("Reason summary"), { target: { value: "Monitoring remains proportionate." } });
    fireEvent.click(screen.getByRole("button", { name: "Apply governed action" }));

    await waitFor(() => expect(apiRequest).toHaveBeenCalledTimes(3));
    const [path, options] = apiRequest.mock.calls[1];
    expect(path).toBe("/api/v1/cases/CASE-1/actions/begin-monitoring");
    expect(options.headers["idempotency-key"]).toBe("idem-generated");
    const body = JSON.parse(options.body);
    expect(body.expectedStateVersion).toBe(7);
    expect(body.reasonSummary).toBe("Monitoring remains proportionate.");
    for (const field of ["targetState", "toState", "tenantId", "actorId", "permissions", "roles", "status"]) {
      expect(body).not.toHaveProperty(field);
    }
    expect(await screen.findByText("The governed action was recorded.")).toBeInTheDocument();
  });

  test("refreshes stale case without replaying the user action", async () => {
    apiRequest
      .mockReturnValueOnce(response(200, detail(2)))
      .mockReturnValueOnce(response(409, {
        available: false,
        code: "CASE_STATE_VERSION_CONFLICT",
        message: "The case changed.",
        correlationId: "request-conflict",
      }))
      .mockReturnValueOnce(response(200, detail(3)));

    render(<GovernedCaseActionPanel legacyInvestigationId="INV-1" historicalStatus="OPEN" />);
    await screen.findByRole("button", { name: "Apply governed action" });
    fireEvent.change(screen.getByLabelText("Reason summary"), { target: { value: "Review decision." } });
    fireEvent.click(screen.getByRole("button", { name: "Apply governed action" }));

    expect(await screen.findByText(/authoritative case has been refreshed/i)).toBeInTheDocument();
    await waitFor(() => expect(apiRequest).toHaveBeenCalledTimes(3));
    expect(apiRequest.mock.calls.filter(([path]) => path.includes("/actions/")).length).toBe(1);
    expect(screen.getByText("3")).toBeInTheDocument();
  });
});
