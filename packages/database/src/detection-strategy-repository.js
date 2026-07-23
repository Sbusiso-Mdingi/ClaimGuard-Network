import { getActiveTenantId } from "./tenant-context-store.js";

const DEPLOYMENT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const STRATEGY_TYPES = new Set(["deterministic_rules", "approved_model"]);

function approvedDeploymentIds() {
  return new Set(
    String(process.env.APPROVED_MODEL_DEPLOYMENT_IDS || "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean),
  );
}

function strategyValidationError(message) {
  const error = new Error(message);
  error.code = "DETECTION_STRATEGY_INVALID";
  error.status = 400;
  return error;
}

export function createDetectionStrategyRepository(_db, pool, options = {}) {
  const allowLegacyTenantContext = options.allowLegacyTenantContext !== false;
  const pinnedTenantId = options.dataPlaneContext?.operationalTenantId || null;
  const tenantIdFor = (tenantContext) => {
    const requestedTenantId = tenantContext?.tenant_id || null;
    if (pinnedTenantId) {
      if (requestedTenantId && requestedTenantId !== pinnedTenantId) {
        const error = new Error("Detection strategy tenant does not match the verified data-plane context.");
        error.code = "DATA_PLANE_TENANT_MISMATCH";
        error.status = 403;
        throw error;
      }
      return pinnedTenantId;
    }
    if (!allowLegacyTenantContext) {
      const error = new Error("An explicit verified DataPlaneContext is required for detection strategy access.");
      error.code = "DATA_PLANE_CONTEXT_REQUIRED";
      error.status = 503;
      throw error;
    }
    return requestedTenantId || getActiveTenantId();
  };

  return {
    async getActiveStrategy(tenantContext) {
      const tenantId = tenantIdFor(tenantContext);
      const [rows] = await pool.execute(
        `SELECT tenant_id, strategy_type, model_deployment_id, is_active,
           created_at, updated_at
         FROM detection_strategies
         WHERE tenant_id = ? AND is_active = 1
         LIMIT 1`,
        [tenantId],
      );
      const row = rows?.[0] || null;
      if (!row) {
        return {
          tenantId,
          strategyType: "deterministic_rules",
          modelDeploymentId: null,
          isActive: 1,
        };
      }
      return {
        tenantId: row.tenant_id,
        strategyType: row.strategy_type,
        modelDeploymentId: row.model_deployment_id || null,
        isActive: Number(row.is_active),
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      };
    },

    async setStrategy(tenantContext, { strategyType, modelDeploymentId = null }) {
      const tenantId = tenantIdFor(tenantContext);
      const canonicalStrategy = String(strategyType || "").trim();
      const canonicalDeploymentId = String(modelDeploymentId || "").trim() || null;
      if (!STRATEGY_TYPES.has(canonicalStrategy)) {
        throw strategyValidationError("Unsupported detection strategy.");
      }
      if (canonicalStrategy === "approved_model") {
        if (
          !canonicalDeploymentId
          || !DEPLOYMENT_ID_PATTERN.test(canonicalDeploymentId)
          || !approvedDeploymentIds().has(canonicalDeploymentId)
        ) {
          throw strategyValidationError("The model deployment is not approved in this environment.");
        }
      } else if (canonicalDeploymentId !== null) {
        throw strategyValidationError("Deterministic strategy cannot select a model deployment.");
      }

      const connection = await pool.getConnection();
      try {
        await connection.beginTransaction();
        await connection.execute(
          "UPDATE detection_strategies SET is_active = 0 WHERE tenant_id = ? AND is_active = 1",
          [tenantId],
        );
        await connection.execute(
          `INSERT INTO detection_strategies
            (tenant_id, strategy_type, model_deployment_id, is_active)
           VALUES (?, ?, ?, 1)`,
          [tenantId, canonicalStrategy, canonicalDeploymentId],
        );
        await connection.commit();
      } catch (error) {
        await connection.rollback();
        throw error;
      } finally {
        connection.release();
      }

      return {
        tenantId,
        strategyType: canonicalStrategy,
        modelDeploymentId: canonicalDeploymentId,
      };
    },
  };
}
