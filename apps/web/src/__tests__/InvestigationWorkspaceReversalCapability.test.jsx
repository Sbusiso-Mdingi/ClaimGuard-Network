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
  fraudConfirmedAt: "2026-07-31T08:00:00.000Z",
  reversedAt: null,
  notes: [],
  evidence: [],
};

function response(body) {
  return Promise.resolve({ ok: true, json: async () => body });
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
    apiRequest.mockReturnValue(response({ available: true, investigation: confirmedInvestigation }));
  });

  afterEach(() => cleanup());

  test.each([
    ["confirmation authority", ["investigations.view", "investigations.confirm_fraud"]],
    ["reversal authority", ["investigations.view", "investigations.reverse_fraud"]],
  ])("%s does not expose legacy confirmation or reversal controls", async (_label, capabilities) => {
    roleState.identity.capabilities = capabilities;

    renderWorkspace();

    expect(await screen.findByText("Case details")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Reverse fraud finding" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Confirm fraud" })).not.toBeInTheDocument();
    expect(apiRequest).toHaveBeenCalledTimes(1);
    expect(apiRequest).not.toHaveBeenCalledWith(
      "/investigations/reverse-fraud",
      expect.anything(),
    );
  });
});
