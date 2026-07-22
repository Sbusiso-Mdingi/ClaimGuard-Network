import { eq, and } from "drizzle-orm";
import { detectionStrategiesTable } from "./index.js";
import { getActiveTenantId } from "./tenant-context-store.js";

export function createDetectionStrategyRepository(db, pool, options = {}) {
  const allowLegacyTenantContext = options.allowLegacyTenantContext !== false;

  return {
    async getActiveStrategy(tenantContext) {
      const tenantId = getActiveTenantId(tenantContext, { allowLegacy: allowLegacyTenantContext });
      const [strategy] = await db
        .select()
        .from(detectionStrategiesTable)
        .where(
          and(
            eq(detectionStrategiesTable.tenantId, tenantId),
            eq(detectionStrategiesTable.isActive, 1)
          )
        )
        .limit(1);

        return strategy || {
          tenantId,
          strategyType: "deterministic_rules",
          endpointUrl: null,
          customModelImageSecret: null,
          isActive: 1,
        };
    },

    async setStrategy(tenantContext, { strategyType, endpointUrl, customModelImageSecret }) {
      const tenantId = getActiveTenantId(tenantContext, { allowLegacy: allowLegacyTenantContext });
      const now = new Date().toISOString();

      // Deactivate old strategies
      await db
        .update(detectionStrategiesTable)
        .set({ isActive: 0, updatedAt: now })
        .where(eq(detectionStrategiesTable.tenantId, tenantId));

      // Insert new strategy
      await db.insert(detectionStrategiesTable).values({
        tenantId,
        strategyType,
        endpointUrl: endpointUrl || null,
        customModelImageSecret: customModelImageSecret || null,
        isActive: 1,
        createdAt: now,
        updatedAt: now,
      });

      return { tenantId, strategyType, endpointUrl };
    },
  };
}
