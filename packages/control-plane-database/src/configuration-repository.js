import { executorOr } from "./transaction.js";

export function createConfigurationRepository(defaultExecutor) {
  return {
    async setFeatureFlag(input, { executor } = {}) {
      const scopeKey = input.organisationId || "platform";
      await executorOr(defaultExecutor, executor).execute(
        `INSERT INTO organisation_feature_flags
          (scope_key, organisation_id, flag_key, value_type, typed_value, enabled, version)
         VALUES (?, ?, ?, ?, ?, ?, 1)
         ON DUPLICATE KEY UPDATE typed_value = VALUES(typed_value), value_type = VALUES(value_type),
          enabled = VALUES(enabled), version = version + 1`,
        [scopeKey, input.organisationId || null, input.flagKey, input.valueType, JSON.stringify(input.value), input.enabled ? 1 : 0],
      );
      return { scopeKey, flagKey: input.flagKey };
    },

    async getFeatureFlag(input, { executor } = {}) {
      const scopeKey = input.organisationId || "platform";
      const [rows] = await executorOr(defaultExecutor, executor).execute(
        `SELECT typed_value, value_type, enabled FROM organisation_feature_flags
         WHERE scope_key = ? AND flag_key = ? LIMIT 1`,
        [scopeKey, input.flagKey],
      );
      if (!rows || rows.length === 0) return null;
      const row = rows[0];
      return {
        value: row.value_type === "json" ? JSON.parse(row.typed_value) : row.typed_value,
        enabled: row.enabled === 1,
      };
    },
  };
}
