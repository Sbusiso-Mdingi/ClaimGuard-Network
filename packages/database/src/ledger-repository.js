import { and, desc, eq } from "drizzle-orm";

import { createLedgerEntry, genesisPreviousHash, ledgerEntriesTable } from "./index.js";
import { getActiveTenantId } from "./tenant-context-store.js";

const CONFIRMED_FRAUD_ENTRY_TYPE = "INVESTIGATOR_CONFIRMED_FRAUD";
const REVERSED_FRAUD_ENTRY_TYPE = "INVESTIGATOR_REVERSED_FRAUD";

export function createLedgerRepository(db) {
  async function getLatestGlobalEntry() {
    const [latestEntry] = await db
      .select()
      .from(ledgerEntriesTable)
      .orderBy(desc(ledgerEntriesTable.sequenceNumber))
      .limit(1);

    return latestEntry ?? null;
  }

  return {
    async getLatestEntry() {
      const tenantId = getActiveTenantId();
      const [latestEntry] = await db
        .select()
        .from(ledgerEntriesTable)
        .where(eq(ledgerEntriesTable.tenantId, tenantId))
        .orderBy(desc(ledgerEntriesTable.sequenceNumber))
        .limit(1);

      return latestEntry ?? null;
    },

    async createEntry({ entryType, payload }) {
      const tenantId = getActiveTenantId();
      const latestTenantEntry = await this.getLatestEntry();
      const latestGlobalEntry = await getLatestGlobalEntry();
      const nextSequenceNumber = latestGlobalEntry ? latestGlobalEntry.sequenceNumber + 1 : 1;
      const previousHash = latestTenantEntry?.entryHash ?? genesisPreviousHash;
      const entry = createLedgerEntry({
        sequenceNumber: nextSequenceNumber,
        previousHash,
        entryType,
        payload,
        tenantId,
      });

      await db.insert(ledgerEntriesTable).values(entry);

      return entry;
    },

    async getLatestConfirmedFraudEntry() {
      const tenantId = getActiveTenantId();
      const [latestEntry] = await db
        .select()
        .from(ledgerEntriesTable)
        .where(
          and(
            eq(ledgerEntriesTable.entryType, CONFIRMED_FRAUD_ENTRY_TYPE),
            eq(ledgerEntriesTable.tenantId, tenantId),
          ),
        )
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

    async createReversedFraudEntry({
      claimId,
      investigatorId,
      schemeId = null,
      reason,
      notes = null,
      originalLedgerHash = null,
      reversalTimestamp = new Date().toISOString(),
    }) {
      if (!claimId || !investigatorId || !reason) {
        throw new Error("claimId, investigatorId, and reason are required for reversed fraud entries.");
      }

      return this.createEntry({
        entryType: REVERSED_FRAUD_ENTRY_TYPE,
        payload: {
          claimId,
          investigatorId,
          schemeId,
          reason,
          notes,
          originalLedgerHash,
          reversalTimestamp,
        },
      });
    },

    async findEntryByHash(entryHash) {
      const tenantId = getActiveTenantId();
      const [entry] = await db
        .select()
        .from(ledgerEntriesTable)
        .where(and(eq(ledgerEntriesTable.entryHash, entryHash), eq(ledgerEntriesTable.tenantId, tenantId)))
        .limit(1);

      return entry ?? null;
    },
  };
}