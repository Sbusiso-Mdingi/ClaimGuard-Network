import React from "react";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("../lib/apiClient", () => ({
  apiJson: vi.fn(),
  ApiError: class ApiError extends Error {},
}));

import { apiJson } from "../lib/apiClient";
import { PlatformAdminPage } from "../features/investigator/PlatformAdminPage";

const organisations = [{
  organisationId: "org-ubuntu",
  displayName: "Ubuntu Medical Scheme",
  canonicalSlug: "ubuntu-medical",
  deploymentClass: "pilot",
  status: "active",
}];

function configureApi() {
  apiJson.mockImplementation((path, options = {}) => {
    if (path === "/admin/platform/global-detection-engine") {
      return Promise.resolve({ strategy: { modelDeploymentId: "deployment-1" } });
    }
    if (path === "/health") return Promise.resolve({ status: "ok" });
    if (path === "/ready") return Promise.resolve({ status: "ready", ready: true });
    if (path === "/admin/platform/organisations" && options.method === "POST") {
      return Promise.resolve({
        organisation: {
          organisationId: "org-new",
          displayName: "New Medical Scheme",
          canonicalSlug: "new-medical",
          deploymentClass: "demo",
          status: "draft",
        },
        provisioningReview: null,
      });
    }
    if (path === "/admin/platform/organisations") return Promise.resolve({ organisations });
    if (path === "/admin/platform/organisations/org-ubuntu") {
      return Promise.resolve({ organisation: organisations[0], operations: [], provisioningReview: null });
    }
    if (path === "/admin/platform/organisations/org-ubuntu/integration") {
      return Promise.resolve({
        guide: { endpoint: "/api/claims", successStatus: 202 },
        credentials: [],
      });
    }
    return Promise.reject(new Error(`Unexpected request: ${path}`));
  });
}

describe("PlatformAdminLifecyclePage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    configureApi();
  });

  afterEach(() => cleanup());

  test("preserves the draft organisation payload", async () => {
    render(<PlatformAdminPage />);
    const user = userEvent.setup();

    await screen.findByText("Ubuntu Medical Scheme");
    await user.type(screen.getByLabelText(/Organisation name/i), "New Medical Scheme");
    await user.type(screen.getByLabelText(/Canonical slug/i), "new-medical");
    await user.type(screen.getByLabelText(/Initial administrator name/i), "Nandi Dube");
    await user.type(screen.getByLabelText(/Initial administrator email/i), "nandi@example.com");
    await user.click(screen.getByRole("button", { name: /Create draft scheme/i }));

    await waitFor(() => {
      expect(apiJson).toHaveBeenCalledWith("/admin/platform/organisations", {
        method: "POST",
        body: JSON.stringify({
          displayName: "New Medical Scheme",
          canonicalSlug: "new-medical",
          deploymentClass: "demo",
          organisationType: "medical_scheme",
          initialAdministrator: { displayName: "Nandi Dube", email: "nandi@example.com" },
        }),
      });
    });

    expect(await screen.findByText(/Draft organisation created/i)).toBeInTheDocument();
  });

  test("enables only valid lifecycle actions for an active scheme", async () => {
    render(<PlatformAdminPage />);
    const user = userEvent.setup();

    await user.click(await screen.findByRole("button", { name: /Ubuntu Medical Scheme/i }));

    expect(await screen.findByRole("heading", { name: "Ubuntu Medical Scheme" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Request provisioning/i })).toBeEnabled();
    expect(screen.getByRole("button", { name: /Upgrade data plane/i })).toBeEnabled();
    expect(screen.getByRole("button", { name: /Activate organisation/i })).toBeDisabled();
    expect(screen.getByText("/api/claims")).toBeInTheDocument();
    expect(screen.getByText(/No integration credentials/i)).toBeInTheDocument();
  });
});
