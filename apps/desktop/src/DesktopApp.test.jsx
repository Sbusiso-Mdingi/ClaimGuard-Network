import React from "react";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { DesktopApp } from "./DesktopApp";
import { setDesktopInvokeForTests } from "./desktopBridge";

function baseStatus(overrides = {}) {
  return {
    activationRequired: false,
    authenticated: false,
    locked: false,
    lockReason: null,
    enrollment: {
      organisationId: "org-alpha",
      organisationDisplayName: "Alpha Medical",
    },
    cache: {
      freshness: "Stale",
      lastSuccessfulSyncAt: "2026-08-01T00:00:00.000Z",
      claims: [],
      dashboard: null,
    },
    ...overrides,
  };
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("ClaimGuard desktop organisation lock", () => {
  it("requires activation on first launch without exposing organisation or API selectors", async () => {
    setDesktopInvokeForTests(async (command) => {
      if (command === "desktop_status") return { activationRequired: true };
      throw new Error(`unexpected ${command}`);
    });
    render(<DesktopApp />);
    expect(await screen.findByRole("heading", { name: /activate this trusted/i })).toBeInTheDocument();
    expect(screen.getByLabelText("Organisation Activation Key")).toBeInTheDocument();
    expect(screen.queryByLabelText(/^Organisation$/i)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/API.*(URL|origin)/i)).not.toBeInTheDocument();
  });

  it("shows the licensed organisation read-only and omits the web tenant selector", async () => {
    setDesktopInvokeForTests(async (command) => {
      if (command === "desktop_status") return baseStatus();
      throw new Error(`unexpected ${command}`);
    });
    render(<DesktopApp />);
    expect(await screen.findByTestId("licensed-organisation")).toHaveTextContent("Alpha Medical");
    expect(screen.queryByLabelText(/^Organisation$/i)).not.toBeInTheDocument();
    expect(screen.getByLabelText("Username")).toBeInTheDocument();
    expect(screen.getByLabelText("Password")).toBeInTheDocument();
  });

  it("login sends only user credentials and never an organisation value", async () => {
    const calls = [];
    setDesktopInvokeForTests(async (command, args) => {
      calls.push([command, args]);
      if (command === "desktop_status") return baseStatus();
      if (command === "desktop_login") return baseStatus({ authenticated: true, cache: { freshness: "Fresh", claims: [], dashboard: null } });
      if (command === "synchronize_desktop") return baseStatus({ authenticated: true, cache: { freshness: "Fresh", claims: [], dashboard: null } });
      throw new Error(`unexpected ${command}`);
    });
    render(<DesktopApp />);
    await userEvent.type(await screen.findByLabelText("Username"), "analyst");
    await userEvent.type(screen.getByLabelText("Password"), "secret-password");
    await userEvent.click(screen.getByRole("button", { name: "Sign in" }));
    await waitFor(() => expect(calls.some(([command]) => command === "desktop_login")).toBe(true));
    const loginCall = calls.find(([command]) => command === "desktop_login");
    expect(loginCall[1]).toEqual({ username: "analyst", password: "secret-password" });
    expect(JSON.stringify(loginCall[1])).not.toMatch(/organisation|tenant|origin/i);
  });
});

describe("ClaimGuard desktop cache behaviour", () => {
  it("renders cached claim summaries before background synchronization completes", async () => {
    const neverCompletes = new Promise(() => {});
    setDesktopInvokeForTests(async (command) => {
      if (command === "desktop_status") return baseStatus({
        authenticated: true,
        cache: {
          freshness: "Stale",
          lastSuccessfulSyncAt: "2026-07-31T23:59:00.000Z",
          dashboard: { summary: { totalClaims: 2000, highRiskClaims: 12 } },
          claims: [{ claimId: "CLAIM-CACHED-1", serviceDate: "2026-07-31", billedAmount: 1200, status: "FLAGGED", riskScore: 82 }],
        },
      });
      if (command === "synchronize_desktop") return neverCompletes;
      throw new Error(`unexpected ${command}`);
    });
    render(<DesktopApp />);
    expect(await screen.findByText("CLAIM-CACHED-1")).toBeInTheDocument();
    expect(screen.getByText("Cached claim summaries")).toBeInTheDocument();
  });

  it("marks offline cache data visibly and blocks operational writes", async () => {
    setDesktopInvokeForTests(async (command) => {
      if (command === "desktop_status") return baseStatus({
        authenticated: true,
        cache: { freshness: "Offline", claims: [{ claimId: "OFFLINE-1", status: "FLAGGED" }], dashboard: null },
      });
      if (command === "synchronize_desktop") return new Promise(() => {});
      throw new Error(`unexpected ${command}`);
    });
    render(<DesktopApp />);
    expect(await screen.findByText("Offline data is read-only")).toBeInTheDocument();
    expect(screen.getByText("Offline", { selector: "span" })).toBeInTheDocument();
    expect(screen.getByText(/Investigation creation, notes, evidence/i)).toBeInTheDocument();
  });
});
