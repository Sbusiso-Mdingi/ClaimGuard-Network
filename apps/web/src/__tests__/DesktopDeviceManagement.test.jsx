import React from "react";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("../lib/apiClient", () => ({ apiJson: vi.fn() }));
vi.mock("../context/RoleContext", () => ({
  useRole: () => ({ identity: { organisationId: "org-alpha" } }),
}));

import { apiJson } from "../lib/apiClient";
import { DesktopDeviceManagement } from "../features/investigator/DesktopDeviceManagement";

const snapshot = {
  available: true,
  policy: { deviceLimit: 7, offlineGraceDays: 5 },
  devices: [{
    deviceEnrollmentId: "device-1",
    installationId: "WINDOWS-ALPHA",
    status: "active",
    activatedAt: "2026-08-01T08:00:00.000Z",
    lastSeenAt: "not-a-date",
  }],
  activationKeys: [{
    activationKeyId: "key-1",
    status: "pending",
    issuedAt: "2026-08-01T07:00:00.000Z",
    expiresAt: "2026-08-02T07:00:00.000Z",
    useCount: 0,
    maximumUses: 1,
  }],
  auditHistory: [{
    desktopAuditEventId: "audit-1",
    action: "activation_key_issued",
    outcome: "success",
    occurredAt: "2026-08-01T07:00:00.000Z",
    correlationId: null,
  }],
};

describe("DesktopDeviceManagement", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(window, "prompt").mockReturnValue(null);
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  test("loads the organisation-bound policy, devices, keys, and audit history", async () => {
    apiJson.mockResolvedValue(snapshot);

    render(<DesktopDeviceManagement />);

    expect(await screen.findByText("WINDOWS-ALPHA")).toBeInTheDocument();
    expect(screen.getByText("of 7 licensed devices")).toBeInTheDocument();
    expect(screen.getByText("5 days")).toBeInTheDocument();
    expect(screen.getByText("key-1")).toBeInTheDocument();
    expect(screen.getByText("Activation Key Issued")).toBeInTheDocument();
    expect(screen.getByText(/correlation not supplied/i)).toBeInTheDocument();
    expect(screen.getByText(/last seen Not available/i)).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: /Refresh/i }));
    await waitFor(() => expect(apiJson).toHaveBeenCalledTimes(2));
  });

  test("issues a one-time key with step-up credentials and copies it", async () => {
    apiJson.mockImplementation((path, options) => {
      if (options?.method === "POST") {
        return Promise.resolve({
          available: true,
          activationKey: {
            activationKey: "CG-ACTIVATION-ONE-TIME",
            expiresAt: "2026-08-02T08:00:00.000Z",
            maximumUses: 2,
          },
        });
      }
      return Promise.resolve(snapshot);
    });
    render(<DesktopDeviceManagement />);
    const user = userEvent.setup();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });

    await screen.findByText("WINDOWS-ALPHA");
    await user.clear(screen.getByLabelText("Expires in hours"));
    await user.type(screen.getByLabelText("Expires in hours"), "48");
    await user.clear(screen.getByLabelText("Maximum uses"));
    await user.type(screen.getByLabelText("Maximum uses"), "2");
    await user.type(screen.getByLabelText("Current password"), "StrongPass123!");
    await user.type(screen.getByLabelText("Confirmation"), "ISSUE DESKTOP KEY");
    await user.click(screen.getByRole("button", { name: "Issue activation key" }));

    await waitFor(() => expect(apiJson).toHaveBeenCalledWith(
      "/admin/desktop/organisations/org-alpha/activation-keys",
      {
        method: "POST",
        body: JSON.stringify({
          expiresInHours: 48,
          maximumUses: 2,
          password: "StrongPass123!",
          confirmation: "ISSUE DESKTOP KEY",
        }),
      },
    ));
    expect(await screen.findByTestId("one-time-activation-key")).toHaveTextContent("CG-ACTIVATION-ONE-TIME");
    expect(screen.getByLabelText("Current password")).toHaveValue("");
    await user.click(screen.getByRole("button", { name: /Copy key/i }));
    expect(writeText).toHaveBeenCalledWith("CG-ACTIVATION-ONE-TIME");
  });

  test("requires exact prompts before revoking devices and activation keys", async () => {
    apiJson.mockImplementation((_path, options) => Promise.resolve(options?.method === "POST" ? { available: true } : snapshot));
    render(<DesktopDeviceManagement />);
    const user = userEvent.setup();

    await screen.findByText("WINDOWS-ALPHA");
    window.prompt.mockReturnValueOnce(null);
    await user.click(screen.getByRole("button", { name: "Revoke device" }));
    expect(apiJson).not.toHaveBeenCalledWith(expect.stringContaining("/revoke"), expect.anything());

    window.prompt.mockReturnValueOnce("StrongPass123!").mockReturnValueOnce("wrong confirmation");
    await user.click(screen.getByRole("button", { name: "Revoke unused key" }));
    expect(apiJson).not.toHaveBeenCalledWith(expect.stringContaining("/revoke"), expect.anything());

    window.prompt.mockReturnValueOnce("StrongPass123!").mockReturnValueOnce("REVOKE DEVICE device-1");
    await user.click(screen.getByRole("button", { name: "Revoke device" }));
    await waitFor(() => expect(apiJson).toHaveBeenCalledWith(
      "/admin/desktop/organisations/org-alpha/devices/device-1/revoke",
      {
        method: "POST",
        body: JSON.stringify({ password: "StrongPass123!", confirmation: "REVOKE DEVICE device-1" }),
      },
    ));

    window.prompt.mockReturnValueOnce("StrongPass123!").mockReturnValueOnce("REVOKE KEY key-1");
    await user.click(screen.getByRole("button", { name: "Revoke unused key" }));
    await waitFor(() => expect(apiJson).toHaveBeenCalledWith(
      "/admin/desktop/organisations/org-alpha/activation-keys/key-1/revoke",
      {
        method: "POST",
        body: JSON.stringify({ password: "StrongPass123!", confirmation: "REVOKE KEY key-1" }),
      },
    ));
  });

  test("keeps an actionable error visible when loading or key issuance fails", async () => {
    apiJson.mockRejectedValueOnce(new Error("Desktop administration unavailable"));
    const { unmount } = render(<DesktopDeviceManagement />);
    expect(await screen.findByText("Desktop administration unavailable")).toBeInTheDocument();
    expect(screen.getByText("No desktop devices enrolled")).toBeInTheDocument();
    unmount();

    apiJson.mockImplementation((_path, options) => (
      options?.method === "POST"
        ? Promise.reject(new Error("Activation key rejected"))
        : Promise.resolve(snapshot)
    ));
    render(<DesktopDeviceManagement />);
    const user = userEvent.setup();
    await screen.findByText("WINDOWS-ALPHA");
    await user.type(screen.getByLabelText("Current password"), "StrongPass123!");
    await user.type(screen.getByLabelText("Confirmation"), "ISSUE DESKTOP KEY");
    await user.click(screen.getByRole("button", { name: "Issue activation key" }));
    expect(await screen.findByText("Activation key rejected")).toBeInTheDocument();
  });
});
