import React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  workforce: {},
  apiJson: vi.fn(),
  reverifiedApiJson: vi.fn(),
  readSecret: vi.fn(),
  clearSecret: vi.fn(),
  signOut: vi.fn(),
}));

vi.mock("@clerk/react", () => ({
  SignIn: ({ fallbackRedirectUrl }) => <div>Clerk sign-in to {fallbackRedirectUrl}</div>,
}));
vi.mock("../context/WorkforceIdentityContext", () => ({
  useWorkforceIdentity: () => mocks.workforce,
}));
vi.mock("../hooks/useReverifiedApiJson", () => ({
  useReverifiedApiJson: () => mocks.reverifiedApiJson,
}));
vi.mock("../lib/apiClient", () => ({
  apiJson: mocks.apiJson,
  safeApiErrorMessage: (error, fallback) => error?.message || fallback,
}));
vi.mock("../lib/desktopAuthorizationSecret", () => ({
  readDesktopAuthorizationSecret: mocks.readSecret,
  clearDesktopAuthorizationSecret: mocks.clearSecret,
}));

import { DesktopAuthorizationPage } from "../features/auth/DesktopAuthorizationPage";

describe("DesktopAuthorizationPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.readSecret.mockReturnValue("b".repeat(43));
    mocks.apiJson.mockImplementation(async (path) => {
      if (path === "/auth/desktop/authorizations/claim") {
        return { requestId: "request-1" };
      }
      return {
        requestId: "request-1",
        licensedOrganisation: { organisationId: "org-1", displayName: "Alpha Health" },
      };
    });
    mocks.reverifiedApiJson.mockResolvedValue({ approved: true });
    mocks.workforce = {
      managed: true,
      isLoaded: true,
      isSignedIn: true,
      organisationId: "clerk-org-1",
      signOut: mocks.signOut,
    };
  });

  it("inspects and approves the one-time workstation request with Clerk reverification", async () => {
    render(<DesktopAuthorizationPage />);

    expect(await screen.findByText("Alpha Health")).toBeInTheDocument();
    expect(mocks.apiJson).toHaveBeenCalledWith(
      "/auth/desktop/authorizations/claim",
      expect.objectContaining({ body: JSON.stringify({ browserSecret: "b".repeat(43) }) }),
    );
    expect(mocks.apiJson).toHaveBeenCalledWith(
      "/auth/desktop/authorizations/inspect",
      expect.not.objectContaining({ body: expect.anything() }),
    );

    fireEvent.click(screen.getByRole("button", { name: "Authorise this workstation" }));
    expect(await screen.findByText("Workstation authorised")).toBeInTheDocument();
    expect(mocks.reverifiedApiJson).toHaveBeenCalledWith(
      "/auth/desktop/authorizations/approve",
      expect.not.objectContaining({ body: expect.anything() }),
    );
    expect(mocks.clearSecret).toHaveBeenCalledOnce();
  });

  it("keeps the request available and shows a safe error when approval fails", async () => {
    mocks.reverifiedApiJson.mockRejectedValue(new Error("Clerk verification was cancelled."));
    render(<DesktopAuthorizationPage />);

    fireEvent.click(await screen.findByRole("button", { name: "Authorise this workstation" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Clerk verification was cancelled.");
    expect(screen.getByRole("button", { name: "Authorise this workstation" })).toBeEnabled();
    expect(mocks.clearSecret).toHaveBeenCalledOnce();
  });

  it("fails closed for invalid links and organisations that are not selected", async () => {
    mocks.readSecret.mockReturnValue(null);
    mocks.apiJson.mockRejectedValueOnce(new Error("This desktop sign-in link is invalid."));
    const invalid = render(<DesktopAuthorizationPage />);
    expect(await screen.findByRole("alert")).toHaveTextContent("invalid");
    invalid.unmount();

    mocks.readSecret.mockReturnValue("b".repeat(43));
    mocks.workforce = { ...mocks.workforce, organisationId: null };
    render(<DesktopAuthorizationPage />);
    fireEvent.click(await screen.findByRole("button", { name: "Sign out" }));
    expect(mocks.signOut).toHaveBeenCalledWith({ redirectUrl: "/desktop/authorize" });
  });

  it("renders only the governed Clerk entry states", async () => {
    mocks.workforce = { ...mocks.workforce, managed: false };
    const unmanaged = render(<DesktopAuthorizationPage />);
    expect(screen.getByText("Clerk is required")).toBeInTheDocument();
    unmanaged.unmount();

    mocks.workforce = { ...mocks.workforce, managed: true, isLoaded: false };
    const loading = render(<DesktopAuthorizationPage />);
    expect(screen.getByText("Opening Clerk sign-in…")).toBeInTheDocument();
    loading.unmount();

    mocks.workforce = { ...mocks.workforce, isLoaded: true, isSignedIn: false };
    render(<DesktopAuthorizationPage />);
    await waitFor(() => expect(screen.getByText(/Clerk sign-in to/)).toBeInTheDocument());
    expect(screen.getByText(/\/desktop\/authorize/)).toBeInTheDocument();
  });
});
