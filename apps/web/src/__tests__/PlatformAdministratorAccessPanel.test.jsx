import React from "react";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("../lib/apiClient", async (importOriginal) => ({
  ...(await importOriginal()),
  apiJson: vi.fn(),
}));
vi.mock("../hooks/useReverifiedApiJson", async () => {
  const { apiJson } = await import("../lib/apiClient");
  return { useReverifiedApiJson: () => apiJson };
});

import { apiJson } from "../lib/apiClient";
import { PlatformAdministratorAccessPanel } from "../features/investigator/PlatformAdministratorAccessPanel";

const invitationId = "12345678-1234-4123-8123-123456789abc";

function accessResponse({ withInvitation = false } = {}) {
  return {
    available: true,
    organisation: {
      organisationId: "org-platform",
      displayName: "ClaimGuard",
      organisationType: "platform",
    },
    administrators: [{
      userId: "platform-admin-1",
      displayName: "Primary Administrator",
      canonicalContact: "primary@example.com",
      userStatus: "active",
      membershipStatus: "active",
      roles: ["platform_administrator"],
    }],
    invitations: withInvitation
      ? [{
        invitationId,
        invitationType: "platform_administrator",
        email: "second@example.com",
        status: "pending",
        invitedBy: "platform-admin-1",
        createdAt: "2026-07-30T08:00:00.000Z",
        expiresAt: "2026-07-31T08:00:00.000Z",
        revocationConfirmation: "REVOKE 12345678",
      }]
      : [],
  };
}

describe("PlatformAdministratorAccessPanel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    let accessLoads = 0;
    apiJson.mockImplementation((path, options = {}) => {
      if (path === "/admin/platform/administrators") {
        accessLoads += 1;
        return Promise.resolve(accessResponse({
          withInvitation: accessLoads > 1,
        }));
      }
      if (
        path === "/admin/platform/administrators/invitations"
        && options.method === "POST"
      ) {
        return Promise.resolve({
          available: true,
          invitation: {
            invitationId,
            invitationType: "platform_administrator",
            email: "second@example.com",
            status: "pending",
          },
          invitationUrl: "https://clerk.example/invitations/clerk-invitation-1",
          auditEventId: "audit-create-1",
          message:
            "Platform administrator invitation created and delivered by Clerk.",
        });
      }
      return Promise.reject(new Error(`Unexpected request: ${path}`));
    });
  });

  afterEach(() => cleanup());

  test("creates a step-up-authenticated invitation and exposes its URL only in the creation result", async () => {
    render(<PlatformAdministratorAccessPanel />);
    const user = userEvent.setup();

    expect(await screen.findByText("Primary Administrator")).toBeInTheDocument();
    expect(screen.getByText("1 active")).toBeInTheDocument();

    await user.type(
      screen.getByLabelText("Administrator email"),
      "Second@Example.com",
    );
    await user.click(
      screen.getByRole("button", { name: "Review invitation" }),
    );

    expect(
      screen.getByRole("dialog", { name: "Invite second@example.com" }),
    ).toBeInTheDocument();
    await user.type(
      screen.getByLabelText("Confirmation"),
      "INVITE second@example.com AS PLATFORM ADMINISTRATOR",
    );
    await user.click(
      screen.getByRole("button", { name: "Create audited invitation" }),
    );

    await waitFor(() => {
      expect(apiJson).toHaveBeenCalledWith(
        "/admin/platform/administrators/invitations",
        {
          method: "POST",
          skipUnauthorizedHandler: true,
          body: JSON.stringify({
            email: "second@example.com",
            confirmation:
              "INVITE second@example.com AS PLATFORM ADMINISTRATOR",
          }),
        },
      );
    });
    expect(await screen.findByText(/Audit event audit-create-1/)).toBeInTheDocument();
    expect(
      screen.getByText("https://clerk.example/invitations/clerk-invitation-1"),
    ).toBeInTheDocument();
    expect(await screen.findByText("second@example.com")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Revoke" })).toBeInTheDocument();
  });

  test("does not render false administrator inventory when access is forbidden", async () => {
    apiJson.mockRejectedValueOnce(
      new Error("You do not have permission to perform this operation."),
    );

    render(<PlatformAdministratorAccessPanel />);

    expect(
      await screen.findByText("Platform administrator access unavailable"),
    ).toBeInTheDocument();
    expect(
      screen.getByText("You do not have permission to perform this operation."),
    ).toBeInTheDocument();
    expect(
      screen.queryByText("No platform administrators found"),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Review invitation" }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Retry access" }),
    ).toBeInTheDocument();
  });
});
