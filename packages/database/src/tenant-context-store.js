import { AsyncLocalStorage } from "node:async_hooks";

import { LEGACY_DEFAULT_TENANT_ID, LEGACY_DEFAULT_TENANT_SLUG } from "./tenant-repository.js";

const tenantContextStorage = new AsyncLocalStorage();

export function runWithTenantContext(tenantContext, callback) {
  return tenantContextStorage.run(tenantContext || null, callback);
}

export function getActiveTenantContext() {
  return tenantContextStorage.getStore() || null;
}

export function getActiveTenantId() {
  return getActiveTenantContext()?.tenant_id || LEGACY_DEFAULT_TENANT_ID;
}

export function getLegacyDefaultTenantContext() {
  return Object.freeze({
    tenant_id: LEGACY_DEFAULT_TENANT_ID,
    tenant_slug: LEGACY_DEFAULT_TENANT_SLUG,
    scheme_id: null,
    source: "legacy_fallback",
  });
}