import crypto from "node:crypto";

export function createFraudWorkflowRepositoryStub({
  confirm,
  reverse,
} = {}) {
  const confirmations = [];
  const reversals = [];

  function entry(type, input, sequenceNumber) {
    return {
      id: sequenceNumber,
      entryId: sequenceNumber,
      sequenceNumber,
      entryType: type,
      previousHash: "0".repeat(64),
      entryHash: crypto.createHash("sha256").update(`${type}:${sequenceNumber}`).digest("hex"),
      tenantId: input.tenantId,
      payload: {
        investigationId: input.investigationId,
        claimId: input.requestedClaimId,
        reason: input.reason,
        actor: { id: input.actorId, role: input.actorRole, tenantId: input.tenantId },
      },
    };
  }

  function registry(input, ledgerEntry, status, reversesRegistryEntryId = null) {
    return {
      registryEntryId: `registry-${status.toLowerCase()}-${ledgerEntry.sequenceNumber}`,
      ledgerHash: ledgerEntry.entryHash,
      investigationId: input.investigationId,
      tenantId: input.tenantId,
      medicalScheme: "Authoritative Scheme",
      fraudSubjectType: "PROVIDER",
      subjectToken: crypto.createHash("sha256").update("provider:authoritative").digest("hex"),
      offenceCategory: "CONFIRMED_CLAIM_FRAUD",
      findingDate: "2026-07-16",
      investigatorReference: input.actorId,
      publicationTimestamp: "2026-07-16T00:00:00.000Z",
      status,
      reversesRegistryEntryId,
    };
  }

  return {
    confirmations,
    reversals,
    async confirmFraud(input) {
      confirmations.push(input);
      if (confirm) {
        return confirm(input, { confirmations, reversals, entry, registry });
      }
      const ledgerEntry = entry("INVESTIGATOR_CONFIRMED_FRAUD", input, confirmations.length + reversals.length);
      return { entry: ledgerEntry, registryEntry: registry(input, ledgerEntry, "ACTIVE"), replayed: false };
    },
    async reverseFraud(input) {
      reversals.push(input);
      if (reverse) {
        return reverse(input, { confirmations, reversals, entry, registry });
      }
      const ledgerEntry = entry("INVESTIGATOR_REVERSED_FRAUD", input, confirmations.length + reversals.length);
      return {
        entry: ledgerEntry,
        registryEntry: registry(input, ledgerEntry, "REVERSED", "registry-active"),
        replayed: false,
      };
    },
  };
}
