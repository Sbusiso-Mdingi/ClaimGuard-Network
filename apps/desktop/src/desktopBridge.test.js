import { describe, expect, it } from "vitest";

import { nextBackoff, operationalWriteAllowed, pollingDelay } from "./desktopBridge";

describe("desktop polling and offline mutation policy", () => {
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
