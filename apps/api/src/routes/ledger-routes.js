import crypto from "node:crypto";

import { CLAIMGUARD_PERMISSIONS } from "../authorization-policy.js";
import {
  createRequirePermissionMiddleware,
  createRequireTenantAccessMiddleware,
} from "../middleware/authorization-middleware.js";

const genesisPreviousHash = "0".repeat(64);

function createLedgerEntry({ sequenceNumber, previousHash = genesisPreviousHash, entryType, payload }) {
  const digest = crypto.createHash("sha256");
  digest.update(previousHash);
  digest.update("|");
  digest.update(entryType);
  digest.update("|");
  digest.update(JSON.stringify(payload));

  return {
    sequenceNumber,
    entryType,
    previousHash,
    entryHash: digest.digest("hex"),
    payload,
  };
}

export function registerLedgerRoutes(app, { ledgerRepository, tenantRepository = null }) {
  const requireLedgerPermission = createRequirePermissionMiddleware({
    permission: CLAIMGUARD_PERMISSIONS.FRAUD_REGISTRY_REVIEW_HISTORY,
  });
  const requireTenantAccess = createRequireTenantAccessMiddleware({ tenantRepository });

  app.get("/ledger/preview", requireLedgerPermission, requireTenantAccess, (c) => {
    const entry = createLedgerEntry({
      sequenceNumber: 1,
      previousHash: genesisPreviousHash,
      entryType: "API_BOOT",
      payload: {
        service: "api",
        phase: "3",
      },
    });

    return c.json({
      chainReady: true,
      entry,
    });
  });

  app.get("/ledger/latest", requireLedgerPermission, requireTenantAccess, async (c) => {
    if (!ledgerRepository) {
      return c.json(
        {
          available: false,
          message: "MYSQL_URL is not configured, so the runtime ledger is not available yet.",
        },
        503,
      );
    }

    const latestEntry = await ledgerRepository.getLatestEntry();

    if (!latestEntry) {
      return c.json({ available: true, entry: null }, 200);
    }

    return c.json({ available: true, entry: latestEntry }, 200);
  });
}
