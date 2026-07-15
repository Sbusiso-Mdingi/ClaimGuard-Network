import { authorizeTenantScopedRequest, createRequirePermissionMiddleware } from "../middleware/authorization-middleware.js";
import { CLAIMGUARD_PERMISSIONS } from "../authorization-policy.js";

export function registerClaimsRoutes(app, {
  claimIngestionService,
  tenantRepository = null,
  logger,
} = {}) {
  app.post(
    "/claims/ingest",
    createRequirePermissionMiddleware({
      permission: CLAIMGUARD_PERMISSIONS.CLAIMS_INGEST,
    }),
    async (c) => {
      const payload = await c.req.json().catch(() => null);
      const claims = payload?.claims;

      if (!Array.isArray(claims) || claims.length === 0) {
        return c.json(
          {
            available: false,
            message: "Request body must include a non-empty claims array.",
          },
          400,
        );
      }

      if (!claimIngestionService?.isConfigured?.()) {
        return c.json(
          {
            available: false,
            message: "Claim ingestion service is not configured.",
          },
          503,
        );
      }

      const schemeIds = claims
        .map((claim) => (typeof claim?.scheme_id === "string" ? claim.scheme_id.trim() : null))
        .filter(Boolean);

      const tenantDecision = await authorizeTenantScopedRequest({
        c,
        tenantRepository,
        resourceSchemeIds: schemeIds,
      });

      if (!tenantDecision.ok) {
        return tenantDecision.response;
      }

      try {
        const source = payload?.source || "api";
        const summary = await claimIngestionService.ingest({
          claims,
          source,
          tenantContext: c.get("tenantContext") || null,
          requestId: c.get("requestId") || null,
        });

        return c.json({ available: true, ingestion: summary }, 202);
      } catch (error) {
        logger?.("error", "claims_ingestion_failed", {
          requestId: c.get("requestId") || null,
          message: error?.message || "Claim ingestion failed.",
        });

        return c.json(
          {
            available: false,
            message: error?.message || "Claim ingestion failed.",
          },
          400,
        );
      }
    },
  );
}
