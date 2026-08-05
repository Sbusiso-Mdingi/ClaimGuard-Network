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

function response(body, { ok = true } = {}) {
  return Promise.resolve({
    ok,
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
    fraudConfirmedAt: null,
    reversedAt: null,
    notes: [],
    evidence: [],
    ...overrides,
  };
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
    apiRequest.mockResolvedValue(
      await response({
        available: true,
        investigation: investigation({ status: "CONFIRMED_FRAUD" }),
      }),
    );

    renderWorkspace();

    expect(await screen.findByText("Case details")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Open claim" })).toHaveAttribute("href", "/claims/CLAIM-1");
    expect(screen.queryByRole("button", { name: "Confirm fraud" })).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/Reason for fraud decision/i)).not.toBeInTheDocument();
    expect(apiRequest).toHaveBeenCalledTimes(1);
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
    apiRequest.mockResolvedValue(
      await response({ available: true, investigation: investigation() }),
    );

    renderWorkspace();

    expect(await screen.findByText("Change priority")).toBeInTheDocument();
    expect(screen.getByLabelText("Investigation note")).toBeInTheDocument();
    expect(screen.queryByText("Update status")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Confirm fraud" })).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Register evidence reference" })).not.toBeInTheDocument();
  });
});
