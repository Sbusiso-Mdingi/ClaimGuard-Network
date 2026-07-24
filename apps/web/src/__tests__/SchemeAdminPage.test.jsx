import React from "react";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("../lib/apiClient", () => ({ apiJson: vi.fn() }));
vi.mock("../context/RoleContext", () => ({
  useRole: () => ({
    identity: {
      tenantId: "tenant-ubuntu",
      tenantLabel: "Ubuntu Medical Scheme",
    },
  }),
}));
vi.mock("../features/investigator/DetectionEngineSettings", () => ({
  DetectionEngineSettings: () => <div>Detection Model</div>,
}));

import { apiJson } from "../lib/apiClient";
import { SchemeAdminPage } from "../features/investigator/SchemeAdminPage";

describe("SchemeAdminPage", () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => cleanup());

  test("serializes the complete new-user payload as JSON", async () => {
    apiJson
      .mockResolvedValueOnce({ available: true, users: [] })
      .mockResolvedValueOnce({ available: true, user: { userId: "user-1", displayName: "Test Analyst" } })
      .mockResolvedValueOnce({ available: true, users: [] });

    render(<SchemeAdminPage />);
    const user = userEvent.setup();

    await screen.findByText("No users found.");
    await user.type(screen.getByLabelText("Display Name"), "Test Analyst");
    await user.type(screen.getByLabelText("Username"), "analyst@ubuntu.example");
    await user.type(screen.getByLabelText("Password"), "StrongPass123!");
    await user.selectOptions(screen.getByLabelText("Role"), "fraud_analyst");
    await user.click(screen.getByRole("button", { name: "Create User" }));

    await waitFor(() => {
      expect(apiJson).toHaveBeenCalledWith("/admin/scheme/users", {
        method: "POST",
        body: JSON.stringify({
          displayName: "Test Analyst",
          username: "analyst@ubuntu.example",
          password: "StrongPass123!",
          roleKey: "fraud_analyst",
        }),
      });
    });
  });
});
