import crypto from "node:crypto";

import { ControlPlaneConflictError, ControlPlaneValidationError } from "./errors.js";
import { projectSafeRoute } from "./projections.js";
import { executorOr } from "./transaction.js";
import { requireEnum, ROUTE_TYPES, validateSecretReference } from "./validation.js";

export function createDataPlaneRoutesRepository(defaultExecutor) {
  return {
    async register(input, { executor } = {}) {
      const db = executorOr(defaultExecutor, executor);
      const routeId = input.routeId || crypto.randomUUID();
      const routeType = requireEnum(input.routeType, ROUTE_TYPES, "route_type");
      const secretReference = validateSecretReference(input.secretReference, { required: routeType !== "platform_none" });
      if (routeType === "platform_none" && (input.databaseName || secretReference)) {
        throw new ControlPlaneValidationError("platform_none routes cannot name a database or secret reference.", "INVALID_PLATFORM_ROUTE");
      }
      const [generationRows] = await db.execute(
        "SELECT COALESCE(MAX(route_generation), 0) + 1 AS next_generation FROM data_plane_routes WHERE organisation_id = ?",
        [input.organisationId],
      );
      const generation = Number(generationRows?.[0]?.next_generation || 1);
      if (input.activate) {
        await db.execute(
          "UPDATE data_plane_routes SET active_route_slot = NULL, retired_at = COALESCE(retired_at, UTC_TIMESTAMP(3)) WHERE organisation_id = ? AND active_route_slot IS NOT NULL",
          [input.organisationId],
        );
      }
      try {
        await db.execute(
          `INSERT INTO data_plane_routes
            (route_id, organisation_id, route_type, logical_database_identifier, azure_resource_identifier,
             database_name, secret_reference, region, route_generation, schema_version,
             provisioning_status, health_status, active_at, active_route_slot)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [routeId, input.organisationId, routeType, input.logicalDatabaseIdentifier, input.azureResourceIdentifier || null,
            input.databaseName || null, secretReference, input.region || null, generation, input.schemaVersion || null,
            input.provisioningStatus || "pending", input.healthStatus || "unknown",
            input.activate ? new Date() : null, input.activate ? input.organisationId : null],
        );
      } catch (error) {
        if (error?.code === "ER_DUP_ENTRY" || error?.errno === 1062) {
          throw new ControlPlaneConflictError("An active route or route generation already exists.", "DATA_PLANE_ROUTE_CONFLICT");
        }
        throw error;
      }
      return this.getSafeById(routeId, { executor: db });
    },

    async getInternalById(routeId, { executor } = {}) {
      const [rows] = await executorOr(defaultExecutor, executor).execute("SELECT * FROM data_plane_routes WHERE route_id = ? LIMIT 1", [routeId]);
      return rows?.[0] || null;
    },

    async getSafeById(routeId, { executor } = {}) {
      return projectSafeRoute(await this.getInternalById(routeId, { executor }));
    },

    async getSafeActiveForOrganisation(organisationId, { executor } = {}) {
      const [rows] = await executorOr(defaultExecutor, executor).execute(
        "SELECT * FROM data_plane_routes WHERE organisation_id = ? AND active_route_slot = organisation_id LIMIT 1",
        [organisationId],
      );
      return projectSafeRoute(rows?.[0]);
    },
  };
}
