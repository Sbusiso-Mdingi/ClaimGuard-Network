import {
  AssessmentContextRepositoryError,
  claimCorrectionImpactReview,
  completeCorrectionImpactReview,
  executeMemberCorrection,
  executeProviderCorrection,
  getCorrectionImpactReview,
  listCorrectionImpactReviews,
  listMemberVersions,
  listProviderVersions,
  requestAssessmentReassessment,
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

function reassessmentSource(c) {
  return `api:reassessment:${c.get("authContext")?.user_id || "unknown"}`;
}

function validateReassessmentIdempotencyKey(c) {
  const value = c.req.header("idempotency-key");
  if (typeof value !== "string" || !value.trim()) {
    return {
      ok: false,
      response: c.json({
        code: "MISSING_IDEMPOTENCY_KEY",
        message: "Idempotency-Key is required for an assessment reassessment request.",
      }, 400),
    };
  }
  const key = value.trim();
  if (key.length > 128) {
    return {
      ok: false,
      response: c.json({
        code: "INVALID_IDEMPOTENCY_KEY",
        message: "Idempotency-Key must be at most 128 characters.",
      }, 400),
    };
  }
  return { ok: true, key };
}

function validateCorrectionIdempotencyKey(c) {
  const value = c.req.header("idempotency-key");
  if (typeof value !== "string" || !value.trim()) {
    return {
      ok: false,
      response: c.json({
        code: "MISSING_IDEMPOTENCY_KEY",
        message: "Idempotency-Key is required for a correction request.",
      }, 400),
    };
  }
  const key = value.trim();
  if (key.length > 128) {
    return {
      ok: false,
      response: c.json({
        code: "INVALID_IDEMPOTENCY_KEY",
        message: "Idempotency-Key must be at most 128 characters.",
      }, 400),
    };
  }
  return { ok: true, key };
}

function positiveVersion(value, field) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    return { ok: false, code: `${field.toUpperCase()}_INVALID` };
  }
  return { ok: true, value: parsed };
}

function repositoryErrorResponse(c, error) {
  if (error instanceof AssessmentContextRepositoryError) {
    return c.json({ code: error.code, message: error.message, details: error.details ?? undefined }, error.status ?? 409);
  }
  return null;
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
  const requireMemberRead = createRequireOperationalRouteAuthorizationMiddleware({
    routeId: OPERATIONAL_ROUTE_IDS.MEMBER_VERSION_HISTORY,
  });
  const requireProviderRead = createRequireOperationalRouteAuthorizationMiddleware({
    routeId: OPERATIONAL_ROUTE_IDS.PROVIDER_VERSION_HISTORY,
  });
  const requireMemberCorrection = createRequireOperationalRouteAuthorizationMiddleware({
    routeId: OPERATIONAL_ROUTE_IDS.MEMBER_CORRECTION,
  });
  const requireProviderCorrection = createRequireOperationalRouteAuthorizationMiddleware({
    routeId: OPERATIONAL_ROUTE_IDS.PROVIDER_CORRECTION,
  });
  const requireReassessment = createRequireOperationalRouteAuthorizationMiddleware({
    routeId: OPERATIONAL_ROUTE_IDS.ASSESSMENT_REQUEST_REASSESSMENT,
  });
  const requireCorrectionReviewsList = createRequireOperationalRouteAuthorizationMiddleware({
    routeId: OPERATIONAL_ROUTE_IDS.CORRECTION_IMPACT_REVIEWS_LIST,
  });
  const requireCorrectionReviewRead = createRequireOperationalRouteAuthorizationMiddleware({
    routeId: OPERATIONAL_ROUTE_IDS.CORRECTION_IMPACT_REVIEW_READ,
  });
  const requireCorrectionReviewClaim = createRequireOperationalRouteAuthorizationMiddleware({
    routeId: OPERATIONAL_ROUTE_IDS.CORRECTION_IMPACT_REVIEW_CLAIM,
  });
  const requireCorrectionReviewComplete = createRequireOperationalRouteAuthorizationMiddleware({
    routeId: OPERATIONAL_ROUTE_IDS.CORRECTION_IMPACT_REVIEW_COMPLETE,
  });
  const requireTenantAccess = createRequireTenantAccessMiddleware({ tenantRepository });

  // GET /assessment/members/:memberId/versions
  app.get(
    "/assessment/members/:memberId/versions",
    requireMemberRead,
    requireTenantAccess,
    async (c) => {
      const pool = resolvePool();
      if (!pool) {
        return c.json({ code: "DATA_PLANE_UNAVAILABLE", message: "Operational data plane is not available." }, 503);
      }
      const tenantId = c.get("tenantContext")?.tenant_id;
      if (!tenantId) {
        return c.json({ code: "TENANT_CONTEXT_MISSING", message: "Tenant context could not be resolved." }, 403);
      }
      const memberId = c.req.param("memberId");
      const versions = await listMemberVersions(pool, { tenantId, memberId });
      if (!versions.length) {
        return c.json({ code: "MEMBER_NOT_FOUND", message: `Member ${memberId} was not found.` }, 404);
      }
      return c.json({ memberId, versions }, 200);
    },
  );

  // GET /assessment/providers/:providerId/versions
  app.get(
    "/assessment/providers/:providerId/versions",
    requireProviderRead,
    requireTenantAccess,
    async (c) => {
      const pool = resolvePool();
      if (!pool) {
        return c.json({ code: "DATA_PLANE_UNAVAILABLE", message: "Operational data plane is not available." }, 503);
      }
      const tenantId = c.get("tenantContext")?.tenant_id;
      if (!tenantId) {
        return c.json({ code: "TENANT_CONTEXT_MISSING", message: "Tenant context could not be resolved." }, 403);
      }
      const providerId = c.req.param("providerId");
      const versions = await listProviderVersions(pool, { tenantId, providerId });
      if (!versions.length) {
        return c.json({ code: "PROVIDER_NOT_FOUND", message: `Provider ${providerId} was not found.` }, 404);
      }
      return c.json({ providerId, versions }, 200);
    },
  );

  // POST /assessment/members/:memberId/correction
  app.post(
    "/assessment/members/:memberId/correction",
    requireMemberCorrection,
    requireTenantAccess,
    async (c) => {
      const tenantContext = c.get("tenantContext") || null;
      if (!tenantContext?.tenant_id) {
        return c.json({ code: "TENANT_CONTEXT_MISSING", message: "Tenant context could not be resolved." }, 403);
      }
      const tenantId = tenantContext.tenant_id;
      const memberId = c.req.param("memberId");
      const idempotency = validateCorrectionIdempotencyKey(c);
      if (!idempotency.ok) return idempotency.response;

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
      const expectedVersion = positiveVersion(body?.expected_version, "expected_version");
      if (!expectedVersion.ok) {
        return c.json({ code: expectedVersion.code, message: "expected_version must be a positive integer." }, 422);
      }

      const pool = resolvePool();
      if (!pool) {
        return c.json({ code: "DATA_PLANE_UNAVAILABLE", message: "Operational data plane is not available." }, 503);
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

        const result = await executeMemberCorrection(connection, {
          tenantId,
          member: { ...member, member_id: memberId },
          expectedVersion: expectedVersion.value,
          idempotencyKey: idempotency.key,
          actorId,
          reasonCode,
          reasonSummary,
          sourceReference,
          source,
          correlationId,
        });

        await connection.commit();

        return c.json({
          memberId,
          disposition: result.disposition,
          changed: result.changed,
          version: result.version,
          correctionEventId: result.correctionEventId,
          assessmentImpact: result.assessmentImpact,
          replacementAssessments: result.replacementAssessments,
          operationId: result.operationId,
          replayed: result.replayed,
        }, 200);
      } catch (error) {
        try { await connection?.rollback(); } catch { /* preserve original */ }
        const response = repositoryErrorResponse(c, error);
        if (response) return response;
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
      const tenantContext = c.get("tenantContext") || null;
      if (!tenantContext?.tenant_id) {
        return c.json({ code: "TENANT_CONTEXT_MISSING", message: "Tenant context could not be resolved." }, 403);
      }
      const tenantId = tenantContext.tenant_id;
      const providerId = c.req.param("providerId");
      const idempotency = validateCorrectionIdempotencyKey(c);
      if (!idempotency.ok) return idempotency.response;

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
      const expectedVersion = positiveVersion(body?.expected_version, "expected_version");
      if (!expectedVersion.ok) {
        return c.json({ code: expectedVersion.code, message: "expected_version must be a positive integer." }, 422);
      }

      const pool = resolvePool();
      if (!pool) {
        return c.json({ code: "DATA_PLANE_UNAVAILABLE", message: "Operational data plane is not available." }, 503);
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

        const result = await executeProviderCorrection(connection, {
          tenantId,
          provider: { ...provider, provider_id: providerId },
          expectedVersion: expectedVersion.value,
          idempotencyKey: idempotency.key,
          actorId,
          reasonCode,
          reasonSummary,
          sourceReference,
          source,
          correlationId,
        });

        await connection.commit();

        return c.json({
          providerId,
          disposition: result.disposition,
          changed: result.changed,
          version: result.version,
          correctionEventId: result.correctionEventId,
          assessmentImpact: result.assessmentImpact,
          replacementAssessments: result.replacementAssessments,
          operationId: result.operationId,
          replayed: result.replayed,
        }, 200);
      } catch (error) {
        try { await connection?.rollback(); } catch { /* preserve original */ }
        const response = repositoryErrorResponse(c, error);
        if (response) return response;
        throw error;
      } finally {
        connection?.release();
      }
    },
  );

  // GET /assessment/correction-impact-reviews
  app.get(
    "/assessment/correction-impact-reviews",
    requireCorrectionReviewsList,
    requireTenantAccess,
    async (c) => {
      const pool = resolvePool();
      if (!pool) {
        return c.json({ code: "DATA_PLANE_UNAVAILABLE", message: "Operational data plane is not available." }, 503);
      }
      const tenantId = c.get("tenantContext")?.tenant_id;
      if (!tenantId) {
        return c.json({ code: "TENANT_CONTEXT_MISSING", message: "Tenant context could not be resolved." }, 403);
      }
      try {
        const reviews = await listCorrectionImpactReviews(pool, {
          tenantId,
          status: c.req.query("status") || null,
          limit: c.req.query("limit") || 100,
        });
        return c.json({ reviews }, 200);
      } catch (error) {
        const response = repositoryErrorResponse(c, error);
        if (response) return response;
        throw error;
      }
    },
  );

  // GET /assessment/correction-impact-reviews/:reviewId
  app.get(
    "/assessment/correction-impact-reviews/:reviewId",
    requireCorrectionReviewRead,
    requireTenantAccess,
    async (c) => {
      const pool = resolvePool();
      if (!pool) {
        return c.json({ code: "DATA_PLANE_UNAVAILABLE", message: "Operational data plane is not available." }, 503);
      }
      const tenantId = c.get("tenantContext")?.tenant_id;
      if (!tenantId) {
        return c.json({ code: "TENANT_CONTEXT_MISSING", message: "Tenant context could not be resolved." }, 403);
      }
      try {
        const review = await getCorrectionImpactReview(pool, {
          tenantId,
          reviewId: c.req.param("reviewId"),
        });
        return c.json(review, 200);
      } catch (error) {
        const response = repositoryErrorResponse(c, error);
        if (response) return response;
        throw error;
      }
    },
  );

  // POST /assessment/correction-impact-reviews/:reviewId/claim
  app.post(
    "/assessment/correction-impact-reviews/:reviewId/claim",
    requireCorrectionReviewClaim,
    requireTenantAccess,
    async (c) => {
      let body;
      try {
        body = await c.req.json();
      } catch {
        return c.json({ code: "INVALID_JSON", message: "Request body must be valid JSON." }, 400);
      }
      const expected = positiveVersion(body?.expected_state_version, "expected_state_version");
      if (!expected.ok) {
        return c.json({ code: expected.code, message: "expected_state_version must be a positive integer." }, 422);
      }
      const pool = resolvePool();
      if (!pool) {
        return c.json({ code: "DATA_PLANE_UNAVAILABLE", message: "Operational data plane is not available." }, 503);
      }
      const tenantId = c.get("tenantContext")?.tenant_id;
      if (!tenantId) {
        return c.json({ code: "TENANT_CONTEXT_MISSING", message: "Tenant context could not be resolved." }, 403);
      }
      let connection;
      try {
        connection = await pool.getConnection();
        await connection.beginTransaction();
        const review = await claimCorrectionImpactReview(connection, {
          tenantId,
          reviewId: c.req.param("reviewId"),
          expectedStateVersion: expected.value,
          actorId: correctionActor(c),
        });
        await connection.commit();
        return c.json(review, 200);
      } catch (error) {
        try { await connection?.rollback(); } catch { /* preserve original */ }
        const response = repositoryErrorResponse(c, error);
        if (response) return response;
        throw error;
      } finally {
        connection?.release();
      }
    },
  );

  // POST /assessment/correction-impact-reviews/:reviewId/complete
  app.post(
    "/assessment/correction-impact-reviews/:reviewId/complete",
    requireCorrectionReviewComplete,
    requireTenantAccess,
    async (c) => {
      let body;
      try {
        body = await c.req.json();
      } catch {
        return c.json({ code: "INVALID_JSON", message: "Request body must be valid JSON." }, 400);
      }
      const expected = positiveVersion(body?.expected_state_version, "expected_state_version");
      if (!expected.ok) {
        return c.json({ code: expected.code, message: "expected_state_version must be a positive integer." }, 422);
      }
      const pool = resolvePool();
      if (!pool) {
        return c.json({ code: "DATA_PLANE_UNAVAILABLE", message: "Operational data plane is not available." }, 503);
      }
      const tenantId = c.get("tenantContext")?.tenant_id;
      if (!tenantId) {
        return c.json({ code: "TENANT_CONTEXT_MISSING", message: "Tenant context could not be resolved." }, 403);
      }
      let connection;
      try {
        connection = await pool.getConnection();
        await connection.beginTransaction();
        const review = await completeCorrectionImpactReview(connection, {
          tenantId,
          reviewId: c.req.param("reviewId"),
          expectedStateVersion: expected.value,
          actorId: correctionActor(c),
          reviewResult: body?.review_result,
        });
        await connection.commit();
        return c.json(review, 200);
      } catch (error) {
        try { await connection?.rollback(); } catch { /* preserve original */ }
        const response = repositoryErrorResponse(c, error);
        if (response) return response;
        throw error;
      } finally {
        connection?.release();
      }
    },
  );

  // POST /assessment/versions/:assessmentId/reassess
  app.post(
    "/assessment/versions/:assessmentId/reassess",
    requireReassessment,
    requireTenantAccess,
    async (c) => {
      const tenantContext = c.get("tenantContext") || null;
      if (!tenantContext?.tenant_id) {
        return c.json({ code: "TENANT_CONTEXT_MISSING", message: "Tenant context could not be resolved." }, 403);
      }
      const idempotency = validateReassessmentIdempotencyKey(c);
      if (!idempotency.ok) return idempotency.response;

      const pool = resolvePool();
      if (!pool) {
        return c.json({ code: "DATA_PLANE_UNAVAILABLE", message: "Operational data plane is not available." }, 503);
      }

      const tenantId = tenantContext.tenant_id;
      const sourceAssessmentId = c.req.param("assessmentId");
      const actorId = correctionActor(c);
      const source = reassessmentSource(c);
      const correlationId = correctionCorrelationId(c);

      let connection;
      try {
        connection = await pool.getConnection();
        await connection.beginTransaction();
        const result = await requestAssessmentReassessment(connection, {
          tenantId,
          sourceAssessmentId,
          idempotencyKey: idempotency.key,
          createdBy: actorId,
          source,
          correlationId,
        });
        await connection.commit();

        return c.json({
          sourceAssessmentId: result.sourceAssessmentId,
          assessmentId: result.assessmentId,
          jobId: result.jobId,
          status: result.status,
          replayed: result.replayed === true,
          correlationId,
        }, result.replayed ? 200 : 201);
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
           model_or_rule_version, feature_schema_version,
           reference_data_version, input_hash, assessment_reason,
           provenance_status, source_correction_event_id, supersedes_assessment_id,
           created_by, created_at
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

      const [supersessionRows] = await pool.execute(
        `SELECT supersession_id, superseded_signal_id, replacement_signal_id,
                replacement_assessment_id, correction_event_id,
                reason_code, reason_summary, correlation_id, created_by, created_at
           FROM detection_signal_supersessions
          WHERE tenant_id = ? AND previous_assessment_id = ?
          ORDER BY created_at ASC, supersession_id ASC`,
        [tenantId, assessmentId],
      );

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
        modelOrRuleVersion: row.model_or_rule_version,
        featureSchemaVersion: row.feature_schema_version,
        referenceDataVersion: row.reference_data_version,
        inputHash: row.input_hash,
        assessmentReason: row.assessment_reason,
        provenanceStatus: row.provenance_status,
        sourceCorrectionEventId: row.source_correction_event_id ?? null,
        supersedesAssessmentId: row.supersedes_assessment_id ?? null,
        createdBy: row.created_by,
        createdAt: row.created_at instanceof Date
          ? row.created_at.toISOString()
          : String(row.created_at),
        signalSupersessions: (supersessionRows || []).map((supersession) => ({
          supersessionId: supersession.supersession_id,
          supersededSignalId: supersession.superseded_signal_id,
          replacementSignalId: supersession.replacement_signal_id,
          replacementAssessmentId: supersession.replacement_assessment_id,
          correctionEventId: supersession.correction_event_id ?? null,
          reasonCode: supersession.reason_code,
          reasonSummary: supersession.reason_summary,
          correlationId: supersession.correlation_id,
          createdBy: supersession.created_by,
          createdAt: supersession.created_at instanceof Date
            ? supersession.created_at.toISOString()
            : String(supersession.created_at),
        })),
      }, 200);
    },
  );
}
