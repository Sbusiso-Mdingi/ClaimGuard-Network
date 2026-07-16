import { runWithTenantContext } from "@claimguard/database";

import { ApplicationError, applicationErrorResponse } from "../application-errors.js";
import { resolveTenantContext } from "../tenant-context.js";

export function createTenantContextMiddleware({
  tenantRepository = null,
} = {}) {
  return async (c, next) => {
    try {
      const currentAuthContext = c.get("authContext") || null;
      const tenantContext = await resolveTenantContext({
        request: c.req.raw,
        authContext: currentAuthContext,
        tenantRepository,
      });

      const authContext = currentAuthContext?.is_authenticated
        ? Object.freeze({ ...currentAuthContext, tenant_id: tenantContext.tenant_id })
        : currentAuthContext;

      c.set("authContext", authContext);
      c.req.raw.authContext = authContext;
      c.set("tenantContext", tenantContext);
      c.req.raw.tenantContext = tenantContext;
      await runWithTenantContext(tenantContext, async () => {
        await next();
      });
    } catch (error) {
      if (error instanceof ApplicationError) {
        return applicationErrorResponse(c, error);
      }
      throw error;
    }
  };
}
