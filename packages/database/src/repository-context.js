import { getActiveTenantId } from "./tenant-context-store.js";
import { requireOperationalDataPlaneContext } from "./data-plane-context.js";

export function repositoryTenantId(dataPlaneContext, { allowLegacyTenantContext = false } = {}) {
  if (dataPlaneContext) return requireOperationalDataPlaneContext(dataPlaneContext).operationalTenantId;
  if (allowLegacyTenantContext) return getActiveTenantId();
  const error = new Error("An explicit verified DataPlaneContext is required for operational repository access.");
  error.code = "DATA_PLANE_CONTEXT_REQUIRED";
  error.status = 503;
  throw error;
}

export function assertRepositoryTenant(dataPlaneContext, tenantId) {
  const canonical = repositoryTenantId(dataPlaneContext);
  if (tenantId !== canonical) {
    const error = new Error("The supplied tenant does not match the verified DataPlaneContext.");
    error.code = "DATA_PLANE_TENANT_MISMATCH";
    error.status = 403;
    throw error;
  }
  return canonical;
}
