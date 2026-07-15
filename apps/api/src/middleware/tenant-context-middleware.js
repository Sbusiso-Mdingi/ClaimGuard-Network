import { runWithTenantContext } from "@claimguard/database";

import { resolveTenantContext } from "../tenant-context.js";

export function createTenantContextMiddleware({
  tenantRepository = null,
  defaultTenantId = process.env.DEFAULT_TENANT_ID || null,
  nodeEnv = process.env.NODE_ENV || "development",
} = {}) {
  return async (c, next) => {
    let tenantContext;

    try {
      tenantContext = await resolveTenantContext({
        request: c.req.raw,
        tenantRepository,
        defaultTenantId,
        nodeEnv,
      });
    } catch {
      tenantContext = Object.freeze({
        tenant_id: defaultTenantId || null,
        tenant_slug: null,
        scheme_id: null,
        source: "legacy_fallback",
      });
    }

    c.set("tenantContext", tenantContext);
    c.req.raw.tenantContext = tenantContext;
    await runWithTenantContext(tenantContext, async () => {
      await next();
    });
  };
}
