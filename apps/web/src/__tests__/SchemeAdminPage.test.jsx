import React from "react";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("../lib/apiClient", async (importOriginal) => ({
  ...(await importOriginal()),
  apiJson: vi.fn(),
}));
vi.mock("../context/RoleContext", () => ({
  useRole: () => ({
    identity: {
      tenantId: "tenant-ubuntu",
      tenantLabel: "Ubuntu Medical Scheme",
      capabilities: ["tenant_status.view", "users.manage_tenant"],
    },
  }),
}));
vi.mock("../features/investigator/DetectionEngineSettings", () => ({
  DetectionEngineSettings: () => <div>Detection Model</div>,
}));

import { apiJson } from "../lib/apiClient";
import { SchemeAdminPage } from "../features/investigator/SchemeAdminPage";

const overviewResponse = {
  available: true,
  overview: {
    generatedAt: "2026-07-25T08:00:00.000Z",
    claims: {
      total: 12,
      scored: 8,
      awaitingScoring: 3,
      failed: 1,
      notScored: 0,
      completionRate: 66.67,
    },
    processing: {
      queued: 2,
      processing: 1,
      retrying: 0,
      failed: 1,
      scored: 8,
      notScored: 0,
    },
    investigations: {
      claimsWithInvestigations: 4,
      byStatus: { open: 3, under_review: 1 },
    },
    detectionStrategy: {
      strategyType: "approved_model",
      modelDeploymentId: "deployment-1",
      activatedAt: "2026-07-25T07:00:00.000Z",
      changeReason: "Approved production model",
    },
  },
};

describe("SchemeAdminPage", () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => cleanup());

  test("renders authoritative scheme operations metrics and normalised labels", async () => {
    apiJson.mockImplementation((path) => {
      if (path === "/admin/scheme/overview") return Promise.resolve(overviewResponse);
      if (path === "/admin/scheme/users") return Promise.resolve({ available: true, users: [] });
      return Promise.reject(new Error("Unexpected request"));
    });

    render(<SchemeAdminPage />);

    expect(await screen.findByText("12")).toBeInTheDocument();
    expect(screen.getByText("66.67% of all claims have a persisted score.")).toBeInTheDocument();
    expect(screen.getByText("Approved Model")).toBeInTheDocument();
    expect(screen.getByText("Under Review")).toBeInTheDocument();
    expect(screen.getByText("deployment-1")).toBeInTheDocument();
    expect(screen.getByText("Integration credentials")).toBeInTheDocument();
    expect(screen.getAllByText("API required").length).toBe(2);
    expect(screen.getByText("No users found.")).toBeInTheDocument();
  });

  test("serializes the Clerk workforce invitation without local credentials", async () => {
    apiJson.mockImplementation((path, options) => {
      if (path === "/admin/scheme/overview") return Promise.resolve(overviewResponse);
      if (path === "/admin/scheme/users" && options?.method === "POST") {
        return Promise.resolve({ available: true, user: { userId: "user-1", displayName: "Test Analyst" } });
      }
      if (path === "/admin/scheme/users") return Promise.resolve({ available: true, users: [] });
      return Promise.reject(new Error("Unexpected request"));
    });

    render(<SchemeAdminPage />);
    const user = userEvent.setup();

    await screen.findByText("No users found.");
    await user.type(screen.getByLabelText(/Work email/i), "analyst@ubuntu.example");
    await user.selectOptions(screen.getByLabelText(/Role/i), "fraud_analyst");
    await user.click(screen.getByRole("button", { name: /Send Clerk invitation/i }));

    await waitFor(() => {
      expect(apiJson).toHaveBeenCalledWith("/admin/scheme/users", {
        method: "POST",
        body: JSON.stringify({
          email: "analyst@ubuntu.example",
          roleKey: "fraud_analyst",
        }),
      });
    });

    expect(await screen.findByText("Clerk workforce invitation sent successfully.")).toBeInTheDocument();
  });

  test("shows an actionable overview error without hiding user administration", async () => {
    apiJson.mockImplementation((path) => {
      if (path === "/admin/scheme/overview") return Promise.reject(new Error("Overview unavailable"));
      if (path === "/admin/scheme/users") return Promise.resolve({ available: true, users: [] });
      return Promise.reject(new Error("Unexpected request"));
    });

    render(<SchemeAdminPage />);

    expect(await screen.findByRole("alert")).toHaveTextContent("Overview unavailable");
    expect(screen.getByRole("button", { name: /Retry overview/i })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /Users and roles/i })).toBeInTheDocument();
  });

  test("requires inline confirmation before disabling a tenant user", async () => {
    let disabled = false;
    apiJson.mockImplementation((path, options) => {
      if (path === "/admin/scheme/overview") return Promise.resolve(overviewResponse);
      if (path === "/admin/scheme/users/user-1" && options?.method === "DELETE") {
        disabled = true;
        return Promise.resolve({ available: true });
      }
      if (path === "/admin/scheme/users") {
        return Promise.resolve({
          available: true,
          users: [{
            userId: "user-1",
            displayName: "Ubuntu Investigator",
            username: "investigator@ubuntu.example",
            userStatus: disabled ? "disabled" : "active",
            roles: ["investigator"],
          }],
        });
      }
      return Promise.reject(new Error("Unexpected request"));
    });

    render(<SchemeAdminPage />);
    const user = userEvent.setup();

    const disableButton = await screen.findByRole("button", { name: "Disable user" });
    await user.click(disableButton);

    expect(apiJson).not.toHaveBeenCalledWith("/admin/scheme/users/user-1", { method: "DELETE" });
    await user.click(screen.getByRole("button", { name: "Confirm disable" }));

    await waitFor(() => {
      expect(apiJson).toHaveBeenCalledWith("/admin/scheme/users/user-1", { method: "DELETE" });
    });
    expect(await screen.findByText("User disabled successfully.")).toBeInTheDocument();
  });
});
