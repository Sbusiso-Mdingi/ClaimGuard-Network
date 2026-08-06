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

function response(body, { ok = true, status = ok ? 200 : 500 } = {}) {
  return Promise.resolve({
    ok,
    status,
    json: async () => body,
  });
}

function investigation(overrides = {}) {
  return {
    investigationId: "INV-1",
    claimId: "CLAIM-1",
    tenantId: "tenant-alpha",
    assignedInvestigator: "investigator-alpha",
    assignedBy: "analyst-alpha",
    status: "UNDER_REVIEW",
    priority: "HIGH",
    recordVersion: 2,
    fraudConfirmedAt: null,
    reversedAt: null,
    notes: [],
    evidence: [],
    ...overrides,
  };
}

function governedDetail(legacyStatus = "UNDER_REVIEW") {
  return {
    available: true,
    case: {
      caseId: "CASE-1",
      currentState: "TRIAGE_PENDING",
      stateVersion: 2,
      legacyStatus,
      migrationReviewStatus: "REVIEW_REQUIRED",
    },
    allowedActions: [],
    correlationId: "request-1",
  };
}

function mockWorkspaceRequests(investigationRecord) {
  apiRequest.mockImplementation((path) => {
    if (path === "/investigations/INV-1") {
      return response({ available: true, investigation: investigationRecord });
    }
    if (path === "/api/v1/cases/by-legacy-investigation/INV-1") {
      return response(governedDetail(investigationRecord.status));
    }
    throw new Error(`Unexpected request: ${path}`);
  });
}

function renderWorkspace() {
  return render(
    <MemoryRouter initialEntries={["/investigations/INV-1"]}>
      <Routes>
        <Route path="/investigations/:investigationId" element={<InvestigationWorkspacePage />} />
        <Route path="/claims/:claimId" element={<div>Claim page</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

describe("InvestigationWorkspacePage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    roleState.identity = {
      tenantId: "tenant-alpha",
      tenantLabel: "Alpha Medical Scheme",
      capabilities: [],
    };
  });
  afterEach(() => cleanup());

  test("does not expose disabled legacy confirmation even when the old capability is present", async () => {
    roleState.identity.capabilities = [
      "claims.view_own",
      "investigations.view",
      "investigations.confirm_fraud",
    ];
    mockWorkspaceRequests(investigation({ status: "CONFIRMED_FRAUD" }));

    renderWorkspace();

    expect(await screen.findByText("Legacy compatibility details")).toBeInTheDocument();
    expect(await screen.findByText("Governed case")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Open claim" })).toHaveAttribute("href", "/claims/CLAIM-1");
    expect(screen.queryByRole("button", { name: "Confirm fraud" })).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/Reason for fraud decision/i)).not.toBeInTheDocument();
    expect(apiRequest).toHaveBeenCalledTimes(2);
    expect(apiRequest).not.toHaveBeenCalledWith(
      "/investigations/confirm-fraud",
      expect.anything(),
    );
  });

  test("shows fraud analysts only the actions granted by supported capabilities", async () => {
    roleState.identity.capabilities = [
      "investigations.view",
      "investigations.change_priority",
      "investigations.add_note",
      "investigations.update_status",
    ];
    mockWorkspaceRequests(investigation());

    renderWorkspace();

    expect(await screen.findByText("Change priority")).toBeInTheDocument();
    expect(screen.getByLabelText("Investigation note")).toBeInTheDocument();
    expect(screen.queryByText("Update status")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Confirm fraud" })).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Register evidence reference" })).not.toBeInTheDocument();
  });
});
