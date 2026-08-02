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
      investigations: [],
      dashboard: null,
      suspiciousNetwork: null,
    },
    session: null,
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

  it("filters cached claims, opens authoritative detail, and follows a linked investigation", async () => {
    const calls = [];
    const linkedInvestigation = {
      investigationId: "INV-LINKED-1",
      claimId: "CLAIM-HIGH-1",
      status: "UNDER_REVIEW",
      priority: "HIGH",
      assignedInvestigator: "investigator-alpha",
      updatedAt: "2026-08-01T10:15:00.000Z",
    };
    const currentStatus = baseStatus({
      authenticated: true,
      cache: {
        freshness: "Fresh",
        lastSuccessfulSyncAt: "2026-08-01T10:00:00.000Z",
        claims: [
          {
            claimId: "CLAIM-HIGH-1",
            serviceDate: "2026-07-30",
            billedAmount: 2450,
            billingCode: "PROC-HIGH",
            status: "FLAGGED",
            riskScore: 88,
            investigation: linkedInvestigation,
          },
          {
            claimId: "CLAIM-LOW-1",
            serviceDate: "2026-07-29",
            billedAmount: 180,
            billingCode: "PROC-LOW",
            status: "SCORED",
            riskScore: 18,
          },
        ],
        investigations: [linkedInvestigation],
        dashboard: { summary: { totalClaims: 2, highRiskClaims: 1 } },
        suspiciousNetwork: null,
      },
      session: { clientCapabilities: ["investigations.view"] },
    });
    setDesktopInvokeForTests(async (command, args) => {
      calls.push([command, args]);
      if (command === "desktop_status" || command === "synchronize_desktop") return currentStatus;
      if (command === "desktop_claim_details") {
        return {
          available: true,
          fetchedAt: "2026-08-01T10:16:00.000Z",
          claim: {
            ...currentStatus.cache.claims[0],
            submittedAt: "2026-07-30T08:00:00.000Z",
            memberId: "member-token-1",
            providerId: "provider-token-1",
            processingStatus: "SCORED",
            currentClaimVersion: 3,
            evidence: ["Billing frequency exceeds the peer baseline."],
            triggeredRules: ["FREQUENCY_SPIKE"],
          },
        };
      }
      if (command === "desktop_investigation_details") {
        return { available: true, investigation: { ...linkedInvestigation, notes: [], evidence: [] } };
      }
      throw new Error(`unexpected ${command}`);
    });

    render(<DesktopApp />);
    await userEvent.click((await screen.findAllByRole("button", { name: "Claims" }))[0]);
    await userEvent.type(screen.getByLabelText("Search claims"), "PROC-HIGH");
    await userEvent.selectOptions(screen.getByLabelText("Risk band"), "high");
    expect(screen.getByText("Showing 1 of 2 cached claims")).toBeInTheDocument();
    expect(screen.queryByText("CLAIM-LOW-1")).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Open" }));
    expect(await screen.findByText("Authoritative claim detail")).toBeInTheDocument();
    expect(screen.getByText("Billing frequency exceeds the peer baseline.")).toBeInTheDocument();
    expect(screen.getByText("Frequency Spike")).toBeInTheDocument();
    expect(screen.getByText("member-token-1")).toBeInTheDocument();
    expect(calls).toContainEqual(["desktop_claim_details", { claimId: "CLAIM-HIGH-1" }]);

    await userEvent.click(screen.getByRole("button", { name: "Open case" }));
    expect(await screen.findByText("Investigation workspace")).toBeInTheDocument();
    expect(calls).toContainEqual(["desktop_investigation_details", { investigationId: "INV-LINKED-1" }]);
  });
});

describe("ClaimGuard desktop investigation workspace", () => {
  it("loads case evidence and submits status and priority with the loaded version", async () => {
    const calls = [];
    const currentStatus = baseStatus({
      authenticated: true,
      cache: {
        freshness: "Fresh",
        lastSuccessfulSyncAt: "2026-08-01T10:00:00.000Z",
        claims: [{ claimId: "CLAIM-1", status: "FLAGGED", riskScore: 91 }],
        investigations: [{
          investigationId: "INV-1",
          claimId: "CLAIM-1",
          assignedInvestigator: "investigator-alpha",
          assignedBy: "analyst-alpha",
          status: "OPEN",
          priority: "NORMAL",
          createdAt: "2026-08-01T09:00:00.000Z",
          updatedAt: "2026-08-01T10:00:00.000Z",
        }],
        dashboard: null,
        suspiciousNetwork: null,
      },
      session: {
        clientCapabilities: [
          "investigations.view",
          "investigations.update_status",
          "investigations.change_priority",
        ],
      },
    });
    setDesktopInvokeForTests(async (command, args) => {
      calls.push([command, args]);
      if (command === "desktop_status" || command === "synchronize_desktop") return currentStatus;
      if (command === "desktop_investigation_details") {
        return {
          available: true,
          investigation: {
            ...currentStatus.cache.investigations[0],
            notes: [{ noteId: "NOTE-1", noteType: "MEDICAL_REVIEW", text: "Provider invoice does not match the member interview.", author: "analyst-alpha", timestamp: "2026-08-01T09:30:00.000Z" }],
            evidence: [{ evidenceId: "EVIDENCE-1", evidenceType: "INVOICE", filename: "invoice.pdf", description: "Provider invoice", uploadedBy: "investigator-alpha", uploadedAt: "2026-08-01T09:45:00.000Z" }],
          },
        };
      }
      if (command === "desktop_update_investigation") {
        const investigation = {
          ...currentStatus.cache.investigations[0],
          status: args.status,
          priority: args.priority,
          updatedAt: "2026-08-01T10:05:00.000Z",
        };
        return {
          status: {
            ...currentStatus,
            cache: { ...currentStatus.cache, investigations: [investigation] },
          },
          investigation,
        };
      }
      throw new Error(`unexpected ${command}`);
    });

    render(<DesktopApp />);
    await userEvent.click((await screen.findAllByRole("button", { name: /Investigations 1/i }))[0]);
    await userEvent.click(screen.getByRole("button", { name: "Open case" }));
    expect(await screen.findByText("Provider invoice does not match the member interview.")).toBeInTheDocument();
    expect(screen.getByText("invoice.pdf")).toBeInTheDocument();

    await userEvent.selectOptions(screen.getByLabelText("Investigation status"), "UNDER_REVIEW");
    await userEvent.selectOptions(screen.getByLabelText("Investigation priority"), "HIGH");
    await userEvent.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() => expect(calls.some(([command]) => command === "desktop_update_investigation")).toBe(true));
    expect(calls.find(([command]) => command === "desktop_update_investigation")).toEqual([
      "desktop_update_investigation",
      {
        investigationId: "INV-1",
        expectedUpdatedAt: "2026-08-01T10:00:00.000Z",
        status: "UNDER_REVIEW",
        priority: "HIGH",
      },
    ]);
  });

  it("keeps the investigation queue unavailable without the view capability", async () => {
    const currentStatus = baseStatus({
      authenticated: true,
      cache: { freshness: "Fresh", claims: [], investigations: [], dashboard: null, suspiciousNetwork: null },
      session: { clientCapabilities: ["claims.view_own"] },
    });
    setDesktopInvokeForTests(async (command) => {
      if (command === "desktop_status" || command === "synchronize_desktop") return currentStatus;
      throw new Error(`unexpected ${command}`);
    });

    render(<DesktopApp />);
    expect(await screen.findByText("Investigation access not assigned")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Investigations/i })).not.toBeInTheDocument();
  });

  it("refreshes authoritative case detail after a stale write is rejected", async () => {
    const detailVersions = [];
    const compact = {
      investigationId: "INV-STALE",
      claimId: "CLAIM-STALE",
      status: "OPEN",
      priority: "NORMAL",
      updatedAt: "2026-08-01T10:00:00.000Z",
    };
    const currentStatus = baseStatus({
      authenticated: true,
      cache: { freshness: "Fresh", claims: [], investigations: [compact], dashboard: null, suspiciousNetwork: null },
      session: { clientCapabilities: ["investigations.view", "investigations.update_status"] },
    });
    setDesktopInvokeForTests(async (command) => {
      if (command === "desktop_status" || command === "synchronize_desktop") return currentStatus;
      if (command === "desktop_investigation_details") {
        const refreshed = detailVersions.length > 0;
        const investigation = refreshed
          ? { ...compact, status: "AWAITING_EVIDENCE", updatedAt: "2026-08-01T10:05:00.000Z" }
          : compact;
        detailVersions.push(investigation.updatedAt);
        return { available: true, investigation };
      }
      if (command === "desktop_update_investigation") {
        throw new Error("STALE_RECORD_VERSION:The investigation changed after it was loaded.");
      }
      throw new Error(`unexpected ${command}`);
    });

    render(<DesktopApp />);
    await userEvent.click((await screen.findAllByRole("button", { name: /Investigations 1/i }))[0]);
    await userEvent.click(screen.getByRole("button", { name: "Open case" }));
    await screen.findByText("Investigation workspace");
    await userEvent.selectOptions(screen.getByLabelText("Investigation status"), "UNDER_REVIEW");
    await userEvent.click(screen.getByRole("button", { name: "Save changes" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/changed on the server/i);
    await waitFor(() => expect(detailVersions).toEqual([
      "2026-08-01T10:00:00.000Z",
      "2026-08-01T10:05:00.000Z",
    ]));
    expect(screen.getByLabelText("Investigation status")).toHaveValue("AWAITING_EVIDENCE");
  });
});
