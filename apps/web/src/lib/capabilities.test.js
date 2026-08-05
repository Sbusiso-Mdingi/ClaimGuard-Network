import { describe, expect, it } from "vitest";

import { hasCapability, hasEveryCapability, hasAnyCapability } from "./capabilities";

const identity = {
  capabilities: [
    "investigations.view",
    "investigations.add_note",
    "investigations.update_status",
    "investigations.confirm_fraud",
    "investigations.reverse_fraud",
  ],
};

describe("legacy investigation mutation capability isolation", () => {
  it("preserves supported read and evidence-adjacent capabilities", () => {
    expect(hasCapability(identity, "investigations.view")).toBe(true);
    expect(hasCapability(identity, "investigations.add_note")).toBe(true);
  });

  it("fails closed for generic status, confirmation and reversal controls", () => {
    expect(hasCapability(identity, "investigations.update_status")).toBe(false);
    expect(hasCapability(identity, "investigations.confirm_fraud")).toBe(false);
    expect(hasCapability(identity, "investigations.reverse_fraud")).toBe(false);
    expect(hasAnyCapability(identity, ["investigations.confirm_fraud", "investigations.reverse_fraud"])).toBe(false);
    expect(hasEveryCapability(identity, ["investigations.view", "investigations.confirm_fraud"])).toBe(false);
  });
});
