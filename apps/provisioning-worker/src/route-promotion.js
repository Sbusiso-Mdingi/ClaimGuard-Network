import {
  createControlPlanePool,
} from "@claimguard/control-plane-database";

export const CANONICAL_PRIVATE_SCHEMA_VERSION = "14";

export async function promoteCompatiblePrivateRoutes(
  {
    databaseUrl = process.env.CONTROL_PLANE_MYSQL_URL,
    schemaVersion = CANONICAL_PRIVATE_SCHEMA_VERSION,
    pool = null,
  } = {},
) {
  const ownsPool = !pool;
  const resolvedPool = pool || createControlPlanePool(databaseUrl);

  try {
    const [result] = await resolvedPool.execute(
      `
        UPDATE data_plane_routes AS route
        JOIN organisation_schema_status AS schema_status
          ON schema_status.organisation_id = route.organisation_id
         AND schema_status.route_id = route.route_id
        SET
          route.provisioning_status = 'ready',
          route.health_status = 'healthy'
        WHERE route.route_type = 'private_database'
          AND route.schema_version = ?
          AND route.retired_at IS NULL
          AND route.active_route_slot IS NULL
          AND schema_status.expected_schema_version = ?
          AND schema_status.observed_schema_version = ?
          AND schema_status.compatibility_status = 'compatible'
      `,
      [schemaVersion, schemaVersion, schemaVersion],
    );

    return {
      promoted: Number(result?.affectedRows || 0),
      schemaVersion,
    };
  } finally {
    if (ownsPool) {
      await resolvedPool.end();
    }
  }
}
