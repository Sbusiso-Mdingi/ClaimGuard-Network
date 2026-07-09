import { desc, eq } from "drizzle-orm";

import { createLedgerEntry, genesisPreviousHash, ledgerEntriesTable } from "./index.js";

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