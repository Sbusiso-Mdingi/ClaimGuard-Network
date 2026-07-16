import crypto from "node:crypto";

export const genesisPreviousHash = "0".repeat(64);

function sortValue(value) {
  if (Array.isArray(value)) {
    return value.map(sortValue);
  }

  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, sortValue(value[key])]),
    );
  }

  return value;
}

export function stableStringify(value) {
  return JSON.stringify(sortValue(value));
}

export function computeLedgerEntryHash({ previousHash, entryType, payload }) {
  const digest = crypto.createHash("sha256");
  digest.update(previousHash);
  digest.update("|");
  digest.update(entryType);
  digest.update("|");
  digest.update(stableStringify(payload));
  return digest.digest("hex");
}

export function createLedgerEntry({
  sequenceNumber,
  previousHash = genesisPreviousHash,
  entryType,
  payload,
  tenantId,
}) {
  const entryHash = computeLedgerEntryHash({ previousHash, entryType, payload });

  return {
    sequenceNumber,
    entryType,
    previousHash,
    entryHash,
    payload,
    tenantId,
  };
}
