import { desc, eq } from "drizzle-orm";

import { createLedgerEntry, genesisPreviousHash, ledgerEntriesTable } from "./index.js";

const CONFIRMED_FRAUD_ENTRY_TYPE = "INVESTIGATOR_CONFIRMED_FRAUD";

export function createLedgerRepository(db) {
  return {
    async getLatestEntry() {
      const [latestEntry] = await db
        .select()
        .from(ledgerEntriesTable)
        .orderBy(desc(ledgerEntriesTable.sequenceNumber))
        .limit(1);

      return latestEntry ?? null;
    },

    async createEntry({ entryType, payload }) {
      const latestEntry = await this.getLatestEntry();
      const nextSequenceNumber = latestEntry ? latestEntry.sequenceNumber + 1 : 1;
      const previousHash = latestEntry?.entryHash ?? genesisPreviousHash;
      const entry = createLedgerEntry({
        sequenceNumber: nextSequenceNumber,
        previousHash,
        entryType,
        payload,
      });

      await db.insert(ledgerEntriesTable).values(entry);

      return entry;
    },

    async getLatestConfirmedFraudEntry() {
      const [latestEntry] = await db
        .select()
        .from(ledgerEntriesTable)
        .where(eq(ledgerEntriesTable.entryType, CONFIRMED_FRAUD_ENTRY_TYPE))
        .orderBy(desc(ledgerEntriesTable.sequenceNumber))
        .limit(1);

      return latestEntry ?? null;
    },

    async createConfirmedFraudEntry({
      claimId,
      investigatorId,
      schemeId = null,
      reportVersion = null,
      reason,
      notes = null,
      decisionTimestamp = new Date().toISOString(),
    }) {
      if (!claimId || !investigatorId || !reason) {
        throw new Error("claimId, investigatorId, and reason are required for confirmed fraud entries.");
      }

      return this.createEntry({
        entryType: CONFIRMED_FRAUD_ENTRY_TYPE,
        payload: {
          claimId,
          investigatorId,
          schemeId,
          reportVersion,
          reason,
          notes,
          decisionTimestamp,
        },
      });
    },

    async findEntryByHash(entryHash) {
      const [entry] = await db
        .select()
        .from(ledgerEntriesTable)
        .where(eq(ledgerEntriesTable.entryHash, entryHash))
        .limit(1);

      return entry ?? null;
    },
  };
}