import React from "react";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("../lib/apiClient", () => ({ apiJson: vi.fn() }));

import { apiJson } from "../lib/apiClient";
import { DetectionEngineSettings } from "../features/investigator/DetectionEngineSettings";

function response(
  strategy,
  schemeOwned = ["ubuntu-fraud-model:production"],
) {
  return {
    available: true,
    strategy: {
      strategyId: 7,
      ...strategy,
    },
    modelCatalogue: {
      schemeOwned: schemeOwned.map((deploymentId) => ({
        deploymentId,
        displayName: deploymentId,
        ownership: "scheme",
      })),
    },
  };
}

async function renderLoaded(strategy) {
  apiJson.mockResolvedValueOnce(response(strategy));
  render(<DetectionEngineSettings tenantId="tenant-alpha" />);
  await screen.findByRole("heading", { name: "Model update policy" });
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
    expect(screen.getByRole("radio", { name: /Sequrin-managed updates/i })).toHaveAttribute("aria-checked", "false");
    expect(screen.getByRole("radio", { name: /Scheme-owned model pin/i })).toHaveAttribute("aria-checked", "false");
    expect(screen.queryByRole("radio", { name: /rules/i })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save Model Policy" })).toBeDisabled();
  });

  test("selects the Sequrin-managed model without accepting a deployment ID", async () => {
    const user = await renderLoaded({
      strategyType: "selection_required",
      requiresSelection: true,
      message: "Choose an ML model.",
    });

    apiJson.mockResolvedValueOnce(response({
      strategyType: "claimguard_managed",
      modelDeploymentId: "claimguard-fraud-model:1.2.0",
    }));

    await user.click(screen.getByRole("radio", { name: /Sequrin-managed updates/i }));
    await user.type(screen.getByLabelText("Reason for change"), "Use the managed production model.");
    await user.click(screen.getByRole("button", { name: "Save Model Policy" }));

    expect(apiJson).toHaveBeenLastCalledWith("/detection/strategy", {
      method: "PUT",
      body: JSON.stringify({
        strategyType: "claimguard_managed",
        modelDeploymentId: null,
        changeReason: "Use the managed production model.",
        expectedActiveStrategyId: 7,
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

    await user.click(screen.getByRole("radio", { name: /Scheme-owned model pin/i }));
    await user.selectOptions(
      screen.getByLabelText("Registered proprietary model"),
      "ubuntu-fraud-model:production",
    );
    await user.type(screen.getByLabelText("Reason for change"), "Activate Ubuntu's validated proprietary model.");
    await user.click(screen.getByRole("button", { name: "Save Model Policy" }));

    expect(apiJson).toHaveBeenLastCalledWith("/detection/strategy", {
      method: "PUT",
      body: JSON.stringify({
        strategyType: "scheme_managed",
        modelDeploymentId: "ubuntu-fraud-model:production",
        changeReason: "Activate Ubuntu's validated proprietary model.",
        expectedActiveStrategyId: 7,
      }),
    });
  });

  test("does not enable a proprietary selection without a deployment ID", async () => {
    const user = await renderLoaded({
      strategyType: "claimguard_managed",
      modelDeploymentId: "claimguard-fraud-model:1.2.0",
    });

    await user.click(screen.getByRole("radio", { name: /Scheme-owned model pin/i }));
    await user.type(screen.getByLabelText("Reason for change"), "Switch model.");

    expect(screen.getByRole("button", { name: "Save Model Policy" })).toBeDisabled();
  });

  test("does not allow a scheme administrator to type an unregistered deployment", async () => {
    const user = await renderLoaded({
      strategyType: "claimguard_managed",
      modelDeploymentId: "claimguard-fraud-model:1.2.0",
    });

    await user.click(screen.getByRole("radio", { name: /Scheme-owned model pin/i }));

    const selector = screen.getByLabelText("Registered proprietary model");
    expect(selector).toHaveRole("combobox");
    expect(selector).toHaveTextContent("ubuntu-fraud-model:production");
    expect(selector).not.toHaveTextContent("beta-fraud-model:production");
  });

  test("explains prospective pinning and managed rollout behaviour", async () => {
    await renderLoaded({
      strategyType: "claimguard_managed",
      modelDeploymentId: "claimguard-fraud-model:1.2.0",
    });

    expect(screen.getByText("Sequrin managed")).toBeInTheDocument();
    expect(screen.getAllByText("claimguard-fraud-model:1.2.0")).toHaveLength(2);
    expect(screen.getByText(/Eligible for audited Sequrin model rollouts/i)).toBeInTheDocument();
    expect(screen.getByText(/existing claims and historical outbox work are never rewritten/i)).toBeInTheDocument();
  });

  test("offers an audited activation when a newer managed deployment is available", async () => {
    const user = await renderLoaded({
      strategyType: "claimguard_managed",
      modelDeploymentId: "claimguard-fraud-model:1.1.0",
      updateAvailable: true,
      recommendedModelDeploymentId: "claimguard-fraud-model:1.2.0",
    });
    apiJson.mockResolvedValueOnce(response({
      strategyType: "claimguard_managed",
      modelDeploymentId: "claimguard-fraud-model:1.2.0",
      updateAvailable: false,
      recommendedModelDeploymentId: "claimguard-fraud-model:1.2.0",
    }));

    expect(screen.getByText("Managed model update available")).toBeInTheDocument();
    const applyButton = screen.getByRole("button", { name: "Apply Managed Model Update" });
    expect(applyButton).toBeDisabled();

    await user.type(screen.getByLabelText("Reason for change"), "Apply the validated fleet model update.");
    await user.click(applyButton);

    expect(apiJson).toHaveBeenLastCalledWith("/detection/strategy", {
      method: "PUT",
      body: JSON.stringify({
        strategyType: "claimguard_managed",
        modelDeploymentId: null,
        changeReason: "Apply the validated fleet model update.",
        expectedActiveStrategyId: 7,
      }),
    });
  });
});
