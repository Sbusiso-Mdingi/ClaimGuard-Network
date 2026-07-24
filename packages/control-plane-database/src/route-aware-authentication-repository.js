import { createAuthenticationRepository } from "./authentication-repository.js";
import { executorOr } from "./transaction.js";

function activeRouteIsUsable(route) {
  return Boolean(
    route
      && !route.retired_at
      && route.provisioning_status === "active"
      && !["suspended", "unreachable"].includes(route.health_status),
  );
}

export function createRouteAwareAuthenticationRepository(defaultExecutor) {
  const base = createAuthenticationRepository(defaultExecutor);

  return {
    ...base,

    async getLegacyTenantBridge(organisationId, { executor } = {}) {
      const db = executorOr(defaultExecutor, executor);
      const [routeRows] = await db.execute(
        `SELECT r.route_id, r.route_type, r.provisioning_status, r.health_status,
                r.retired_at, r.active_at, o.canonical_slug
         FROM data_plane_routes r
         JOIN organisations o ON o.organisation_id = r.organisation_id
         WHERE r.organisation_id = ?
           AND r.active_route_slot = r.organisation_id
         ORDER BY r.route_generation DESC
         LIMIT 2`,
        [organisationId],
      );

      if ((routeRows || []).length !== 1) return null;

      const route = routeRows[0];
      if (!activeRouteIsUsable(route)) return null;

      if (route.route_type === "private_database") {
        if (!route.active_at || !route.canonical_slug) return null;

        return {
          legacyTenantId: organisationId,
          legacyTenantSlug: route.canonical_slug,
          migrationStatus: "verified",
          verifiedAt: route.active_at,
          routeType: "private_database",
          routeId: route.route_id,
        };
      }

      if (route.route_type !== "legacy_shared") return null;

      const [mappingRows] = await db.execute(
        `SELECT legacy_tenant_id, legacy_tenant_slug, migration_status,
                verified_at, route_id
         FROM legacy_tenant_mappings
         WHERE organisation_id = ?
           AND route_id = ?
         LIMIT 2`,
        [organisationId, route.route_id],
      );

      if ((mappingRows || []).length !== 1) return null;

      const mapping = mappingRows[0];
      return {
        legacyTenantId: mapping.legacy_tenant_id,
        legacyTenantSlug: mapping.legacy_tenant_slug,
        migrationStatus: mapping.migration_status,
        verifiedAt: mapping.verified_at || null,
        routeType: "legacy_shared",
        routeId: mapping.route_id || null,
      };
    },
  };
}
