import {
  ClaimOwnershipConflictError,
  ClaimReferenceValidationError,
  ReferenceOwnershipConflictError,
} from "@claimguard/database";
import { createClaimIngestionBatchSchema } from "@claimguard/shared-schema";
import { bodyLimit } from "hono/body-limit";

import { authorizeTenantScopedRequest, createRequireOperationalRouteAuthorizationMiddleware } from "../middleware/authorization-middleware.js";
import { OPERATIONAL_ROUTE_IDS } from "../authorization-policy.js";

export function registerClaimsRoutes(app, {
  claimIngestionService,
  claimsReadRepository = null,
  tenantRepository = null,
  logger,
} = {}) {
  const maxBatchSize = Math.min(5_000, Math.max(1, Number.parseInt(process.env.CLAIM_INGESTION_MAX_BATCH_SIZE || "500", 10) || 500));
  const maxReferenceRecords = Math.min(20_000, Math.max(maxBatchSize, Number.parseInt(process.env.CLAIM_INGESTION_MAX_REFERENCE_RECORDS || "2000", 10) || 2_000));
  const maxBodyBytes = Math.min(20_000_000, Math.max(65_536, Number.parseInt(process.env.CLAIM_INGESTION_MAX_BODY_BYTES || "2000000", 10) || 2_000_000));
  const ingestionBatchSchema = createClaimIngestionBatchSchema({ maxBatchSize, maxReferenceRecords });
  const requireClaimsListPermission = createRequireOperationalRouteAuthorizationMiddleware({
    routeId: OPERATIONAL_ROUTE_IDS.CLAIMS_LIST,
  });
  const requireClaimsDetailPermission = createRequireOperationalRouteAuthorizationMiddleware({
    routeId: OPERATIONAL_ROUTE_IDS.CLAIMS_DETAIL,
  });
  const requireClaimsIngestPermission = createRequireOperationalRouteAuthorizationMiddleware({
    routeId: OPERATIONAL_ROUTE_IDS.CLAIMS_INGEST,
  });
  const enforceIngestionBodyLimit = bodyLimit({
    maxSize: maxBodyBytes,
    onError: (c) => c.json({
      available: false,
      code: "INGESTION_BODY_TOO_LARGE",
      message: `Request body exceeds the ${maxBodyBytes}-byte ingestion limit.`,
    }, 413),
  });
  const requireJsonIngestion = async (c, next) => {
    const contentType = String(c.req.header("content-type") || "").split(";", 1)[0].trim().toLowerCase();
    if (contentType !== "application/json") {
      return c.json({
        available: false,
        code: "UNSUPPORTED_INGESTION_MEDIA_TYPE",
        message: "Claim ingestion requires Content-Type: application/json.",
      }, 415);
    }
    return next();
  };

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
    requireJsonIngestion,
    enforceIngestionBodyLimit,
    async (c) => {
      const payload = await c.req.json().catch(() => null);
      const parsed = ingestionBatchSchema.safeParse(payload);
      if (!parsed.success) {
        return c.json(
          {
            available: false,
            code: "INVALID_INGESTION_BATCH",
            message: "Request body does not satisfy the claim-ingestion contract.",
            issues: parsed.error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message })),
          },
          400,
        );
      }
      const { claims, schemes, members, providers } = parsed.data;

      if (!claimIngestionService?.isConfigured?.()) {
        return c.json(
          {
            available: false,
            message: "Claim ingestion service is not configured.",
          },
          503,
        );
      }

      const suppliedSchemeIds = new Set(schemes.map((scheme) => scheme.scheme_id));
      const schemeIds = [...new Set([
        ...claims.map((claim) => claim.scheme_id),
        ...members.map((member) => member.scheme_id),
        ...providers.map((provider) => provider.scheme_id),
      ].filter((schemeId) => !suppliedSchemeIds.has(schemeId)))];

      const tenantDecision = await authorizeTenantScopedRequest({
        c,
        tenantRepository,
        resourceSchemeIds: schemeIds,
      });

      if (!tenantDecision.ok) {
        return tenantDecision.response;
      }

      try {
        const authContext = c.get("authContext") || null;
        const source = authContext?.source === "internal_service"
          ? `service:${authContext.user_id}`
          : parsed.data.source;
        const summary = await claimIngestionService.ingest({
          claims,
          schemes,
          members,
          providers,
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

        const isClaimOwnershipConflict = error instanceof ClaimOwnershipConflictError || error?.code === "CLAIM_OWNERSHIP_CONFLICT";
        const isReferenceOwnershipConflict = error instanceof ReferenceOwnershipConflictError || error?.code === "REFERENCE_OWNERSHIP_CONFLICT";
        const isClaimReferenceInvalid = error instanceof ClaimReferenceValidationError || error?.code === "CLAIM_REFERENCE_INVALID";
        const isOwnershipConflict = isClaimOwnershipConflict || isReferenceOwnershipConflict;

        return c.json(
          {
            available: false,
            ...(isClaimOwnershipConflict ? { code: "CLAIM_OWNERSHIP_CONFLICT" } : {}),
            ...(isReferenceOwnershipConflict ? { code: "REFERENCE_OWNERSHIP_CONFLICT" } : {}),
            ...(isClaimReferenceInvalid ? { code: "CLAIM_REFERENCE_INVALID" } : {}),
            message: isClaimOwnershipConflict
              ? "Claim identifier is already owned by another tenant."
              : isReferenceOwnershipConflict
                ? "A reference-data identifier is already owned by another tenant."
              : isClaimReferenceInvalid
                ? "A claim reference is missing, belongs to another tenant, or belongs to a different scheme."
              : error?.message || "Claim ingestion failed.",
          },
          isOwnershipConflict ? 409 : isClaimReferenceInvalid ? 422 : 400,
        );
      }
    },
  );
}
