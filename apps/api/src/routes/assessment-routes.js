import {
  AssessmentContextRepositoryError,
  persistMemberVersion,
  persistProviderVersion,
  createReplacementAssessmentsForCorrection,
} from "@claimguard/database";

import { OPERATIONAL_ROUTE_IDS } from "../authorization-policy.js";
import {
  createRequireOperationalRouteAuthorizationMiddleware,
  createRequireTenantAccessMiddleware,
} from "../middleware/authorization-middleware.js";
import { getOperationalServices } from "../operational-service-context.js";

function correctionActor(c) {
  return `user:${c.get("authContext")?.user_id || "unknown"}`;
}

function correctionSource(c) {
  return `api:correction:${c.get("authContext")?.user_id || "unknown"}`;
}

function correctionCorrelationId(c) {
  return c.get("requestId") || undefined;
}

function resolvePool() {
  const services = getOperationalServices();
  return services?.pool || null;
}

export function registerAssessmentRoutes(app, {
  tenantRepository = null,
} = {}) {
  const requireAssessmentRead = createRequireOperationalRouteAuthorizationMiddleware({
    routeId: OPERATIONAL_ROUTE_IDS.ASSESSMENT_PROVENANCE,
  });
  const requireMemberCorrection = createRequireOperationalRouteAuthorizationMiddleware({
    routeId: OPERATIONAL_ROUTE_IDS.MEMBER_CORRECTION,
  });
  const requireProviderCorrection = createRequireOperationalRouteAuthorizationMiddleware({
    routeId: OPERATIONAL_ROUTE_IDS.PROVIDER_CORRECTION,
  });
  const requireTenantAccess = createRequireTenantAccessMiddleware({ tenantRepository });

  // POST /assessment/members/:memberId/correction
  app.post(
    "/assessment/members/:memberId/correction",
    requireMemberCorrection,
    requireTenantAccess,
    async (c) => {
      const pool = resolvePool();
      if (!pool) {
        return c.json({ code: "DATA_PLANE_UNAVAILABLE", message: "Operational data plane is not available." }, 503);
      }
      const tenantContext = c.get("tenantContext") || null;
      if (!tenantContext?.tenant_id) {
        return c.json({ code: "TENANT_CONTEXT_MISSING", message: "Tenant context could not be resolved." }, 403);
      }
      const tenantId = tenantContext.tenant_id;
      const memberId = c.req.param("memberId");

      let body;
      try {
        body = await c.req.json();
      } catch {
        return c.json({ code: "INVALID_JSON", message: "Request body must be valid JSON." }, 400);
      }

      const member = body?.member;
      if (!member || typeof member !== "object") {
        return c.json({ code: "CORRECTION_INVALID", message: "member object is required." }, 400);
      }
      if (member.member_id !== memberId) {
        return c.json({ code: "CORRECTION_INVALID", message: "member.member_id must match the URL path parameter." }, 422);
      }

      const reasonCode = body?.reason_code || "ADMIN_CORRECTION";
      const reasonSummary = body?.reason_summary || "Member correction via governed API.";
      const sourceReference = body?.source_reference || null;
      const actorId = correctionActor(c);
      const source = correctionSource(c);
      const correlationId = correctionCorrelationId(c);

      let connection;
      try {
        connection = await pool.getConnection();
        await connection.beginTransaction();

        const result = await persistMemberVersion(connection, {
          tenantId,
          member: { ...member, member_id: memberId },
          actorId,
          reasonCode,
          reasonSummary,
          sourceReference,
          correlationId,
        });

        const replacements = result.correctionEventId
          ? await createReplacementAssessmentsForCorrection(connection, {
              tenantId,
              entityType: "MEMBER",
              entityId: memberId,
              previousVersion: result.version - 1,
              newVersion: result.version,
              correctionEventId: result.correctionEventId,
              classification: result.classification,
              createdBy: actorId,
              source,
              correlationId,
            })
          : [];

        await connection.commit();

        return c.json({
          memberId,
          disposition: result.disposition,
          changed: result.changed,
          version: result.version,
          correctionEventId: result.correctionEventId,
          assessmentImpact: result.classification?.assessmentImpact ?? null,
          replacementAssessments: replacements.map((r) => ({
            assessmentId: r.assessment.assessmentId,
            jobId: r.job.id,
          })),
        }, 200);
      } catch (error) {
        try { await connection?.rollback(); } catch { /* preserve original */ }
        if (error instanceof AssessmentContextRepositoryError) {
          return c.json({ code: error.code, message: error.message }, error.status ?? 409);
        }
        throw error;
      } finally {
        connection?.release();
      }
    },
  );

  // POST /assessment/providers/:providerId/correction
  app.post(
    "/assessment/providers/:providerId/correction",
    requireProviderCorrection,
    requireTenantAccess,
    async (c) => {
      const pool = resolvePool();
      if (!pool) {
        return c.json({ code: "DATA_PLANE_UNAVAILABLE", message: "Operational data plane is not available." }, 503);
      }
      const tenantContext = c.get("tenantContext") || null;
      if (!tenantContext?.tenant_id) {
        return c.json({ code: "TENANT_CONTEXT_MISSING", message: "Tenant context could not be resolved." }, 403);
      }
      const tenantId = tenantContext.tenant_id;
      const providerId = c.req.param("providerId");

      let body;
      try {
        body = await c.req.json();
      } catch {
        return c.json({ code: "INVALID_JSON", message: "Request body must be valid JSON." }, 400);
      }

      const provider = body?.provider;
      if (!provider || typeof provider !== "object") {
        return c.json({ code: "CORRECTION_INVALID", message: "provider object is required." }, 400);
      }
      if (provider.provider_id !== providerId) {
        return c.json({ code: "CORRECTION_INVALID", message: "provider.provider_id must match the URL path parameter." }, 422);
      }

      const reasonCode = body?.reason_code || "ADMIN_CORRECTION";
      const reasonSummary = body?.reason_summary || "Provider correction via governed API.";
      const sourceReference = body?.source_reference || null;
      const actorId = correctionActor(c);
      const source = correctionSource(c);
      const correlationId = correctionCorrelationId(c);

      let connection;
      try {
        connection = await pool.getConnection();
        await connection.beginTransaction();

        const result = await persistProviderVersion(connection, {
          tenantId,
          provider: { ...provider, provider_id: providerId },
          actorId,
          reasonCode,
          reasonSummary,
          sourceReference,
          correlationId,
        });

        const replacements = result.correctionEventId
          ? await createReplacementAssessmentsForCorrection(connection, {
              tenantId,
              entityType: "PROVIDER",
              entityId: providerId,
              previousVersion: result.version - 1,
              newVersion: result.version,
              correctionEventId: result.correctionEventId,
              classification: result.classification,
              createdBy: actorId,
              source,
              correlationId,
            })
          : [];

        await connection.commit();

        return c.json({
          providerId,
          disposition: result.disposition,
          changed: result.changed,
          version: result.version,
          correctionEventId: result.correctionEventId,
          assessmentImpact: result.classification?.assessmentImpact ?? null,
          replacementAssessments: replacements.map((r) => ({
            assessmentId: r.assessment.assessmentId,
            jobId: r.job.id,
          })),
        }, 200);
      } catch (error) {
        try { await connection?.rollback(); } catch { /* preserve original */ }
        if (error instanceof AssessmentContextRepositoryError) {
          return c.json({ code: error.code, message: error.message }, error.status ?? 409);
        }
        throw error;
      } finally {
        connection?.release();
      }
    },
  );

  // GET /assessment/versions/:assessmentId
  app.get(
    "/assessment/versions/:assessmentId",
    requireAssessmentRead,
    requireTenantAccess,
    async (c) => {
      const pool = resolvePool();
      if (!pool) {
        return c.json({ code: "DATA_PLANE_UNAVAILABLE", message: "Operational data plane is not available." }, 503);
      }
      const tenantContext = c.get("tenantContext") || null;
      if (!tenantContext?.tenant_id) {
        return c.json({ code: "TENANT_CONTEXT_MISSING", message: "Tenant context could not be resolved." }, 403);
      }
      const tenantId = tenantContext.tenant_id;
      const assessmentId = c.req.param("assessmentId");

      const [rows] = await pool.execute(
        `SELECT
           assessment_id, tenant_id, claim_id, claim_version,
           member_id, member_version, provider_id, provider_version,
           detection_strategy_id, strategy_type, model_deployment_id,
           provenance_status, source_correction_event_id, supersedes_assessment_id,
           created_at
         FROM assessment_versions
         WHERE tenant_id = ?
           AND assessment_id = ?
         LIMIT 1`,
        [tenantId, assessmentId],
      );

      const row = rows?.[0] ?? null;
      if (!row) {
        return c.json({ code: "ASSESSMENT_NOT_FOUND", message: `Assessment ${assessmentId} was not found.` }, 404);
      }

      return c.json({
        assessmentId: row.assessment_id,
        tenantId: row.tenant_id,
        claimId: row.claim_id,
        claimVersion: Number(row.claim_version),
        memberId: row.member_id,
        memberVersion: Number(row.member_version),
        providerId: row.provider_id,
        providerVersion: Number(row.provider_version),
        detectionStrategyId: Number(row.detection_strategy_id),
        strategyType: row.strategy_type,
        modelDeploymentId: row.model_deployment_id ?? null,
        provenanceStatus: row.provenance_status,
        sourceCorrectionEventId: row.source_correction_event_id ?? null,
        supersedesAssessmentId: row.supersedes_assessment_id ?? null,
        createdAt: row.created_at instanceof Date
          ? row.created_at.toISOString()
          : String(row.created_at),
      }, 200);
    },
  );
}
