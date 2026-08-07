import React from "react";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
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

describe("Sequrin desktop organisation lock", () => {
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

  it("shows a stale-authority reauthentication message when initial status resolution is stale", async () => {
    setDesktopInvokeForTests(async (command) => {
      if (command === "desktop_status") {
        const error = new Error("The session authorization version is stale.");
        error.code = "ACCESS_AUTHORIZATION_VERSION_STALE";
        throw error;
      }
      throw new Error(`unexpected ${command}`);
    });
    render(<DesktopApp />);
    expect(await screen.findByText(/your server-side access changed\. sign in again to refresh this workstation's authority\./i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Sign in" })).toBeInTheDocument();
  });

  it("locks to reauthentication with a stale-authority message when login authority is stale", async () => {
    const calls = [];
    setDesktopInvokeForTests(async (command, args) => {
      calls.push([command, args]);
      if (command === "desktop_status") return baseStatus();
      if (command === "desktop_login") {
        const error = new Error("The session authorization version is stale.");
        error.code = "ACCESS_AUTHORIZATION_VERSION_STALE";
        throw error;
      }
      throw new Error(`unexpected ${command}`);
    });
    render(<DesktopApp />);
    await userEvent.type(await screen.findByLabelText("Username"), "analyst");
    await userEvent.type(screen.getByLabelText("Password"), "secret-password");
    await userEvent.click(screen.getByRole("button", { name: "Sign in" }));
    expect(await screen.findByText(/your server-side access changed\. sign in again to refresh this workstation's authority\./i)).toBeInTheDocument();
    expect(calls.some(([command]) => command === "desktop_login")).toBe(true);
  });
});

describe("Sequrin desktop cache behaviour", () => {
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
    const offlineStatus = baseStatus({
      authenticated: true,
      cache: { freshness: "Offline", claims: [{ claimId: "OFFLINE-1", status: "FLAGGED" }], dashboard: null },
    });
    setDesktopInvokeForTests(async (command) => {
      if (command === "desktop_status" || command === "synchronize_desktop") return offlineStatus;
      if (command === "desktop_claim_details") return {
        available: true,
        fetchedAt: "2026-08-01T09:00:00.000Z",
        claim: { claimId: "OFFLINE-1", status: "FLAGGED", currentClaimVersion: 1 },
      };
      throw new Error(`unexpected ${command}`);
    });
    render(<DesktopApp />);
    expect(await screen.findByText("Offline data is read-only")).toBeInTheDocument();
    expect(screen.getByText("Offline", { selector: "span" })).toBeInTheDocument();
    expect(screen.getByText(/Investigation creation.*notes, evidence.*governed actions/i)).toBeInTheDocument();

    await userEvent.click((await screen.findAllByRole("button", { name: "Claims" }))[0]);
    await userEvent.click(screen.getByRole("button", { name: "Open" }));
    const dialog = await screen.findByRole("dialog", { name: "Claim OFFLINE-1" });
    expect(within(dialog).getByRole("status")).toHaveTextContent(/last cached claim detail/i);
  });

  it("keeps loading and read errors inside the open detail dialog", async () => {
    let rejectDetails;
    const pendingDetails = new Promise((_resolve, reject) => { rejectDetails = reject; });
    const currentStatus = baseStatus({
      authenticated: true,
      cache: {
        freshness: "Fresh",
        claims: [],
        investigations: [],
        dashboard: null,
        suspiciousNetwork: {
          summary: {},
          nodes: [],
          edges: [{ cluster_id: "cluster-1", claim_id: "CLAIM-REMOTE-1", billed_amount: 900, risk_score: 78 }],
        },
      },
    });
    setDesktopInvokeForTests(async (command) => {
      if (command === "desktop_status" || command === "synchronize_desktop") return currentStatus;
      if (command === "desktop_claim_details") return pendingDetails;
      throw new Error(`unexpected ${command}`);
    });

    render(<DesktopApp />);
    await userEvent.click((await screen.findAllByRole("button", { name: "Risk signals" }))[0]);
    await userEvent.click(screen.getByRole("button", { name: /CLAIM-REMOTE-1/i }));
    const dialog = await screen.findByRole("dialog", { name: /Loading claim/i });
    expect(within(dialog).getByText("Loading claim detail…")).toBeInTheDocument();

    rejectDetails(new Error("Cached claim detail is unavailable."));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("Cached claim detail is unavailable.");
    expect(screen.getByRole("dialog")).toBe(dialog);
  });

  it("traps focus, blocks the background, closes with Escape, and restores focus", async () => {
    const claim = { claimId: "CLAIM-FOCUS-1", status: "FLAGGED", riskScore: 72, currentClaimVersion: 1 };
    const currentStatus = baseStatus({
      authenticated: true,
      cache: { freshness: "Fresh", claims: [claim], investigations: [], dashboard: null, suspiciousNetwork: null },
    });
    setDesktopInvokeForTests(async (command) => {
      if (command === "desktop_status" || command === "synchronize_desktop") return currentStatus;
      if (command === "desktop_claim_details") return { available: true, claim };
      throw new Error(`unexpected ${command}`);
    });

    const user = userEvent.setup();
    const previousOverflow = document.body.style.overflow;
    const appRoot = document.createElement("div");
    appRoot.id = "app";
    document.body.appendChild(appRoot);
    render(<DesktopApp />, { container: appRoot });
    await user.click((await screen.findAllByRole("button", { name: "Claims" }))[0]);
    const trigger = screen.getByRole("button", { name: "Open" });
    await user.click(trigger);

    const dialog = await screen.findByRole("dialog", { name: "Claim CLAIM-FOCUS-1" });
    const close = within(dialog).getByRole("button", { name: "Close claim detail" });
    expect(dialog).toHaveAttribute("aria-modal", "true");
    await waitFor(() => expect(close).toHaveFocus());
    expect(document.body.style.overflow).toBe("hidden");
    expect(appRoot).toHaveAttribute("inert");
    expect(appRoot).toHaveAttribute("aria-hidden", "true");

    await user.tab();
    expect(close).toHaveFocus();
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(trigger).toHaveFocus();
    expect(document.body.style.overflow).toBe(previousOverflow);
    expect(appRoot).not.toHaveAttribute("inert");
    expect(appRoot).not.toHaveAttribute("aria-hidden");
  });

  it("ignores a late detail response after switching overlays", async () => {
    let resolveClaim;
    const pendingClaim = new Promise((resolve) => { resolveClaim = resolve; });
    const investigation = {
      investigationId: "INV-RACE-1",
      claimId: "CLAIM-RACE-1",
      status: "OPEN",
      priority: "NORMAL",
      recordVersion: 1,
    };
    const claim = { claimId: "CLAIM-RACE-1", status: "FLAGGED", riskScore: 81, investigation };
    const currentStatus = baseStatus({
      authenticated: true,
      cache: { freshness: "Fresh", claims: [claim], investigations: [investigation], dashboard: null, suspiciousNetwork: null },
      session: { clientCapabilities: ["investigations.view"] },
    });
    setDesktopInvokeForTests(async (command) => {
      if (command === "desktop_status" || command === "synchronize_desktop") return currentStatus;
      if (command === "desktop_claim_details") return pendingClaim;
      if (command === "desktop_investigation_details") return { available: true, investigation };
      throw new Error(`unexpected ${command}`);
    });

    render(<DesktopApp />);
    await userEvent.click((await screen.findAllByRole("button", { name: "Claims" }))[0]);
    await userEvent.click(screen.getByRole("button", { name: "Open" }));
    expect(await screen.findByRole("dialog", { name: "Claim CLAIM-RACE-1" })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Open case" }));
    expect(await screen.findByRole("dialog", { name: "Investigation INV-RACE-1" })).toBeInTheDocument();

    resolveClaim({ available: true, claim: { ...claim, memberId: "late-response" } });
    await waitFor(() => expect(screen.getAllByRole("dialog")).toHaveLength(1));
    expect(screen.getByRole("dialog", { name: "Investigation INV-RACE-1" })).toBeInTheDocument();
    expect(screen.queryByRole("dialog", { name: "Claim CLAIM-RACE-1" })).not.toBeInTheDocument();
  });

  it("filters cached claims, opens authoritative detail, and follows a linked investigation", async () => {
    const calls = [];
    const linkedInvestigation = {
      investigationId: "INV-LINKED-1",
      claimId: "CLAIM-HIGH-1",
      status: "UNDER_REVIEW",
      priority: "HIGH",
      assignedInvestigator: "investigator-alpha",
      recordVersion: 2,
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
    expect(screen.getByText("Showing 1 of 1 matching claims · 2 cached")).toBeInTheDocument();
    expect(screen.queryByText("CLAIM-LOW-1")).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Open" }));
    expect(await screen.findByRole("dialog", { name: "Claim CLAIM-HIGH-1" })).toBeInTheDocument();
    expect(screen.getByText("Authoritative claim detail")).toBeInTheDocument();
    expect(screen.getByText("Billing frequency exceeds the peer baseline.")).toBeInTheDocument();
    expect(screen.getByText("Frequency Spike")).toBeInTheDocument();
    expect(screen.getByText("Member ID: member-token-1")).toBeInTheDocument();
    expect(calls).toContainEqual(["desktop_claim_details", { claimId: "CLAIM-HIGH-1" }]);

    await userEvent.click(screen.getByRole("button", { name: "Open case" }));
    expect(await screen.findByRole("dialog", { name: "Investigation INV-LINKED-1" })).toBeInTheDocument();
    expect(screen.getAllByRole("dialog")).toHaveLength(1);
    expect(screen.getByText("Investigation workspace")).toBeInTheDocument();
    expect(calls).toContainEqual(["desktop_investigation_details", { investigationId: "INV-LINKED-1" }]);

    await userEvent.click(screen.getByRole("button", { name: "Open related claim" }));
    expect(await screen.findByRole("dialog", { name: "Claim CLAIM-HIGH-1" })).toBeInTheDocument();
    expect(screen.getAllByRole("dialog")).toHaveLength(1);
    await userEvent.keyboard("{Escape}");
    expect(await screen.findByLabelText("Search claims")).toHaveValue("PROC-HIGH");
    expect(screen.getByRole("heading", { name: "Claims" })).toBeInTheDocument();
  });
});

describe("Sequrin desktop investigation workspace", () => {
  it("submits a priority-only update with the loaded version and no status", async () => {
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
          recordVersion: 7,
          createdAt: "2026-08-01T09:00:00.000Z",
          updatedAt: "2026-08-01T10:00:00.000Z",
        }],
        dashboard: null,
        suspiciousNetwork: null,
      },
      session: {
        clientCapabilities: [
          "investigations.view",
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
          priority: args.priority,
          recordVersion: args.expectedRecordVersion + 1,
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

    // Status is read-only — no select element for status modification
    expect(screen.getByLabelText("Investigation status")).toHaveTextContent(/open/i);

    await userEvent.selectOptions(screen.getByLabelText("Investigation priority"), "HIGH");
    await userEvent.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() => expect(calls.some(([command]) => command === "desktop_update_investigation")).toBe(true));
    const updateCall = calls.find(([command]) => command === "desktop_update_investigation");
    expect(updateCall).toEqual([
      "desktop_update_investigation",
      {
        investigationId: "INV-1",
        expectedRecordVersion: 7,
        status: null,
        priority: "HIGH",
      },
    ]);
    // Verify no status was included in the payload (bridge sends null explicitly)
    expect(updateCall[1].status).toBeNull();
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

  it("refreshes authoritative case detail after a stale priority update is rejected", async () => {
    const detailVersions = [];
    const compact = {
      investigationId: "INV-STALE",
      claimId: "CLAIM-STALE",
      status: "OPEN",
      priority: "NORMAL",
      recordVersion: 3,
      updatedAt: "2026-08-01T10:00:00.000Z",
    };
    const currentStatus = baseStatus({
      authenticated: true,
      cache: { freshness: "Fresh", claims: [], investigations: [compact], dashboard: null, suspiciousNetwork: null },
      session: { clientCapabilities: ["investigations.view", "investigations.change_priority"] },
    });
    setDesktopInvokeForTests(async (command) => {
      if (command === "desktop_status" || command === "synchronize_desktop") return currentStatus;
      if (command === "desktop_investigation_details") {
        const refreshed = detailVersions.length > 0;
        const investigation = refreshed
          ? { ...compact, priority: "HIGH", recordVersion: 4, updatedAt: "2026-08-01T10:05:00.000Z" }
          : compact;
        detailVersions.push(investigation.updatedAt);
        return { available: true, investigation };
      }
      if (command === "desktop_governed_case_details") {
        return { available: true, case: { caseId: "case-stale", currentState: "TRIAGE_PENDING", stateVersion: 1, migrationReviewStatus: "REVIEW_REQUIRED" }, allowedActions: [], correlationId: "stale-request" };
      }
      if (command === "desktop_update_investigation") {
        throw new Error("STALE_RECORD_VERSION:The investigation changed after it was loaded.");
      }
      throw new Error(`unexpected ${command}`);
    });

    render(<DesktopApp />);
    await userEvent.click((await screen.findAllByRole("button", { name: /Investigations 1/i }))[0]);
    await userEvent.click(screen.getByRole("button", { name: "Open case" }));
    const dialog = await screen.findByRole("dialog", { name: "Investigation INV-STALE" });
    expect(within(dialog).getByText("Investigation workspace")).toBeInTheDocument();
    await userEvent.selectOptions(screen.getByLabelText("Investigation priority"), "HIGH");
    await userEvent.click(screen.getByRole("button", { name: "Save changes" }));

    expect(await within(dialog).findByRole("alert")).toHaveTextContent(/changed on the server/i);
    await waitFor(() => expect(detailVersions).toEqual([
      "2026-08-01T10:00:00.000Z",
      "2026-08-01T10:05:00.000Z",
    ]));
    expect(screen.getByLabelText("Investigation priority")).toHaveValue("HIGH");
  });

  it("rejects a direct bridge call containing status and produces zero native invocations", async () => {
    const calls = [];
    setDesktopInvokeForTests(async (command, args) => {
      calls.push([command, args]);
      return { available: true };
    });

    const { desktopBridge } = await import("./desktopBridge");
    let thrown = null;
    try {
      desktopBridge.updateInvestigation("INV-1", 7, { status: "CONFIRMED_FRAUD", priority: "HIGH" });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toMatchObject({
      code: "LEGACY_INVESTIGATION_STATUS_WRITE_DISABLED",
      status: 409,
    });
    expect(calls).toEqual([]);
  });
});
