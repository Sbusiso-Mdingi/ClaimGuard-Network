import React from "react";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
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

  test("requires a case-specific reason before publishing a fraud decision", async () => {
    roleState.identity.capabilities = [
      "claims.view_own",
      "investigations.view",
      "investigations.confirm_fraud",
    ];
    const confirmedCase = investigation({ status: "CONFIRMED_FRAUD" });
    apiRequest.mockImplementation((path, options = {}) => {
      if (path === "/investigations/INV-1" && !options.method) {
        return response({ available: true, investigation: confirmedCase });
      }
      if (path === "/investigations/confirm-fraud" && options.method === "POST") {
        return response({ available: true });
      }
      return response({ available: false, message: "Unexpected request" }, { ok: false });
    });

    renderWorkspace();
    const user = userEvent.setup();
    const confirmButton = await screen.findByRole("button", { name: "Confirm fraud" });

    expect(confirmButton).toBeDisabled();
    expect(screen.getByRole("link", { name: "Open claim" })).toHaveAttribute("href", "/claims/CLAIM-1");

    await user.type(
      screen.getByLabelText(/Reason for fraud decision/i),
      "Provider records and member confirmation support the finding.",
    );
    await user.click(confirmButton);

    await waitFor(() => {
      expect(apiRequest).toHaveBeenCalledWith("/investigations/confirm-fraud", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          investigationId: "INV-1",
          claimId: "CLAIM-1",
          reason: "Provider records and member confirmation support the finding.",
        }),
      });
    });
  });

  test("shows fraud analysts only the actions granted by their capabilities", async () => {
    roleState.identity.capabilities = [
      "investigations.view",
      "investigations.change_priority",
      "investigations.add_note",
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
