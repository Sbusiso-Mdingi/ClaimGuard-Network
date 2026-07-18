import { ClaimOwnershipConflictError } from "@claimguard/database";

import { authorizeTenantScopedRequest, createRequireOperationalRouteAuthorizationMiddleware } from "../middleware/authorization-middleware.js";
import { OPERATIONAL_ROUTE_IDS } from "../authorization-policy.js";

export function registerClaimsRoutes(app, {
  claimIngestionService,
  claimsReadRepository = null,
  tenantRepository = null,
  logger,
} = {}) {
  const requireClaimsListPermission = createRequireOperationalRouteAuthorizationMiddleware({
    routeId: OPERATIONAL_ROUTE_IDS.CLAIMS_LIST,
  });
  const requireClaimsDetailPermission = createRequireOperationalRouteAuthorizationMiddleware({
    routeId: OPERATIONAL_ROUTE_IDS.CLAIMS_DETAIL,
  });
  const requireClaimsIngestPermission = createRequireOperationalRouteAuthorizationMiddleware({
    routeId: OPERATIONAL_ROUTE_IDS.CLAIMS_INGEST,
  });

  app.get(
    "/claims",
    requireClaimsListPermission,
    async (c) => {
      const tenantDecision = await authorizeTenantScopedRequest({ c, tenantRepository });
      if (!tenantDecision.ok) return tenantDecision.response;

      if (!claimsReadRepository?.listClaims) {
        return c.json(
          {
            available: false,
            message: "Claims read repository is not configured.",
          },
          503,
        );
      }

      const page = c.req.query("page");
      const pageSize = c.req.query("pageSize");

      try {
        const result = await claimsReadRepository.listClaims({ page, pageSize });
        return c.json({
          available: true,
          claims: result.claims,
          pagination: result.pagination,
        });
      } catch (error) {
        logger?.("error", "claims_list_failed", {
          requestId: c.get("requestId") || null,
          message: error?.message || "Claims list failed.",
        });
        return c.json(
          {
            available: false,
            message: "Claims list is currently unavailable.",
          },
          500,
        );
      }
    },
  );

  app.get(
    "/claims/:claimId",
    requireClaimsDetailPermission,
    async (c) => {
      const tenantDecision = await authorizeTenantScopedRequest({ c, tenantRepository });
      if (!tenantDecision.ok) return tenantDecision.response;

      if (!claimsReadRepository?.getClaimById) {
        return c.json(
          {
            available: false,
            message: "Claims read repository is not configured.",
          },
          503,
        );
      }

      const claimId = c.req.param("claimId");
      if (!claimId || !claimId.trim()) {
        return c.json(
          {
            available: false,
            message: "claimId is required.",
          },
          400,
        );
      }

      try {
        const claim = await claimsReadRepository.getClaimById(claimId);
        if (!claim) {
          return c.json(
            {
              available: false,
              message: "Claim not found.",
            },
            404,
          );
        }

        return c.json({
          available: true,
          claim,
        });
      } catch (error) {
        logger?.("error", "claim_detail_failed", {
          requestId: c.get("requestId") || null,
          claimId,
          message: error?.message || "Claim detail failed.",
        });
        return c.json(
          {
            available: false,
            message: "Claim details are currently unavailable.",
          },
          500,
        );
      }
    },
  );

  app.post(
    "/claims/ingest",
    requireClaimsIngestPermission,
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

        return c.json({
          available: true,
          committed: true,
          processing: summary.processing,
          ingestion: summary,
        }, 202);
      } catch (error) {
        logger?.("error", "claims_ingestion_failed", {
          requestId: c.get("requestId") || null,
          message: error?.message || "Claim ingestion failed.",
        });

        const isOwnershipConflict = error instanceof ClaimOwnershipConflictError || error?.code === "CLAIM_OWNERSHIP_CONFLICT";

        return c.json(
          {
            available: false,
            ...(isOwnershipConflict ? { code: "CLAIM_OWNERSHIP_CONFLICT" } : {}),
            message: isOwnershipConflict
              ? "Claim identifier is already owned by another tenant."
              : error?.message || "Claim ingestion failed.",
          },
          isOwnershipConflict ? 409 : 400,
        );
      }
    },
  );
}
