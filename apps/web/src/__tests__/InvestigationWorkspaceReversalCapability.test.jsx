import React from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { MemoryRouter, Route, Routes } from "react-router-dom";

const roleState = vi.hoisted(() => ({
  identity: {
    tenantId: "tenant-alpha",
    tenantLabel: "Alpha Medical Scheme",
    capabilities: [],
  },
}));

vi.mock("../context/RoleContext", () => ({
  useRole: () => ({ identity: roleState.identity }),
}));
vi.mock("../lib/apiClient", () => ({ apiRequest: vi.fn() }));

import { apiRequest } from "../lib/apiClient";
import { InvestigationWorkspacePage } from "../features/investigator/InvestigationWorkspacePage";

const confirmedInvestigation = {
  investigationId: "INV-1",
  claimId: "CLAIM-1",
  tenantId: "tenant-alpha",
  assignedInvestigator: "investigator-alpha",
  assignedBy: "analyst-alpha",
  status: "CONFIRMED_FRAUD",
  priority: "HIGH",
  recordVersion: 3,
  fraudConfirmedAt: "2026-07-31T08:00:00.000Z",
  reversedAt: null,
  notes: [],
  evidence: [],
};

function ok(body) {
  return Promise.resolve({ ok: true, status: 200, json: async () => body });
}

function renderWorkspace() {
  return render(
    <MemoryRouter initialEntries={["/investigations/INV-1"]}>
      <Routes>
        <Route path="/investigations/:investigationId" element={<InvestigationWorkspacePage />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe("disabled fraud reversal capability guard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    apiRequest.mockImplementation((path) => {
      if (path === "/investigations/INV-1") {
        return ok({ available: true, investigation: confirmedInvestigation });
      }
      if (path === "/api/v1/cases/by-legacy-investigation/INV-1") {
        return ok({
          available: true,
          case: {
            caseId: "CASE-1",
            currentState: "TRIAGE_PENDING",
            stateVersion: 2,
            legacyStatus: "CONFIRMED_FRAUD",
            migrationReviewStatus: "REVIEW_REQUIRED",
          },
          allowedActions: [],
          correlationId: "request-1",
        });
      }
      throw new Error(`Unexpected request: ${path}`);
    });
  });

  afterEach(() => cleanup());

  test.each([
    ["confirmation authority", ["investigations.view", "investigations.confirm_fraud"]],
    ["reversal authority", ["investigations.view", "investigations.reverse_fraud"]],
  ])("%s does not expose legacy confirmation, reversal, or status controls", async (_label, capabilities) => {
    roleState.identity.capabilities = capabilities;

    renderWorkspace();

    expect(await screen.findByText("Legacy compatibility details")).toBeInTheDocument();
    expect(await screen.findByText("Governed case")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Reverse fraud finding" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Confirm fraud" })).not.toBeInTheDocument();
    expect(screen.queryByText("Update status")).not.toBeInTheDocument();
    expect(screen.getAllByText("Confirmed Fraud").length).toBeGreaterThan(0);
    expect(screen.getByText("Read-only audit data")).toBeInTheDocument();
    expect(apiRequest).toHaveBeenCalledWith("/investigations/INV-1");
    expect(apiRequest).toHaveBeenCalledWith("/api/v1/cases/by-legacy-investigation/INV-1");
    expect(apiRequest).not.toHaveBeenCalledWith("/investigations/reverse-fraud", expect.anything());
  });
});
