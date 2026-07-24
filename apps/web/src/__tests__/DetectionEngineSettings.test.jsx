import React from "react";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("../lib/apiClient", () => ({ apiJson: vi.fn() }));

import { apiJson } from "../lib/apiClient";
import { DetectionEngineSettings } from "../features/investigator/DetectionEngineSettings";

function response(strategy) {
  return { available: true, strategy };
}

async function renderLoaded(strategy) {
  apiJson.mockResolvedValueOnce(response(strategy));
  render(<DetectionEngineSettings tenantId="tenant-alpha" />);
  await screen.findByRole("heading", { name: "Detection Model" });
  return userEvent.setup();
}

describe("DetectionEngineSettings", () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => cleanup());

  test("requires a model choice for a legacy deterministic configuration", async () => {
    await renderLoaded({
      strategyType: "selection_required",
      modelDeploymentId: null,
      requiresSelection: true,
      message: "Deterministic scoring is no longer selectable.",
    });

    expect(screen.getByText(/Deterministic scoring is no longer selectable/i)).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: /ClaimGuard Managed Model/i })).toHaveAttribute("aria-checked", "false");
    expect(screen.getByRole("radio", { name: /Custom Proprietary Model/i })).toHaveAttribute("aria-checked", "false");
    expect(screen.queryByRole("radio", { name: /rules/i })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save Model Selection" })).toBeDisabled();
  });

  test("selects the ClaimGuard-managed model without accepting a deployment ID", async () => {
    const user = await renderLoaded({
      strategyType: "selection_required",
      requiresSelection: true,
      message: "Choose an ML model.",
    });

    apiJson.mockResolvedValueOnce(response({
      strategyType: "claimguard_managed",
      modelDeploymentId: "claimguard-fraud-model:1.2.0",
    }));

    await user.click(screen.getByRole("radio", { name: /ClaimGuard Managed Model/i }));
    await user.type(screen.getByLabelText("Reason for change"), "Use the managed production model.");
    await user.click(screen.getByRole("button", { name: "Save Model Selection" }));

    expect(apiJson).toHaveBeenLastCalledWith("/detection/strategy", {
      method: "PUT",
      body: JSON.stringify({
        strategyType: "claimguard_managed",
        modelDeploymentId: null,
        changeReason: "Use the managed production model.",
      }),
    });
  });

  test("selects a registered proprietary model", async () => {
    const user = await renderLoaded({
      strategyType: "claimguard_managed",
      modelDeploymentId: "claimguard-fraud-model:1.2.0",
    });

    apiJson.mockResolvedValueOnce(response({
      strategyType: "scheme_managed",
      modelDeploymentId: "ubuntu-fraud-model:production",
    }));

    await user.click(screen.getByRole("radio", { name: /Custom Proprietary Model/i }));
    await user.type(
      screen.getByLabelText("Registered proprietary model deployment ID"),
      "ubuntu-fraud-model:production",
    );
    await user.type(screen.getByLabelText("Reason for change"), "Activate Ubuntu's validated proprietary model.");
    await user.click(screen.getByRole("button", { name: "Save Model Selection" }));

    expect(apiJson).toHaveBeenLastCalledWith("/detection/strategy", {
      method: "PUT",
      body: JSON.stringify({
        strategyType: "scheme_managed",
        modelDeploymentId: "ubuntu-fraud-model:production",
        changeReason: "Activate Ubuntu's validated proprietary model.",
      }),
    });
  });

  test("does not enable a proprietary selection without a deployment ID", async () => {
    const user = await renderLoaded({
      strategyType: "claimguard_managed",
      modelDeploymentId: "claimguard-fraud-model:1.2.0",
    });

    await user.click(screen.getByRole("radio", { name: /Custom Proprietary Model/i }));
    await user.type(screen.getByLabelText("Reason for change"), "Switch model.");

    expect(screen.getByRole("button", { name: "Save Model Selection" })).toBeDisabled();
  });
});
