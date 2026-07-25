import { describe, expect, it } from "vitest";

import { describeLedger } from "../hooks/useLedgerStatus";

describe("describeLedger", () => {
  it("distinguishes a reachable empty ledger from an unavailable ledger", () => {
    expect(describeLedger({ available: true, entry: null })).toBe("Connected · Empty");
    expect(describeLedger({ available: false, entry: null })).toBe("Unavailable");
  });

  it("reports connected when a ledger entry exists", () => {
    expect(describeLedger({ available: true, entry: { sequenceNumber: 1 } })).toBe("Connected");
  });
});
