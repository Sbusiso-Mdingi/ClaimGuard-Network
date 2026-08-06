import React from "react";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";

import { DesktopApp } from "./DesktopApp";
import { setDesktopInvokeForTests } from "./desktopBridge";

function investigation(id = "INV-1", status = "UNDER_REVIEW") {
  return {
    investigationId: id,
    claimId: `CLAIM-${id}`,
    status,
    priority: "NORMAL",
    assignedInvestigator: "investigator-alpha",
    assignedBy: "analyst-alpha",
    recordVersion: 7,
    createdAt: "2026-08-05T09:00:00.000Z",
    updatedAt: "2026-08-05T10:00:00.000Z",
  };
}

function desktopStatus(investigations = [investigation()]) {
  return {
    activationRequired: false,
    authenticated: true,
    locked: false,
    lockReason: null,
    enrollment: { organisationId: "org-alpha", organisationDisplayName: "Alpha Medical" },
    cache: {
      freshness: "Fresh",
      lastSuccessfulSyncAt: "2026-08-05T10:00:00.000Z",
      claims: [],
      investigations,
      dashboard: null,
      suspiciousNetwork: null,
    },
    session: {
      user: { userId: "actor-1" },
      clientCapabilities: [
        "investigations.view",
        "investigations.change_priority",
        "investigations.add_note",
        "investigations.upload_evidence",
      ],
    },
  };
}

function governed(version = 2, actions = ["begin-triage"], caseId = "case-1") {
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

function detail(record) {
  return {
    available: true,
    investigation: {
      ...record,
      notes: [],
      evidence: [],
      activity: [],
    },
  };
}

async function openInvestigation(record = investigation()) {
  await userEvent.click((await screen.findAllByRole("button", { name: new RegExp(`Investigations ${record.investigationId === "INV-1" ? "1" : "2"}`, "i") }))[0]);
  const row = screen.getByText(record.investigationId).closest("tr");
  await userEvent.click(within(row).getByRole("button", { name: "Open case" }));
  return screen.findByRole("dialog", { name: `Investigation ${record.investigationId}` });
}

afterEach(() => cleanup());

describe("integrated governed desktop workflow", () => {
  it("loads server actions in the real workspace and refreshes after one successful action", async () => {
    const record = investigation();
    const status = desktopStatus([record]);
    const calls = [];
    let governedReads = 0;
    setDesktopInvokeForTests(async (command, args) => {
      calls.push([command, args]);
      if (command === "desktop_status" || command === "synchronize_desktop") return status;
      if (command === "desktop_investigation_details") return detail(record);
      if (command === "desktop_governed_case_details") {
        expect(args).toEqual({ investigationId: "INV-1" });
        governedReads += 1;
        return governed(governedReads === 1 ? 2 : 3, ["begin-triage", "publish-registry", "activate-network-notice"]);
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

    render(<DesktopApp />);
    const dialog = await openInvestigation(record);
    expect(await within(dialog).findByText("TRIAGE_PENDING")).toBeInTheDocument();
    expect(within(dialog).getAllByText("Under Review").length).toBeGreaterThan(0);
    expect(within(dialog).getByText(/Read-only compatibility data/i)).toBeInTheDocument();
    expect(within(dialog).getByRole("option", { name: "Begin Triage" })).toBeInTheDocument();
    expect(within(dialog).queryByText(/Publish Registry/i)).not.toBeInTheDocument();
    expect(within(dialog).queryByText(/Activate Network Notice/i)).not.toBeInTheDocument();
    expect(within(dialog).queryByLabelText(/target state/i)).not.toBeInTheDocument();
    expect(within(dialog).getByLabelText("Investigation status").tagName).toBe("SPAN");
    expect(within(dialog).getByLabelText("Investigation priority")).toBeInTheDocument();
    expect(within(dialog).getByLabelText("Investigation note")).toBeInTheDocument();
    expect(within(dialog).getByLabelText("Evidence file")).toBeInTheDocument();
    expect(within(dialog).queryByText(/confirm fraud|reverse fraud/i)).not.toBeInTheDocument();

    await userEvent.type(within(dialog).getByLabelText("Governed reason summary"), "Reviewed in the integrated workspace.");
    await userEvent.click(within(dialog).getByRole("button", { name: "Apply governed action" }));

    await waitFor(() => expect(governedReads).toBe(2));
    expect(await within(dialog).findByText("TRIAGE_ACTIVE")).toBeInTheDocument();
    const actionCalls = calls.filter(([command]) => command === "desktop_perform_case_action");
    expect(actionCalls).toHaveLength(1);
    expect(actionCalls[0][1].payload.expectedStateVersion).toBe(2);
    expect(actionCalls[0][1].idempotencyKey).toMatch(/^[A-Za-z0-9.-]{16,128}$/);
    expect(JSON.stringify(actionCalls[0][1])).not.toMatch(/targetState|toState|tenant|actor|role|permission/i);
  });

  it("refreshes one stale action without replaying it and suppresses duplicate pending clicks", async () => {
    const record = investigation();
    const status = desktopStatus([record]);
    const calls = [];
    let governedReads = 0;
    let resolvePending;
    const pending = new Promise((resolve, reject) => { resolvePending = { resolve, reject }; });
    setDesktopInvokeForTests(async (command, args) => {
      calls.push([command, args]);
      if (command === "desktop_status" || command === "synchronize_desktop") return status;
      if (command === "desktop_investigation_details") return detail(record);
      if (command === "desktop_governed_case_details") {
        governedReads += 1;
        return governed(governedReads === 1 ? 2 : 3);
      }
      if (command === "desktop_perform_case_action") return pending;
      throw new Error(`unexpected ${command}`);
    });

    render(<DesktopApp />);
    const dialog = await openInvestigation(record);
    await userEvent.type(await within(dialog).findByLabelText("Governed reason summary"), "Review the current version once.");
    const button = within(dialog).getByRole("button", { name: "Apply governed action" });
    await userEvent.click(button);
    await userEvent.click(button);
    expect(calls.filter(([command]) => command === "desktop_perform_case_action")).toHaveLength(1);
    expect(button).toBeDisabled();

    const stale = new Error("Wording intentionally differs.");
    stale.code = "CASE_STATE_VERSION_CONFLICT";
    resolvePending.reject(stale);
    await waitFor(() => expect(governedReads).toBe(2));
    expect(calls.filter(([command]) => command === "desktop_perform_case_action")).toHaveLength(1);
    expect(await within(dialog).findByText(/changed on the server.*refreshed/i)).toBeInTheDocument();
    expect(within(dialog).getByText("TRIAGE_ACTIVE")).toBeInTheDocument();
  });

  it("loads a newly selected case and ignores the old delayed governed response", async () => {
    const firstRecord = investigation("INV-1", "OPEN");
    const secondRecord = investigation("INV-2", "UNDER_REVIEW");
    const status = desktopStatus([firstRecord, secondRecord]);
    let resolveFirst;
    const firstGoverned = new Promise((resolve) => { resolveFirst = resolve; });
    const calls = [];
    setDesktopInvokeForTests(async (command, args) => {
      calls.push([command, args]);
      if (command === "desktop_status" || command === "synchronize_desktop") return status;
      if (command === "desktop_investigation_details") {
        return detail(args.investigationId === "INV-1" ? firstRecord : secondRecord);
      }
      if (command === "desktop_governed_case_details") {
        if (args.investigationId === "INV-1") return firstGoverned;
        if (args.investigationId === "INV-2") return governed(3, [], "case-2");
      }
      throw new Error(`unexpected ${command}`);
    });

    render(<DesktopApp />);
    await userEvent.click((await screen.findAllByRole("button", { name: /Investigations 2/i }))[0]);
    let row = screen.getByText("INV-1").closest("tr");
    await userEvent.click(within(row).getByRole("button", { name: "Open case" }));
    let dialog = await screen.findByRole("dialog", { name: "Investigation INV-1" });
    await userEvent.click(within(dialog).getByRole("button", { name: "Close investigation workspace" }));

    row = screen.getByText("INV-2").closest("tr");
    await userEvent.click(within(row).getByRole("button", { name: "Open case" }));
    dialog = await screen.findByRole("dialog", { name: "Investigation INV-2" });
    expect(await within(dialog).findByText("TRIAGE_ACTIVE")).toBeInTheDocument();
    resolveFirst(governed(2, ["begin-triage"], "case-1"));
    await waitFor(() => expect(within(dialog).queryByText("TRIAGE_PENDING")).not.toBeInTheDocument());
    expect(within(dialog).getByText("TRIAGE_ACTIVE")).toBeInTheDocument();
    expect(calls.filter(([command]) => command === "desktop_governed_case_details").map(([, args]) => args.investigationId)).toEqual(["INV-1", "INV-2"]);
  });

  it("shows a bounded unavailable state without restoring legacy lifecycle controls", async () => {
    const record = investigation();
    const status = desktopStatus([record]);
    setDesktopInvokeForTests(async (command) => {
      if (command === "desktop_status" || command === "synchronize_desktop") return status;
      if (command === "desktop_investigation_details") return detail(record);
      if (command === "desktop_governed_case_details") throw new Error("Native governed case workflow is unavailable.");
      throw new Error(`unexpected ${command}`);
    });

    render(<DesktopApp />);
    const dialog = await openInvestigation(record);
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("Native governed case workflow is unavailable.");
    expect(within(dialog).queryByRole("button", { name: "Apply governed action" })).not.toBeInTheDocument();
    expect(within(dialog).getByLabelText("Investigation status").tagName).toBe("SPAN");
    expect(within(dialog).queryByText(/confirm fraud|reverse fraud/i)).not.toBeInTheDocument();
  });
});
