import { describe, expect, it } from "vitest";

import {
  createCaseActionIdempotencyKey,
  desktopBridge,
  nextBackoff,
  operationalWriteAllowed,
  pollingDelay,
  setDesktopInvokeForTests,
} from "./desktopBridge";

describe("desktop polling and offline mutation policy", () => {
  it("exposes governed case operations but no platform-governance or device-fleet administration commands", () => {
    expect(Object.keys(desktopBridge).sort()).toEqual([
      "activate",
      "addInvestigationNote",
      "claimDetails",
      "createInvestigation",
      "governedCaseDetails",
      "investigationDetails",
      "investigators",
      "lock",
      "login",
      "logout",
      "performGovernedCaseAction",
      "reset",
      "status",
      "sync",
      "updateInvestigation",
      "uploadInvestigationEvidence",
    ]);
  });

  it("maps investigation and governed case reads to dedicated Tauri commands", async () => {
    const calls = [];
    setDesktopInvokeForTests(async (command, args) => {
      calls.push([command, args]);
      return { available: true };
    });

    await desktopBridge.investigationDetails("investigation-1");
    await desktopBridge.governedCaseDetails("investigation-1");
    await desktopBridge.updateInvestigation("investigation-1", 7, { priority: "HIGH" });

    expect(calls).toEqual([
      ["desktop_investigation_details", { investigationId: "investigation-1" }],
      ["desktop_governed_case_details", { investigationId: "investigation-1" }],
      ["desktop_update_investigation", {
        investigationId: "investigation-1",
        expectedRecordVersion: 7,
        status: null,
        priority: "HIGH",
      }],
    ]);
  });

  it("passes only the governed action intent, idempotency token, and expected version", async () => {
    const calls = [];
    setDesktopInvokeForTests(async (command, args) => {
      calls.push([command, args]);
      return { state: "TRIAGE_ACTIVE", stateVersion: 3 };
    });
    const key = createCaseActionIdempotencyKey();
    await desktopBridge.performGovernedCaseAction("case-1", "begin-triage", key, {
      expectedStateVersion: 2,
      reasonCode: "REVIEWED_ACTION",
      reasonSummary: "Reviewed in the desktop application.",
    });

    expect(key).toMatch(/^[A-Za-z0-9.-]{16,128}$/);
    expect(calls).toEqual([["desktop_perform_case_action", {
      caseId: "case-1",
      action: "begin-triage",
      idempotencyKey: key,
      payload: {
        expectedStateVersion: 2,
        reasonCode: "REVIEWED_ACTION",
        reasonSummary: "Reviewed in the desktop application.",
      },
    }]]);
    expect(JSON.stringify(calls[0][1])).not.toMatch(/targetState|toState|tenant|actor|role|permission/i);
  });

  it("rejects client authority fields before native invocation", () => {
    const calls = [];
    setDesktopInvokeForTests(async (...args) => {
      calls.push(args);
      return { available: true };
    });
    let thrown = null;
    try {
      desktopBridge.performGovernedCaseAction("case-1", "begin-triage", "key-1", {
        expectedStateVersion: 2,
        reasonCode: "REVIEWED_ACTION",
        reasonSummary: "Reviewed.",
        targetState: "OUTCOME_APPROVED",
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toMatchObject({ code: "PROHIBITED_CASE_CONTEXT_FIELD" });
    expect(calls).toEqual([]);
  });

  it("preserves stable native server codes for stale handling", async () => {
    setDesktopInvokeForTests(async () => {
      throw "CASE_STATE_VERSION_CONFLICT:The case changed on the server.";
    });
    await expect(desktopBridge.performGovernedCaseAction("case-1", "begin-triage", "key-1", {
      expectedStateVersion: 2,
      reasonCode: "REVIEWED_ACTION",
      reasonSummary: "Reviewed.",
    })).rejects.toMatchObject({
      code: "CASE_STATE_VERSION_CONFLICT",
      message: "The case changed on the server.",
    });
  });

  it("fails closed before Tauri when a legacy status mutation is attempted", () => {
    const calls = [];
    setDesktopInvokeForTests(async (command, args) => {
      calls.push([command, args]);
      return { available: true };
    });

    let thrown = null;
    try {
      desktopBridge.updateInvestigation("investigation-1", 7, { status: "CONFIRMED_FRAUD" });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toMatchObject({
      code: "LEGACY_INVESTIGATION_STATUS_WRITE_DISABLED",
      status: 409,
    });
    expect(calls).toEqual([]);
  });

  it("maps connected investigation creation, assignment, notes, and evidence to versioned commands", async () => {
    const calls = [];
    setDesktopInvokeForTests(async (command, args) => {
      calls.push([command, args]);
      return { available: true };
    });

    await desktopBridge.investigators();
    await desktopBridge.createInvestigation("claim-1", 4, "investigator-alpha", "HIGH");
    await desktopBridge.addInvestigationNote("investigation-1", 7, "Provider called.", "INTERVIEW");
    await desktopBridge.uploadInvestigationEvidence("investigation-1", 8, {
      filename: "invoice.txt",
      description: "Provider invoice",
      evidenceType: "INVOICE",
      contentType: "text/plain",
      contentBase64: "aW52b2ljZQ==",
    });

    expect(calls).toEqual([
      ["desktop_investigators", undefined],
      ["desktop_create_investigation", {
        claimId: "claim-1", expectedClaimVersion: 4, assignedInvestigator: "investigator-alpha", priority: "HIGH",
      }],
      ["desktop_add_investigation_note", {
        investigationId: "investigation-1", expectedRecordVersion: 7, text: "Provider called.", noteType: "INTERVIEW",
      }],
      ["desktop_upload_investigation_evidence", {
        investigationId: "investigation-1",
        expectedRecordVersion: 8,
        filename: "invoice.txt",
        description: "Provider invoice",
        evidenceType: "INVOICE",
        contentType: "text/plain",
        contentBase64: "aW52b2ljZQ==",
      }],
    ]);
  });

  it("adds jitter so clients do not synchronize on a fixed clock boundary", () => {
    expect(pollingDelay(15_000, () => 0)).toBe(12_000);
    expect(pollingDelay(15_000, () => 0.5)).toBe(15_000);
    expect(pollingDelay(15_000, () => 1)).toBe(18_000);
    expect(nextBackoff(3, { active: true, random: () => 0.5 })).toBe(120_000);
  });

  it("allows operational writes only while authenticated, unlocked and online", () => {
    expect(operationalWriteAllowed({ authenticated: true, locked: false, cache: { freshness: "Fresh" } })).toBe(true);
    expect(operationalWriteAllowed({ authenticated: true, locked: false, cache: { freshness: "Synchronizing" } })).toBe(true);
    expect(operationalWriteAllowed({ authenticated: true, locked: false, cache: { freshness: "Stale" } })).toBe(false);
    expect(operationalWriteAllowed({ authenticated: true, locked: false, cache: { freshness: "Offline" } })).toBe(false);
    expect(operationalWriteAllowed({ authenticated: false, locked: false, cache: { freshness: "Fresh" } })).toBe(false);
    expect(operationalWriteAllowed({ authenticated: true, locked: true, cache: { freshness: "Fresh" } })).toBe(false);
  });
});
