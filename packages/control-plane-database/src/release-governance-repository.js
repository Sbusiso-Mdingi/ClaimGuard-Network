import crypto from "node:crypto";

import {
  ControlPlaneConflictError,
  ControlPlaneNotFoundError,
  ControlPlaneValidationError,
} from "./errors.js";
import { executorOr } from "./transaction.js";

const COMMIT_SHA_PATTERN = /^[a-f0-9]{40}$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const REQUEST_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const OPEN_REQUEST_STATUSES = new Set(["pending_approval", "approved", "deploying"]);

function requiredText(value, field, maximum) {
  const rendered = String(value || "").trim();
  if (!rendered || rendered.length > maximum) {
    throw new ControlPlaneValidationError(
      `${field} is required and must not exceed ${maximum} characters.`,
      "INVALID_RELEASE_GOVERNANCE_INPUT",
    );
  }
  return rendered;
}

function exactPattern(value, field, pattern) {
  const rendered = requiredText(value, field, 128).toLowerCase();
  if (!pattern.test(rendered)) {
    throw new ControlPlaneValidationError(
      `${field} has an unsupported format.`,
      "INVALID_RELEASE_GOVERNANCE_INPUT",
    );
  }
  return rendered;
}

function safeUrl(value, field) {
  const rendered = requiredText(value, field, 2048);
  let parsed;
  try {
    parsed = new URL(rendered);
  } catch {
    throw new ControlPlaneValidationError(
      `${field} must be an HTTPS URL.`,
      "INVALID_RELEASE_GOVERNANCE_INPUT",
    );
  }
  if (parsed.protocol !== "https:") {
    throw new ControlPlaneValidationError(
      `${field} must be an HTTPS URL.`,
      "INVALID_RELEASE_GOVERNANCE_INPUT",
    );
  }
  return parsed.toString();
}

function timestamp(value, field) {
  const parsed = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new ControlPlaneValidationError(
      `${field} must be a valid timestamp.`,
      "INVALID_RELEASE_GOVERNANCE_INPUT",
    );
  }
  return parsed;
}

function mapRelease(row) {
  if (!row) return null;
  return {
    releaseId: row.release_id,
    commitSha: row.commit_sha,
    sourceRepository: row.source_repository,
    sourceBranch: row.source_branch,
    artifactDigest: row.artifact_digest,
    webArtifactDigest: row.web_artifact_digest,
    apiArtifactDigest: row.api_artifact_digest,
    artifactName: row.artifact_name,
    artifactWorkflowRunId: row.artifact_workflow_run_id,
    artifactWorkflowRunUrl: row.artifact_workflow_run_url,
    ciWorkflowRunId: row.ci_workflow_run_id,
    ciWorkflowRunUrl: row.ci_workflow_run_url,
    securityWorkflowRunId: row.security_workflow_run_id,
    securityWorkflowRunUrl: row.security_workflow_run_url,
    ciConclusion: row.ci_conclusion,
    securityConclusion: row.security_conclusion,
    eligibleAt: row.eligible_at,
    registeredBy: row.registered_by,
    createdAt: row.created_at,
  };
}

function mapPromotionRequest(row) {
  if (!row) return null;
  return {
    promotionRequestId: row.promotion_request_id,
    releaseId: row.release_id,
    commitSha: row.commit_sha || null,
    artifactDigest: row.artifact_digest || null,
    targetEnvironment: row.target_environment,
    status: row.status,
    requestReason: row.request_reason,
    requestedBy: row.requested_by,
    requestedAt: row.requested_at,
    requestReauthenticatedAt: row.request_reauthenticated_at,
    approvedBy: row.approved_by || null,
    approvedAt: row.approved_at || null,
    approvalReauthenticatedAt: row.approval_reauthenticated_at || null,
    rejectedBy: row.rejected_by || null,
    rejectedAt: row.rejected_at || null,
    rejectionReason: row.rejection_reason || null,
    deploymentWorkflowRunId: row.deployment_workflow_run_id || null,
    deploymentWorkflowRunUrl: row.deployment_workflow_run_url || null,
    deploymentStartedAt: row.deployment_started_at || null,
    completedAt: row.completed_at || null,
    failureSummary: row.failure_summary || null,
    bootstrapRequest: Boolean(row.bootstrap_request),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapDeployment(row) {
  if (!row) return null;
  return {
    deploymentRecordId: row.deployment_record_id,
    releaseId: row.release_id,
    promotionRequestId: row.promotion_request_id,
    targetEnvironment: row.target_environment,
    deploymentWorkflowRunId: row.deployment_workflow_run_id,
    deploymentWorkflowRunUrl: row.deployment_workflow_run_url,
    deployedAt: row.deployed_at,
    recordedBy: row.recorded_by,
    commitSha: row.commit_sha,
    artifactDigest: row.artifact_digest,
    webArtifactDigest: row.web_artifact_digest,
    apiArtifactDigest: row.api_artifact_digest,
    sourceRepository: row.source_repository,
  };
}

function sameRelease(existing, candidate) {
  return existing.commitSha === candidate.commitSha
    && existing.sourceRepository === candidate.sourceRepository
    && existing.sourceBranch === candidate.sourceBranch
    && existing.artifactDigest === candidate.artifactDigest
    && existing.webArtifactDigest === candidate.webArtifactDigest
    && existing.apiArtifactDigest === candidate.apiArtifactDigest
    && existing.artifactName === candidate.artifactName
    && String(existing.artifactWorkflowRunId) === String(candidate.artifactWorkflowRunId)
    && String(existing.ciWorkflowRunId) === String(candidate.ciWorkflowRunId)
    && String(existing.securityWorkflowRunId) === String(candidate.securityWorkflowRunId);
}

const REQUEST_SELECT = `
  SELECT pr.*, rc.commit_sha, rc.artifact_digest
  FROM platform_release_promotion_requests pr
  JOIN platform_release_candidates rc ON rc.release_id = pr.release_id
`;

export function createReleaseGovernanceRepository(defaultExecutor) {
  return {
    async registerEligibleRelease(input, { executor } = {}) {
      const db = executorOr(defaultExecutor, executor);
      const candidate = {
        releaseId: input.releaseId || crypto.randomUUID(),
        commitSha: exactPattern(input.commitSha, "commitSha", COMMIT_SHA_PATTERN),
        sourceRepository: requiredText(input.sourceRepository, "sourceRepository", 255),
        sourceBranch: requiredText(input.sourceBranch, "sourceBranch", 255),
        artifactDigest: exactPattern(input.artifactDigest, "artifactDigest", SHA256_PATTERN),
        webArtifactDigest: exactPattern(input.webArtifactDigest, "webArtifactDigest", SHA256_PATTERN),
        apiArtifactDigest: exactPattern(input.apiArtifactDigest, "apiArtifactDigest", SHA256_PATTERN),
        artifactName: requiredText(input.artifactName, "artifactName", 255),
        artifactWorkflowRunId: requiredText(input.artifactWorkflowRunId, "artifactWorkflowRunId", 64),
        artifactWorkflowRunUrl: safeUrl(input.artifactWorkflowRunUrl, "artifactWorkflowRunUrl"),
        ciWorkflowRunId: requiredText(input.ciWorkflowRunId, "ciWorkflowRunId", 64),
        ciWorkflowRunUrl: safeUrl(input.ciWorkflowRunUrl, "ciWorkflowRunUrl"),
        securityWorkflowRunId: requiredText(input.securityWorkflowRunId, "securityWorkflowRunId", 64),
        securityWorkflowRunUrl: safeUrl(input.securityWorkflowRunUrl, "securityWorkflowRunUrl"),
        ciConclusion: String(input.ciConclusion || "").trim().toLowerCase(),
        securityConclusion: String(input.securityConclusion || "").trim().toLowerCase(),
        eligibleAt: timestamp(input.eligibleAt || new Date(), "eligibleAt"),
        registeredBy: requiredText(input.registeredBy, "registeredBy", 255),
      };
      if (candidate.ciConclusion !== "success" || candidate.securityConclusion !== "success") {
        throw new ControlPlaneValidationError(
          "A release is eligible only after both CI and security gates succeed.",
          "RELEASE_GATES_INCOMPLETE",
        );
      }

      const existing = await this.getReleaseByCommit(candidate.commitSha, { executor: db });
      if (existing) {
        if (!sameRelease(existing, candidate)) {
          throw new ControlPlaneConflictError(
            "The commit is already registered with different immutable release metadata.",
            "RELEASE_IMMUTABILITY_CONFLICT",
          );
        }
        return existing;
      }

      await db.execute(
        `INSERT INTO platform_release_candidates
          (release_id, commit_sha, source_repository, source_branch, artifact_digest,
           web_artifact_digest, api_artifact_digest, artifact_name,
           artifact_workflow_run_id, artifact_workflow_run_url,
           ci_workflow_run_id, ci_workflow_run_url,
           security_workflow_run_id, security_workflow_run_url,
           ci_conclusion, security_conclusion, eligible_at, registered_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          candidate.releaseId,
          candidate.commitSha,
          candidate.sourceRepository,
          candidate.sourceBranch,
          candidate.artifactDigest,
          candidate.webArtifactDigest,
          candidate.apiArtifactDigest,
          candidate.artifactName,
          candidate.artifactWorkflowRunId,
          candidate.artifactWorkflowRunUrl,
          candidate.ciWorkflowRunId,
          candidate.ciWorkflowRunUrl,
          candidate.securityWorkflowRunId,
          candidate.securityWorkflowRunUrl,
          candidate.ciConclusion,
          candidate.securityConclusion,
          candidate.eligibleAt,
          candidate.registeredBy,
        ],
      );
      return this.getReleaseByCommit(candidate.commitSha, { executor: db });
    },

    async getReleaseByCommit(commitSha, { executor } = {}) {
      const canonical = exactPattern(commitSha, "commitSha", COMMIT_SHA_PATTERN);
      const [rows] = await executorOr(defaultExecutor, executor).execute(
        "SELECT * FROM platform_release_candidates WHERE commit_sha = ? LIMIT 1",
        [canonical],
      );
      return mapRelease(rows?.[0]);
    },

    async getReleaseById(releaseId, { executor } = {}) {
      const [rows] = await executorOr(defaultExecutor, executor).execute(
        "SELECT * FROM platform_release_candidates WHERE release_id = ? LIMIT 1",
        [requiredText(releaseId, "releaseId", 36)],
      );
      return mapRelease(rows?.[0]);
    },

    async listEligibleReleases({ limit = 20 } = {}, { executor } = {}) {
      const bounded = Math.max(1, Math.min(50, Number(limit) || 20));
      const [rows] = await executorOr(defaultExecutor, executor).execute(
        `SELECT * FROM platform_release_candidates
         ORDER BY eligible_at DESC, created_at DESC
         LIMIT ${bounded}`,
      );
      return (rows || []).map(mapRelease);
    },

    async listPromotionRequests({ limit = 30 } = {}, { executor } = {}) {
      const bounded = Math.max(1, Math.min(100, Number(limit) || 30));
      const [rows] = await executorOr(defaultExecutor, executor).execute(
        `${REQUEST_SELECT}
         ORDER BY pr.requested_at DESC, pr.created_at DESC
         LIMIT ${bounded}`,
      );
      return (rows || []).map(mapPromotionRequest);
    },

    async getPromotionRequest(promotionRequestId, { forUpdate = false, executor } = {}) {
      const canonical = requiredText(promotionRequestId, "promotionRequestId", 36);
      if (!REQUEST_ID_PATTERN.test(canonical)) {
        throw new ControlPlaneValidationError(
          "promotionRequestId has an unsupported format.",
          "INVALID_RELEASE_GOVERNANCE_INPUT",
        );
      }
      const [rows] = await executorOr(defaultExecutor, executor).execute(
        `${REQUEST_SELECT}
         WHERE pr.promotion_request_id = ?
         LIMIT 1${forUpdate ? " FOR UPDATE" : ""}`,
        [canonical],
      );
      return mapPromotionRequest(rows?.[0]);
    },

    async createPromotionRequest(input, { executor } = {}) {
      const db = executorOr(defaultExecutor, executor);
      const release = await this.getReleaseById(input.releaseId, { executor: db });
      if (!release) {
        throw new ControlPlaneNotFoundError(
          "The eligible release was not found.",
          "RELEASE_NOT_FOUND",
        );
      }
      const current = await this.getCurrentDeployment("production", { executor: db });
      if (current?.releaseId === release.releaseId) {
        throw new ControlPlaneConflictError(
          "The selected release is already deployed to production.",
          "RELEASE_ALREADY_DEPLOYED",
        );
      }
      const promotionRequestId = input.promotionRequestId || crypto.randomUUID();
      const requestedAt = timestamp(input.requestedAt || new Date(), "requestedAt");
      await db.execute(
        `INSERT INTO platform_release_promotion_requests
          (promotion_request_id, release_id, target_environment, status,
           request_reason, requested_by, requested_at, request_reauthenticated_at)
         VALUES (?, ?, 'production', 'pending_approval', ?, ?, ?, ?)`,
        [
          promotionRequestId,
          release.releaseId,
          requiredText(input.requestReason, "requestReason", 512),
          requiredText(input.requestedBy, "requestedBy", 255),
          requestedAt,
          timestamp(input.requestReauthenticatedAt, "requestReauthenticatedAt"),
        ],
      );
      return this.getPromotionRequest(promotionRequestId, { executor: db });
    },

    async approvePromotionRequest(input, { executor } = {}) {
      const db = executorOr(defaultExecutor, executor);
      const request = await this.getPromotionRequest(input.promotionRequestId, {
        forUpdate: true,
        executor: db,
      });
      if (!request) {
        throw new ControlPlaneNotFoundError(
          "The promotion request was not found.",
          "PROMOTION_REQUEST_NOT_FOUND",
        );
      }
      if (request.status !== "pending_approval") {
        throw new ControlPlaneConflictError(
          "Only a pending promotion request can be approved.",
          "PROMOTION_REQUEST_NOT_PENDING",
        );
      }
      const approvedBy = requiredText(input.approvedBy, "approvedBy", 255);
      if (approvedBy === request.requestedBy) {
        throw new ControlPlaneConflictError(
          "Production promotion requires approval by a different platform administrator.",
          "SECOND_APPROVER_REQUIRED",
        );
      }
      const approvedAt = timestamp(input.approvedAt || new Date(), "approvedAt");
      await db.execute(
        `UPDATE platform_release_promotion_requests
         SET status = 'approved', approved_by = ?, approved_at = ?,
             approval_reauthenticated_at = ?
         WHERE promotion_request_id = ? AND status = 'pending_approval'`,
        [
          approvedBy,
          approvedAt,
          timestamp(input.approvalReauthenticatedAt, "approvalReauthenticatedAt"),
          request.promotionRequestId,
        ],
      );
      return this.getPromotionRequest(request.promotionRequestId, { executor: db });
    },

    async rejectPromotionRequest(input, { executor } = {}) {
      const db = executorOr(defaultExecutor, executor);
      const request = await this.getPromotionRequest(input.promotionRequestId, {
        forUpdate: true,
        executor: db,
      });
      if (!request) {
        throw new ControlPlaneNotFoundError(
          "The promotion request was not found.",
          "PROMOTION_REQUEST_NOT_FOUND",
        );
      }
      if (!OPEN_REQUEST_STATUSES.has(request.status) || request.status === "deploying") {
        throw new ControlPlaneConflictError(
          "The promotion request can no longer be rejected.",
          "PROMOTION_REQUEST_NOT_REJECTABLE",
        );
      }
      const rejectedAt = timestamp(input.rejectedAt || new Date(), "rejectedAt");
      await db.execute(
        `UPDATE platform_release_promotion_requests
         SET status = 'rejected', rejected_by = ?, rejected_at = ?, rejection_reason = ?
         WHERE promotion_request_id = ? AND status IN ('pending_approval', 'approved')`,
        [
          requiredText(input.rejectedBy, "rejectedBy", 255),
          rejectedAt,
          requiredText(input.rejectionReason, "rejectionReason", 512),
          request.promotionRequestId,
        ],
      );
      return this.getPromotionRequest(request.promotionRequestId, { executor: db });
    },

    async getCurrentDeployment(targetEnvironment = "production", { executor } = {}) {
      const [rows] = await executorOr(defaultExecutor, executor).execute(
        `SELECT d.*, rc.commit_sha, rc.artifact_digest, rc.web_artifact_digest,
                rc.api_artifact_digest, rc.source_repository
         FROM platform_release_deployments d
         JOIN platform_release_candidates rc ON rc.release_id = d.release_id
         WHERE d.target_environment = ?
         ORDER BY d.deployed_at DESC, d.created_at DESC
         LIMIT 1`,
        [requiredText(targetEnvironment, "targetEnvironment", 32)],
      );
      return mapDeployment(rows?.[0]);
    },

    async getDeploymentByPromotionRequest(promotionRequestId, { executor } = {}) {
      const canonical = requiredText(
        promotionRequestId,
        "promotionRequestId",
        36,
      );
      if (!REQUEST_ID_PATTERN.test(canonical)) {
        throw new ControlPlaneValidationError(
          "promotionRequestId has an unsupported format.",
          "INVALID_RELEASE_GOVERNANCE_INPUT",
        );
      }
      const [rows] = await executorOr(defaultExecutor, executor).execute(
        `SELECT d.*, rc.commit_sha, rc.artifact_digest, rc.web_artifact_digest,
                rc.api_artifact_digest, rc.source_repository
         FROM platform_release_deployments d
         JOIN platform_release_candidates rc ON rc.release_id = d.release_id
         WHERE d.promotion_request_id = ?
         LIMIT 1`,
        [canonical],
      );
      return mapDeployment(rows?.[0]);
    },

    async authorizePromotionDeployment(input, { executor } = {}) {
      const db = executorOr(defaultExecutor, executor);
      const request = await this.getPromotionRequest(input.promotionRequestId, {
        forUpdate: true,
        executor: db,
      });
      if (!request) {
        throw new ControlPlaneNotFoundError(
          "The promotion request was not found.",
          "PROMOTION_REQUEST_NOT_FOUND",
        );
      }
      if (request.status !== "approved") {
        throw new ControlPlaneConflictError(
          "The promotion request is not approved for deployment.",
          "PROMOTION_REQUEST_NOT_APPROVED",
        );
      }
      const release = await this.getReleaseById(request.releaseId, { executor: db });
      const expectedCommit = exactPattern(input.commitSha, "commitSha", COMMIT_SHA_PATTERN);
      if (release.commitSha !== expectedCommit) {
        throw new ControlPlaneConflictError(
          "The approved release does not match the workflow commit.",
          "PROMOTION_COMMIT_MISMATCH",
        );
      }
      const workflowRunId = requiredText(
        input.deploymentWorkflowRunId,
        "deploymentWorkflowRunId",
        64,
      );
      const workflowRunUrl = safeUrl(
        input.deploymentWorkflowRunUrl,
        "deploymentWorkflowRunUrl",
      );
      const startedAt = timestamp(
        input.deploymentStartedAt || new Date(),
        "deploymentStartedAt",
      );
      await db.execute(
        `UPDATE platform_release_promotion_requests
         SET status = 'deploying', deployment_workflow_run_id = ?,
             deployment_workflow_run_url = ?, deployment_started_at = ?
         WHERE promotion_request_id = ? AND status = 'approved'`,
        [
          workflowRunId,
          workflowRunUrl,
          startedAt,
          request.promotionRequestId,
        ],
      );
      return {
        request: await this.getPromotionRequest(request.promotionRequestId, {
          executor: db,
        }),
        release,
      };
    },

    async createBootstrapDeploymentRequest(input, { executor } = {}) {
      const db = executorOr(defaultExecutor, executor);
      const [deploymentRows] = await db.execute(
        "SELECT deployment_record_id FROM platform_release_deployments LIMIT 1 FOR UPDATE",
      );
      const [requestRows] = await db.execute(
        "SELECT promotion_request_id FROM platform_release_promotion_requests LIMIT 1 FOR UPDATE",
      );
      if ((deploymentRows || []).length > 0 || (requestRows || []).length > 0) {
        throw new ControlPlaneConflictError(
          "Release governance is already initialised; bootstrap cannot be repeated.",
          "RELEASE_GOVERNANCE_ALREADY_INITIALISED",
        );
      }
      const release = await this.getReleaseById(input.releaseId, { executor: db });
      if (!release) {
        throw new ControlPlaneNotFoundError(
          "The bootstrap release was not found.",
          "RELEASE_NOT_FOUND",
        );
      }
      const promotionRequestId = input.promotionRequestId || crypto.randomUUID();
      const actor = requiredText(input.actor, "actor", 255);
      const startedAt = timestamp(
        input.deploymentStartedAt || new Date(),
        "deploymentStartedAt",
      );
      await db.execute(
        `INSERT INTO platform_release_promotion_requests
          (promotion_request_id, release_id, target_environment, status,
           request_reason, requested_by, requested_at, request_reauthenticated_at,
           approved_by, approved_at, approval_reauthenticated_at,
           deployment_workflow_run_id, deployment_workflow_run_url,
           deployment_started_at, bootstrap_request)
         VALUES (?, ?, 'production', 'deploying', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
        [
          promotionRequestId,
          release.releaseId,
          "One-time release-governance bootstrap from the previously authorised deployment boundary.",
          actor,
          startedAt,
          startedAt,
          actor,
          startedAt,
          startedAt,
          requiredText(input.deploymentWorkflowRunId, "deploymentWorkflowRunId", 64),
          safeUrl(input.deploymentWorkflowRunUrl, "deploymentWorkflowRunUrl"),
          startedAt,
        ],
      );
      return {
        request: await this.getPromotionRequest(promotionRequestId, { executor: db }),
        release,
      };
    },

    async completePromotionDeployment(input, { executor } = {}) {
      const db = executorOr(defaultExecutor, executor);
      const request = await this.getPromotionRequest(input.promotionRequestId, {
        forUpdate: true,
        executor: db,
      });
      if (!request) {
        throw new ControlPlaneNotFoundError(
          "The promotion request was not found.",
          "PROMOTION_REQUEST_NOT_FOUND",
        );
      }
      if (request.status === "deployed") {
        return {
          request,
          deployment: await this.getDeploymentByPromotionRequest(
            request.promotionRequestId,
            { executor: db },
          ),
        };
      }
      if (request.status !== "deploying") {
        throw new ControlPlaneConflictError(
          "Only a deploying promotion request can be completed.",
          "PROMOTION_REQUEST_NOT_DEPLOYING",
        );
      }
      const deployedAt = timestamp(input.deployedAt || new Date(), "deployedAt");
      const deploymentRecordId = input.deploymentRecordId || crypto.randomUUID();
      await db.execute(
        `INSERT INTO platform_release_deployments
          (deployment_record_id, release_id, promotion_request_id,
           target_environment, deployment_workflow_run_id,
           deployment_workflow_run_url, deployed_at, recorded_by)
         VALUES (?, ?, ?, 'production', ?, ?, ?, ?)`,
        [
          deploymentRecordId,
          request.releaseId,
          request.promotionRequestId,
          request.deploymentWorkflowRunId,
          request.deploymentWorkflowRunUrl,
          deployedAt,
          requiredText(input.recordedBy, "recordedBy", 255),
        ],
      );
      await db.execute(
        `UPDATE platform_release_promotion_requests
         SET status = 'deployed', completed_at = ?, failure_summary = NULL
         WHERE promotion_request_id = ? AND status = 'deploying'`,
        [deployedAt, request.promotionRequestId],
      );
      return {
        request: await this.getPromotionRequest(request.promotionRequestId, {
          executor: db,
        }),
        deployment: await this.getDeploymentByPromotionRequest(
          request.promotionRequestId,
          { executor: db },
        ),
      };
    },

    async failPromotionDeployment(input, { executor } = {}) {
      const db = executorOr(defaultExecutor, executor);
      const request = await this.getPromotionRequest(input.promotionRequestId, {
        forUpdate: true,
        executor: db,
      });
      if (!request) {
        throw new ControlPlaneNotFoundError(
          "The promotion request was not found.",
          "PROMOTION_REQUEST_NOT_FOUND",
        );
      }
      if (request.status === "failed") return request;
      if (request.status !== "deploying") {
        throw new ControlPlaneConflictError(
          "Only a deploying promotion request can be marked failed.",
          "PROMOTION_REQUEST_NOT_DEPLOYING",
        );
      }
      await db.execute(
        `UPDATE platform_release_promotion_requests
         SET status = 'failed', completed_at = ?, failure_summary = ?
         WHERE promotion_request_id = ? AND status = 'deploying'`,
        [
          timestamp(input.completedAt || new Date(), "completedAt"),
          requiredText(input.failureSummary, "failureSummary", 512),
          request.promotionRequestId,
        ],
      );
      return this.getPromotionRequest(request.promotionRequestId, { executor: db });
    },
  };
}
