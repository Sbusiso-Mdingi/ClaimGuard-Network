import React from "react";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { GovernedDesktopCasePanel } from "./GovernedDesktopCasePanel";
import { setDesktopInvokeForTests } from "./desktopBridge";

function detail(version = 2, actions = ["begin-triage"], caseId = "case-1") {
  return {
    available: true,
    case: {
      caseId,
      currentState: version === 2 ? "TRIAGE_PENDING" : "TRIAGE_ACTIVE",
      stateVersion: version,
      migrationReviewStatus: "REVIEW_REQUIRED",
    },
    allowedActions: actions,
    correlationId: `request-${version}`,
  };
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("governed desktop case panel", () => {
  it("renders historical status separately and only server-returned non-deferred actions", async () => {
    setDesktopInvokeForTests(async (command) => {
      if (command === "desktop_governed_case_details") {
        return detail(2, ["begin-triage", "publish-registry", "activate-network-notice"]);
      }
      throw new Error(`unexpected ${command}`);
    });
    render(<GovernedDesktopCasePanel investigationId="investigation-1" historicalStatus="UNDER_REVIEW" writesAllowed />);

    expect(await screen.findByText("TRIAGE_PENDING")).toBeInTheDocument();
    expect(screen.getByText("Under Review")).toBeInTheDocument();
    expect(screen.getByText(/Read-only compatibility data/i)).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Begin Triage" })).toBeInTheDocument();
    expect(screen.queryByText(/Publish Registry/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Activate Network Notice/i)).not.toBeInTheDocument();
    expect(screen.getByText(/Outcome approval is not registry publication/i)).toBeInTheDocument();
    expect(screen.queryByLabelText(/target state/i)).not.toBeInTheDocument();
  });

  it("submits the loaded version with a fresh key and refreshes after success", async () => {
    const calls = [];
    let reads = 0;
    setDesktopInvokeForTests(async (command, args) => {
      calls.push([command, args]);
      if (command === "desktop_governed_case_details") {
        reads += 1;
        return detail(reads === 1 ? 2 : 3);
      }
      if (command === "desktop_perform_case_action") return {
        caseId: "case-1",
        state: "TRIAGE_ACTIVE",
        stateVersion: 3,
        transitionEventId: "event-1",
        operationId: "operation-1",
        correlationId: "request-action",
        replayed: false,
      };
      throw new Error(`unexpected ${command}`);
    });
    const user = userEvent.setup();
    render(<GovernedDesktopCasePanel investigationId="investigation-1" historicalStatus="OPEN" writesAllowed />);
    await user.type(await screen.findByLabelText("Governed reason summary"), "Reviewed by the assigned investigator.");
    await user.click(screen.getByRole("button", { name: "Apply governed action" }));

    await waitFor(() => expect(reads).toBe(2));
    const actionCalls = calls.filter(([command]) => command === "desktop_perform_case_action");
    expect(actionCalls).toHaveLength(1);
    expect(actionCalls[0][1].idempotencyKey).toMatch(/^[A-Za-z0-9.-]{16,128}$/);
    expect(actionCalls[0][1].payload).toMatchObject({ expectedStateVersion: 2 });
    expect(JSON.stringify(actionCalls[0][1])).not.toMatch(/targetState|toState|tenant|actor|role|permission/i);
    expect(await screen.findByText("TRIAGE_ACTIVE")).toBeInTheDocument();
    expect(screen.getByText(/governed action was recorded/i)).toBeInTheDocument();
  });

  it("refreshes after a stale conflict without replaying the decision", async () => {
    const calls = [];
    let reads = 0;
    setDesktopInvokeForTests(async (command, args) => {
      calls.push([command, args]);
      if (command === "desktop_governed_case_details") {
        reads += 1;
        return detail(reads === 1 ? 2 : 3);
      }
      if (command === "desktop_perform_case_action") {
        const error = new Error("The case changed on the server.");
        error.code = "CASE_STATE_VERSION_CONFLICT";
        throw error;
      }
      throw new Error(`unexpected ${command}`);
    });
    const user = userEvent.setup();
    render(<GovernedDesktopCasePanel investigationId="investigation-1" historicalStatus="OPEN" writesAllowed />);
    await user.type(await screen.findByLabelText("Governed reason summary"), "Review stale decision.");
    await user.click(screen.getByRole("button", { name: "Apply governed action" }));

    await waitFor(() => expect(reads).toBe(2));
    expect(calls.filter(([command]) => command === "desktop_perform_case_action")).toHaveLength(1);
    expect(await screen.findByText(/changed on the server.*refreshed/i)).toBeInTheDocument();
    expect(screen.getByText("TRIAGE_ACTIVE")).toBeInTheDocument();
  });

  it("suppresses duplicate clicks while a native action is pending", async () => {
    let resolveAction;
    const pending = new Promise((resolve) => { resolveAction = resolve; });
    const calls = [];
    setDesktopInvokeForTests(async (command, args) => {
      calls.push([command, args]);
      if (command === "desktop_governed_case_details") return detail();
      if (command === "desktop_perform_case_action") return pending;
      throw new Error(`unexpected ${command}`);
    });
    const user = userEvent.setup();
    render(<GovernedDesktopCasePanel investigationId="investigation-1" historicalStatus="OPEN" writesAllowed />);
    await user.type(await screen.findByLabelText("Governed reason summary"), "Apply once.");
    const button = screen.getByRole("button", { name: "Apply governed action" });
    await user.click(button);
    await user.click(button);
    expect(calls.filter(([command]) => command === "desktop_perform_case_action")).toHaveLength(1);
    expect(button).toBeDisabled();
    resolveAction({ replayed: false });
  });

  it("ignores a delayed response from the previously selected investigation", async () => {
    let resolveFirst;
    const first = new Promise((resolve) => { resolveFirst = resolve; });
    setDesktopInvokeForTests(async (command, args) => {
      if (command !== "desktop_governed_case_details") throw new Error(`unexpected ${command}`);
      if (args.investigationId === "investigation-1") return first;
      if (args.investigationId === "investigation-2") return detail(3, [], "case-2");
      throw new Error(`unexpected investigation ${args.investigationId}`);
    });
    const rendered = render(<GovernedDesktopCasePanel investigationId="investigation-1" historicalStatus="OPEN" writesAllowed />);
    rendered.rerender(<GovernedDesktopCasePanel investigationId="investigation-2" historicalStatus="UNDER_REVIEW" writesAllowed />);

    expect(await screen.findByText("TRIAGE_ACTIVE")).toBeInTheDocument();
    expect(screen.getByText("Under Review")).toBeInTheDocument();
    resolveFirst(detail(2, ["begin-triage"], "case-1"));
    await waitFor(() => expect(screen.queryByText("TRIAGE_PENDING")).not.toBeInTheDocument());
    expect(screen.getByText("TRIAGE_ACTIVE")).toBeInTheDocument();
  });

  it("fails safely when the native governed command is unavailable", async () => {
    setDesktopInvokeForTests(async () => {
      throw new Error("ClaimGuard desktop commands are unavailable outside the trusted application shell.");
    });
    render(<GovernedDesktopCasePanel investigationId="investigation-1" historicalStatus="OPEN" writesAllowed />);
    expect(await screen.findByRole("alert")).toHaveTextContent(/commands are unavailable/i);
    expect(screen.queryByRole("button", { name: "Apply governed action" })).not.toBeInTheDocument();
  });
});
