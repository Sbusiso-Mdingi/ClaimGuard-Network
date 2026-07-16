import { getControlPlaneMigrationStatus } from "./migrate.js";

async function count(pool, sql) {
  const [rows] = await pool.execute(sql);
  return Number(rows?.[0]?.count || 0);
}

export async function getShadowDiagnostics(pool) {
  const migrationStatus = await getControlPlaneMigrationStatus(pool);
  const [organisationCount, mappingCount, missingRoutes, missingAdministrators, invalidRoleAssignments, slugConflicts, schemaMismatches, demoProblems] = await Promise.all([
    count(pool, "SELECT COUNT(*) AS count FROM organisations"),
    count(pool, "SELECT COUNT(*) AS count FROM legacy_tenant_mappings"),
    count(pool, `SELECT COUNT(*) AS count FROM organisations o LEFT JOIN data_plane_routes r ON r.organisation_id = o.organisation_id AND r.active_route_slot = o.organisation_id WHERE o.organisation_type = 'medical_scheme' AND r.route_id IS NULL`),
    count(pool, `SELECT COUNT(*) AS count FROM organisations o WHERE NOT EXISTS (SELECT 1 FROM organisation_memberships m JOIN membership_roles mr ON mr.membership_id = m.membership_id JOIN roles r ON r.role_id = mr.role_id WHERE m.organisation_id = o.organisation_id AND m.status = 'active' AND mr.revoked_at IS NULL AND r.role_key IN ('scheme_administrator', 'platform_administrator'))`),
    count(pool, `SELECT COUNT(*) AS count FROM membership_roles mr JOIN organisation_memberships m ON m.membership_id = mr.membership_id JOIN organisations o ON o.organisation_id = m.organisation_id JOIN roles r ON r.role_id = mr.role_id WHERE mr.revoked_at IS NULL AND r.organisation_scope <> o.organisation_type`),
    count(pool, "SELECT COUNT(*) AS count FROM (SELECT slug FROM organisation_slugs GROUP BY slug HAVING COUNT(*) > 1) duplicate_slugs"),
    count(pool, "SELECT COUNT(*) AS count FROM organisation_schema_status WHERE compatibility_status NOT IN ('compatible', 'unknown')"),
    count(pool, `SELECT COUNT(*) AS count FROM demo_account_catalogue d JOIN organisations o ON o.organisation_id = d.organisation_id WHERE d.enabled = 1 AND o.deployment_class <> 'demo'`),
  ]);
  return {
    shadowOnly: true,
    migrations: migrationStatus,
    organisationCount,
    legacyMappingCount: mappingCount,
    legacyMappingCompleteness: organisationCount ? mappingCount / organisationCount : 1,
    problems: { missingRoutes, missingAdministrators, invalidRoleAssignments, slugConflicts, schemaMismatches, demoCatalogueConfiguration: demoProblems },
  };
}
