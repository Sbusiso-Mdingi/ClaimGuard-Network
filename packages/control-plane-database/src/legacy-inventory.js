import { ControlPlaneConflictError } from "./errors.js";

export async function readLegacyTenantInventory(operationalPool) {
  const [rows] = await operationalPool.execute(
    "SELECT tenant_id, tenant_slug, tenant_name, status FROM tenants ORDER BY tenant_id",
  );
  return (rows || []).map((row) => ({
    tenantId: row.tenant_id,
    tenantSlug: row.tenant_slug,
    tenantName: row.tenant_name,
    status: row.status,
  }));
}

export function compareLegacyTenantInventory({ tenants, organisations, mappings }) {
  const organisationBySlug = new Map(organisations.map((item) => [item.canonicalSlug, item]));
  const mappingByTenantId = new Map(mappings.map((item) => [item.legacyTenantId, item]));
  const mappingByTenantSlug = new Map(mappings.map((item) => [item.legacyTenantSlug, item]));

  return tenants.map((tenant) => {
    const byId = mappingByTenantId.get(tenant.tenantId) || null;
    const bySlug = mappingByTenantSlug.get(tenant.tenantSlug) || null;
    const organisation = organisationBySlug.get(tenant.tenantSlug) || null;
    const conflicts = [];
    if (byId && byId.legacyTenantSlug !== tenant.tenantSlug) conflicts.push("tenant_id_mapped_to_different_slug");
    if (bySlug && bySlug.legacyTenantId !== tenant.tenantId) conflicts.push("tenant_slug_mapped_to_different_id");
    if (byId && organisation && byId.organisationId !== organisation.organisationId) conflicts.push("slug_resolves_to_different_organisation");
    return {
      ...tenant,
      status: conflicts.length ? "conflict" : byId ? "mapped" : organisation ? "organisation_exists_unmapped" : "unmapped",
      organisationId: byId?.organisationId || organisation?.organisationId || null,
      conflicts,
    };
  });
}

export async function applyUnambiguousLegacyMappings({ report, deploymentClass, service, repositories }) {
  if (!deploymentClass) throw new TypeError("deploymentClass is required for shadow inventory apply.");
  const results = [];
  for (const candidate of report) {
    if (candidate.status === "conflict") {
      results.push({ tenantId: candidate.tenantId, outcome: "conflict", conflicts: candidate.conflicts });
      continue;
    }
    if (candidate.status === "mapped") {
      results.push({ tenantId: candidate.tenantId, outcome: "unchanged", organisationId: candidate.organisationId });
      continue;
    }
    let organisationId = candidate.organisationId;
    if (!organisationId) {
      const organisation = await service.createDraftOrganisation({
        displayName: candidate.tenantName,
        canonicalSlug: candidate.tenantSlug,
        organisationType: "medical_scheme",
        deploymentClass,
      }, { type: "system", id: "legacy-inventory", source: "legacy-inventory" });
      organisationId = organisation.organisationId;
    }
    try {
      const mapping = await service.mapLegacyTenant({
        legacyTenantId: candidate.tenantId,
        legacyTenantSlug: candidate.tenantSlug,
        organisationId,
        migrationStatus: "mapped",
        migrationMetadata: { sourceStatus: candidate.status, shadowOnly: true },
      }, { type: "system", id: "legacy-inventory", source: "legacy-inventory" });
      results.push({ tenantId: candidate.tenantId, outcome: "mapped", organisationId: mapping.organisationId });
    } catch (error) {
      if (error instanceof ControlPlaneConflictError) {
        results.push({ tenantId: candidate.tenantId, outcome: "conflict", conflicts: [error.code] });
      } else throw error;
    }
  }
  return results;
}
