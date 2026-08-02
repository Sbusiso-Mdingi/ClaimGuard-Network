import { describe, expect, it } from "vitest";

import { desktopBridge, nextBackoff, operationalWriteAllowed, pollingDelay, setDesktopInvokeForTests } from "./desktopBridge";

describe("desktop polling and offline mutation policy", () => {
  it("exposes no platform-governance or device-fleet administration commands", () => {
    expect(Object.keys(desktopBridge).sort()).toEqual([
      "activate",
      "claimDetails",
      "investigationDetails",
      "lock",
      "login",
      "logout",
      "reset",
      "status",
      "sync",
      "updateInvestigation",
    ]);
  });

  it("maps investigation reads and versioned updates to the narrow Tauri commands", async () => {
    const calls = [];
    setDesktopInvokeForTests(async (command, args) => {
      calls.push([command, args]);
      return { available: true };
    });

    await desktopBridge.investigationDetails("investigation-1");
    await desktopBridge.updateInvestigation(
      "investigation-1",
      "2026-08-01T10:00:00.000Z",
      { status: "UNDER_REVIEW", priority: "HIGH" },
    );

    expect(calls).toEqual([
      ["desktop_investigation_details", { investigationId: "investigation-1" }],
      ["desktop_update_investigation", {
        investigationId: "investigation-1",
        expectedUpdatedAt: "2026-08-01T10:00:00.000Z",
        status: "UNDER_REVIEW",
        priority: "HIGH",
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
