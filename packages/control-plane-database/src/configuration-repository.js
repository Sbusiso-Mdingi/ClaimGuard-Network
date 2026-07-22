import crypto from "node:crypto";

import { ControlPlaneValidationError } from "./errors.js";
import { projectSafeDemoCatalogueEntry } from "./projections.js";
import { executorOr } from "./transaction.js";
import { assertNoPlaintextPassword, validateSecretReference } from "./validation.js";

export function createConfigurationRepository(defaultExecutor) {
  return {
    async createDemoCatalogueEntry(input, { executor } = {}) {
      assertNoPlaintextPassword(input);
      const db = executorOr(defaultExecutor, executor);
      const [organisationRows] = await db.execute(
        "SELECT deployment_class FROM organisations WHERE organisation_id = ? LIMIT 1",
        [input.organisationId],
      );
      if (organisationRows?.[0]?.deployment_class !== "demo") {
        throw new ControlPlaneValidationError("Demo catalogue entries require a demo-classified organisation.", "DEMO_ORGANISATION_REQUIRED");
      }
      const catalogueEntryId = input.catalogueEntryId || crypto.randomUUID();
      await db.execute(
        `INSERT INTO demo_account_catalogue
          (catalogue_entry_id, organisation_id, membership_id, display_label, role_label,
           username_display_value, secret_reference, enabled, display_order)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [catalogueEntryId, input.organisationId, input.membershipId, input.displayLabel, input.roleLabel,
          input.usernameDisplayValue, validateSecretReference(input.secretReference, { required: true }),
          input.enabled ? 1 : 0, Number(input.displayOrder || 0)],
      );
      return { catalogueEntryId };
    },

    async listSafeEnabledDemoCatalogue(organisationId, { executor } = {}) {
      const [rows] = await executorOr(defaultExecutor, executor).execute(
        `SELECT * FROM demo_account_catalogue
         WHERE organisation_id = ? AND enabled = 1 ORDER BY display_order, catalogue_entry_id`,
        [organisationId],
      );
      return (rows || []).map(projectSafeDemoCatalogueEntry).filter(Boolean);
    },

    async listSafeEnabledDemoCatalogueAll({ executor } = {}) {
      const [rows] = await executorOr(defaultExecutor, executor).execute(
        `SELECT d.*, o.canonical_slug, o.display_name AS organisation_name
         FROM demo_account_catalogue d JOIN organisations o ON o.organisation_id = d.organisation_id
         WHERE d.enabled = 1 AND o.deployment_class = 'demo'
         ORDER BY o.canonical_slug, d.display_order, d.catalogue_entry_id`,
      );
      return (rows || []).map((row) => {
        const safe = projectSafeDemoCatalogueEntry(row);
        return safe ? { ...safe, organisationSlug: row.canonical_slug, organisationName: row.organisation_name } : null;
      }).filter(Boolean);
    },

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
