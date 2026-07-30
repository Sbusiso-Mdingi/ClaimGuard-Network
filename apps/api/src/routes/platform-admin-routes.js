import {
  triggerProvisioningJob,
} from "../azure-provisioning-job-trigger.js";

import {
  createRequirePermissionMiddleware,
} from "../middleware/authorization-middleware.js";
import { CLAIMGUARD_PERMISSIONS } from "../authorization-policy.js";

function actorFromContext(c) {
  const auth = c.get("authContext") || {};
  return {
    type: "user",
    id: auth.user_id || null,
    source: "platform-admin-api",
    correlationId: c.get("requestId") || null,
  };
}

function promotionRequestConfirmation(commitSha) {
  return `PROMOTE ${String(commitSha || "").slice(0, 12)} TO PRODUCTION`;
}

function promotionApprovalConfirmation(promotionRequestId) {
  return `APPROVE ${String(promotionRequestId || "").slice(0, 8)}`;
}

function normalizePlatformAdministratorEmail(value) {
  return String(value || "").trim().toLowerCase();
}

function platformAdministratorInvitationConfirmation(email) {
  return `INVITE ${normalizePlatformAdministratorEmail(email)} AS PLATFORM ADMINISTRATOR`;
}

function platformAdministratorRevocationConfirmation(invitationId) {
  return `REVOKE ${String(invitationId || "").slice(0, 8)}`;
}

function platformAdministratorAccessError(c, error, fallback) {
  const duplicate = error?.code === "ER_DUP_ENTRY";
  const status = duplicate
    ? 409
    : Number.isInteger(error?.status)
      ? error.status
      : 500;
  return c.json({
    available: false,
    code: duplicate
      ? "PLATFORM_ADMINISTRATOR_INVITATION_ALREADY_OPEN"
      : error?.code || "PLATFORM_ADMINISTRATOR_ACCESS_OPERATION_FAILED",
    message: duplicate
      ? "A pending platform administrator invitation already exists for this email."
      : Number.isInteger(error?.status)
        ? error.message
        : fallback,
  }, status);
}

function releaseGovernanceError(c, error, fallback) {
  const duplicate = error?.code === "ER_DUP_ENTRY";
  return c.json({
    available: false,
    code: duplicate
      ? "RELEASE_PROMOTION_ALREADY_OPEN"
      : error?.code || "RELEASE_GOVERNANCE_OPERATION_FAILED",
    message: duplicate
      ? "An open promotion request already exists for this release."
      : error?.message || fallback,
  }, duplicate ? 409 : Number.isInteger(error?.status) ? error.status : 400);
}

function parseAllowedDeploymentClasses(defaultDeploymentClass) {
  return new Set(
    String(
      process.env.PLATFORM_ALLOWED_DEPLOYMENT_CLASSES
      || defaultDeploymentClass
      || "production",
    )
      .split(",")
      .map((value) => value.trim().toLowerCase())
      .filter(Boolean),
  );
}

function configuredModelDeploymentIds() {
  return new Set(
    String(process.env.APPROVED_MODEL_DEPLOYMENT_IDS || "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean),
  );
}

function configuredClaimGuardRelease() {
  return {
    deploymentId: String(
      process.env.CLAIMGUARD_RELEASE_CANDIDATE_DEPLOYMENT_ID || "",
    ).trim(),
    artifactSha256: String(
      process.env.CLAIMGUARD_RELEASE_CANDIDATE_ARTIFACT_SHA256 || "",
    ).trim().toLowerCase(),
    candidateImageDigest: String(
      process.env.CLAIMGUARD_RELEASE_CANDIDATE_IMAGE_DIGEST || "",
    ).trim().toLowerCase(),
    releaseImageDigest: String(
      process.env.CLAIMGUARD_RELEASE_IMAGE_DIGEST || "",
    ).trim().toLowerCase(),
  };
}

function projectDeploymentRuntimeState(model, approvedIds, managedId) {
  return {
    ...model,
    runtimeApproved: approvedIds.has(model.deploymentId),
    fleetManaged: model.deploymentId === managedId,
  };
}

function safeProvisioningProjection(operation) {
  return {
    operationId: operation.operationId,
    organisationId: operation.organisationId,
    operationType: operation.operationType,
    status: operation.status,
    requestedBy: operation.requestedBy,
    correlationId: operation.correlationId,
    startedAt: operation.startedAt,
    completedAt: operation.completedAt,
    safeErrorSummary: operation.safeErrorSummary,
    steps: (operation.steps || []).map((step) => ({
      stepKey: step.stepKey,
      status: step.status,
      attemptCount: step.attemptCount,
      startedAt: step.startedAt,
      completedAt: step.completedAt,
      safeErrorSummary: step.safeErrorSummary,
      errorType: step.errorType,
      compensationStatus: step.compensationStatus,
      externalResourceReference: step.externalResourceReference,
    })),
  };
}

function deriveProvisioningReview({ organisation, azurePolicy, databaseName }) {
  return {
    region: azurePolicy.region,
    flexibleServerName: azurePolicy.mysqlServerName,
    generatedLogicalDatabaseName: databaseName,
    reportPartitionStrategy: azurePolicy.reportPartitionStrategy,
    schemaVersion: azurePolicy.privateSchemaVersion,
    organisationId: organisation.organisationId,
  };
}

function approvedAzurePolicy({ organisationId, canonicalSlug, deploymentClass }) {
  const subscriptionId = process.env.AZURE_APPROVED_SUBSCRIPTION_ID || process.env.AZURE_SUBSCRIPTION_ID || null;
  const resourceGroup = process.env.AZURE_APPROVED_RESOURCE_GROUP || "ClaimGuard";
  const mysqlServerName = process.env.AZURE_APPROVED_MYSQL_SERVER || "claimguard";
  const keyVaultName = process.env.AZURE_APPROVED_KEYVAULT || "claimguard-kv-ufs";
  const storageAccountName = process.env.AZURE_APPROVED_STORAGE_ACCOUNT || "cgrpt0715sa";
  const region = process.env.AZURE_APPROVED_REGION || "southafricanorth";
  const reportContainer = process.env.AZURE_APPROVED_REPORT_CONTAINER || "claimguard-reports";
  const reportPartitionStrategy = process.env.REPORT_PARTITION_STRATEGY || "prefix";
  const privateSchemaVersion = process.env.PRIVATE_TENANT_SCHEMA_VERSION || "14";
  const safeSlug = String(canonicalSlug || "").replace(/[^a-zA-Z0-9]+/g, "_").replace(/^_+|_+$/g, "").toLowerCase().slice(0, 40) || "tenant";
  return {
    subscriptionId,
    resourceGroup,
    mysqlServerName,
    keyVaultName,
    storageAccountName,
    region,
    reportContainer,
    reportPartitionStrategy,
    privateSchemaVersion,
    logicalDatabaseIdentifier: `private:${organisationId}`,
    generatedDatabaseName: `claimguard_tenant_${safeSlug}`,
    deploymentClass,
  };
}

function integrationGuide(c, organisation) {
  const configuredBaseUrl = String(process.env.PUBLIC_API_BASE_URL || "").trim().replace(/\/$/, "");
  const apiBaseUrl = configuredBaseUrl || new URL(c.req.url).origin;
  return {
    organisationId: organisation.organisationId,
    organisationName: organisation.displayName,
    endpoint: `${apiBaseUrl}/claims/ingest`,
    method: "POST",
    authentication: "Bearer token",
    requiredHeaders: ["Authorization: Bearer <token>", "Content-Type: application/json", "x-request-id: <unique-id>"],
    successStatus: 202,
    retryPolicy: {
      retry: ["connection failure", "HTTP 500-599"],
      quarantine: [400, 409, 413, 415, 422],
      preserveBatchOnRetry: true,
    },
    steps: [
      "Create a claims-server credential after activation and copy its token once into the medical aid's secret store.",
      "Map stable scheme, member, provider, and claim identifiers to the ClaimGuard ingestion contract.",
      "Send bounded JSON batches over HTTPS and include a unique request ID for tracing.",
      "Treat only HTTP 202 as committed; retry transient failures with exponential backoff and quarantine rejected batches.",
      "Rotate or revoke the claims-server credential from ClaimGuard without changing Azure resources.",
    ],
  };
}

async function attemptProvisioningWorkerStart(
  {
    startProvisioningJob,
    operation,
    organisationId,
  },
) {
  try {
    return await startProvisioningJob(
      {
        operationId:
          operation.operationId,

        organisationId,
      },
    );
  } catch (
    error
  ) {
    console.error(
      JSON.stringify(
        {
          timestamp:
            new Date().toISOString(),

          level:
            "error",

          service:
            "api",

          event:
            "provisioning_worker_trigger_failed",

          operationId:
            operation.operationId,

          organisationId,

          failureType:
            error?.name
            || "Error",

          failureCode:
            error?.code
            || "PROVISIONING_JOB_TRIGGER_FAILED",

          failureStatus:
            error?.status
            || null,
        },
      ),
    );

    return {
      status:
        "failed",

      code:
        error?.code
        || "PROVISIONING_JOB_TRIGGER_FAILED",
    };
  }
}

export function registerPlatformAdminRoutes(
  app,
  {
    controlPlaneRepositories,
    controlPlaneService,
    authenticationService = null,
    deploymentClass = "production",
    startProvisioningJob =
      triggerProvisioningJob,
  } = {},
) {
  const requirePlatformAdmin = createRequirePermissionMiddleware({
    permission: CLAIMGUARD_PERMISSIONS.TENANTS_MANAGE,
  });
  const requireReleaseView = createRequirePermissionMiddleware({
    permission: CLAIMGUARD_PERMISSIONS.PLATFORM_RELEASES_VIEW,
  });
  const requireReleaseRequest = createRequirePermissionMiddleware({
    permission: CLAIMGUARD_PERMISSIONS.PLATFORM_RELEASES_REQUEST,
  });
  const requireReleaseApproval = createRequirePermissionMiddleware({
    permission: CLAIMGUARD_PERMISSIONS.PLATFORM_RELEASES_APPROVE,
  });
  const requirePlatformAdministratorManage = createRequirePermissionMiddleware({
    permission: CLAIMGUARD_PERMISSIONS.PLATFORM_ADMINISTRATORS_MANAGE,
  });
  const allowedDeploymentClasses = parseAllowedDeploymentClasses(
    deploymentClass,
  );

  app.get("/admin/platform/releases", requireReleaseView, async (c) => {
    const repository = controlPlaneRepositories?.releaseGovernance;
    if (
      !repository?.listEligibleReleases
      || !repository?.listPromotionRequests
      || !repository?.getCurrentDeployment
    ) {
      return c.json({
        available: false,
        code: "RELEASE_GOVERNANCE_NOT_CONFIGURED",
        message: "Release governance is not configured.",
      }, 503);
    }
    const auth = c.get("authContext") || {};
    const [currentDeployment, releases, promotionRequests] = await Promise.all([
      repository.getCurrentDeployment("production"),
      repository.listEligibleReleases({ limit: 20 }),
      repository.listPromotionRequests({ limit: 30 }),
    ]);
    const currentReleaseId = currentDeployment?.releaseId || null;
    const openReleaseIds = new Set(
      promotionRequests
        .filter((request) =>
          ["pending_approval", "approved", "deploying"].includes(request.status))
        .map((request) => request.releaseId),
    );
    return c.json({
      available: true,
      actor: {
        userId: auth.user_id || null,
        canRequest: auth.permissions?.has(
          CLAIMGUARD_PERMISSIONS.PLATFORM_RELEASES_REQUEST,
        ) || false,
        canApprove: auth.permissions?.has(
          CLAIMGUARD_PERMISSIONS.PLATFORM_RELEASES_APPROVE,
        ) || false,
      },
      policy: {
        targetEnvironment: "production",
        reauthenticationRequired: true,
        distinctSecondApproverRequired: true,
        deploymentExecution: "github_actions",
      },
      currentDeployment,
      releases: releases.map((release) => ({
        ...release,
        current: release.releaseId === currentReleaseId,
        promotionOpen: openReleaseIds.has(release.releaseId),
        requestConfirmation: promotionRequestConfirmation(release.commitSha),
      })),
      promotionRequests: promotionRequests.map((request) => ({
        ...request,
        approvalConfirmation: promotionApprovalConfirmation(
          request.promotionRequestId,
        ),
      })),
    });
  });

  app.post(
    "/admin/platform/releases/:releaseId/promotion-requests",
    requireReleaseRequest,
    async (c) => {
      const repository = controlPlaneRepositories?.releaseGovernance;
      const runInTransaction = controlPlaneRepositories?.runInTransaction;
      if (
        !repository?.getReleaseById
        || typeof runInTransaction !== "function"
        || typeof authenticationService?.reauthenticate !== "function"
      ) {
        return c.json({
          available: false,
          code: "RELEASE_GOVERNANCE_NOT_CONFIGURED",
          message: "Audited release promotion is not configured.",
        }, 503);
      }
      const payload = await c.req.json().catch(() => ({}));
      const permittedKeys = new Set(["password", "confirmation", "reason"]);
      if (Object.keys(payload).some((key) => !permittedKeys.has(key))) {
        return c.json({
          available: false,
          code: "RELEASE_PROMOTION_INPUT_INVALID",
          message: "The promotion request contains unsupported fields.",
        }, 400);
      }
      try {
        const release = await repository.getReleaseById(c.req.param("releaseId"));
        if (!release) {
          return c.json({
            available: false,
            code: "RELEASE_NOT_FOUND",
            message: "The eligible release was not found.",
          }, 404);
        }
        if (payload.confirmation !== promotionRequestConfirmation(release.commitSha)) {
          return c.json({
            available: false,
            code: "RELEASE_PROMOTION_CONFIRMATION_MISMATCH",
            message: "The production confirmation does not match the selected release.",
          }, 400);
        }
        const actor = actorFromContext(c);
        const stepUp = await authenticationService.reauthenticate(
          c.get("resolvedSession"),
          payload.password,
          c.get("authenticationMetadata") || {},
        );
        const result = await runInTransaction(async (repositories) => {
          const request = await repositories.releaseGovernance
            .createPromotionRequest({
              releaseId: release.releaseId,
              requestReason: payload.reason,
              requestedBy: actor.id,
              requestedAt: new Date(),
              requestReauthenticatedAt: stepUp.reauthenticatedAt,
            });
          const audit = await repositories.security.recordPlatformAudit({
            actorType: actor.type,
            actorId: actor.id,
            organisationScopeId: null,
            action: "platform_release.request_promotion",
            targetType: "platform_release",
            targetId: release.releaseId,
            beforeSummary: null,
            afterSummary: {
              promotionRequestId: request.promotionRequestId,
              commitSha: release.commitSha,
              artifactDigest: release.artifactDigest,
              targetEnvironment: "production",
              status: request.status,
              reauthenticated: true,
            },
            correlationId: actor.correlationId,
            outcome: "success",
            source: actor.source,
          });
          return { request, audit };
        });
        return c.json({
          available: true,
          promotionRequest: {
            ...result.request,
            approvalConfirmation: promotionApprovalConfirmation(
              result.request.promotionRequestId,
            ),
          },
          auditEventId: result.audit.auditEventId,
          message: "Promotion requested. A different platform administrator must approve it before deployment.",
        }, 201);
      } catch (error) {
        return releaseGovernanceError(
          c,
          error,
          "The release promotion request could not be recorded.",
        );
      }
    },
  );

  app.post(
    "/admin/platform/promotion-requests/:promotionRequestId/approve",
    requireReleaseApproval,
    async (c) => {
      const repository = controlPlaneRepositories?.releaseGovernance;
      const runInTransaction = controlPlaneRepositories?.runInTransaction;
      if (
        !repository?.getPromotionRequest
        || typeof runInTransaction !== "function"
        || typeof authenticationService?.reauthenticate !== "function"
      ) {
        return c.json({
          available: false,
          code: "RELEASE_GOVERNANCE_NOT_CONFIGURED",
          message: "Audited release approval is not configured.",
        }, 503);
      }
      const payload = await c.req.json().catch(() => ({}));
      const permittedKeys = new Set(["password", "confirmation"]);
      if (Object.keys(payload).some((key) => !permittedKeys.has(key))) {
        return c.json({
          available: false,
          code: "RELEASE_APPROVAL_INPUT_INVALID",
          message: "The promotion approval contains unsupported fields.",
        }, 400);
      }
      try {
        const promotionRequestId = c.req.param("promotionRequestId");
        const existing = await repository.getPromotionRequest(promotionRequestId);
        if (!existing) {
          return c.json({
            available: false,
            code: "PROMOTION_REQUEST_NOT_FOUND",
            message: "The promotion request was not found.",
          }, 404);
        }
        const actor = actorFromContext(c);
        if (existing.requestedBy === actor.id) {
          return c.json({
            available: false,
            code: "SECOND_APPROVER_REQUIRED",
            message: "Production promotion requires approval by a different platform administrator.",
          }, 409);
        }
        if (payload.confirmation !== promotionApprovalConfirmation(promotionRequestId)) {
          return c.json({
            available: false,
            code: "RELEASE_APPROVAL_CONFIRMATION_MISMATCH",
            message: "The approval confirmation does not match this request.",
          }, 400);
        }
        const stepUp = await authenticationService.reauthenticate(
          c.get("resolvedSession"),
          payload.password,
          c.get("authenticationMetadata") || {},
        );
        const result = await runInTransaction(async (repositories) => {
          const request = await repositories.releaseGovernance
            .approvePromotionRequest({
              promotionRequestId,
              approvedBy: actor.id,
              approvedAt: new Date(),
              approvalReauthenticatedAt: stepUp.reauthenticatedAt,
            });
          const audit = await repositories.security.recordPlatformAudit({
            actorType: actor.type,
            actorId: actor.id,
            organisationScopeId: null,
            action: "platform_release.approve_promotion",
            targetType: "platform_release_promotion",
            targetId: promotionRequestId,
            beforeSummary: {
              status: existing.status,
              requestedBy: existing.requestedBy,
            },
            afterSummary: {
              status: request.status,
              approvedBy: request.approvedBy,
              commitSha: request.commitSha,
              artifactDigest: request.artifactDigest,
              reauthenticated: true,
              distinctApprover: true,
            },
            correlationId: actor.correlationId,
            outcome: "success",
            source: actor.source,
          });
          return { request, audit };
        });
        return c.json({
          available: true,
          promotionRequest: result.request,
          auditEventId: result.audit.auditEventId,
          message: "Promotion approved. GitHub Actions may now consume this exact request.",
        });
      } catch (error) {
        return releaseGovernanceError(
          c,
          error,
          "The release promotion approval could not be recorded.",
        );
      }
    },
  );

  app.get(
    "/admin/platform/administrators",
    requirePlatformAdministratorManage,
    async (c) => {
      if (
        typeof controlPlaneService?.getPlatformAdministratorAccess !== "function"
      ) {
        return c.json({
          available: false,
          code: "PLATFORM_ADMINISTRATOR_ACCESS_NOT_CONFIGURED",
          message: "Platform administrator access management is not configured.",
        }, 503);
      }
      try {
        const access = await controlPlaneService.getPlatformAdministratorAccess();
        return c.json({
          available: true,
          actor: {
            userId: c.get("authContext")?.user_id || null,
          },
          policy: {
            invitationType: "platform_administrator",
            invitationLifetimeHours: 24,
            oneUse: true,
            reauthenticationRequired: true,
            distinctIdentityRequired: true,
            rawTokenStored: false,
          },
          organisation: access.organisation,
          administrators: access.administrators,
          invitations: access.invitations.map((invitation) => ({
            ...invitation,
            revocationConfirmation:
              platformAdministratorRevocationConfirmation(
                invitation.invitationId,
              ),
          })),
        });
      } catch (error) {
        return platformAdministratorAccessError(
          c,
          error,
          "Platform administrator access could not be loaded.",
        );
      }
    },
  );

  app.post(
    "/admin/platform/administrators/invitations",
    requirePlatformAdministratorManage,
    async (c) => {
      if (
        typeof controlPlaneService?.createPlatformAdministratorInvitation
          !== "function"
        || typeof authenticationService?.reauthenticate !== "function"
      ) {
        return c.json({
          available: false,
          code: "PLATFORM_ADMINISTRATOR_ACCESS_NOT_CONFIGURED",
          message: "Audited platform administrator invitations are not configured.",
        }, 503);
      }
      const payload = await c.req.json().catch(() => ({}));
      const permittedKeys = new Set(["email", "password", "confirmation"]);
      if (Object.keys(payload).some((key) => !permittedKeys.has(key))) {
        return c.json({
          available: false,
          code: "PLATFORM_ADMINISTRATOR_INVITATION_INPUT_INVALID",
          message: "The platform administrator invitation contains unsupported fields.",
        }, 400);
      }
      const email = normalizePlatformAdministratorEmail(payload.email);
      if (
        !email
        || email.length > 320
        || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
      ) {
        return c.json({
          available: false,
          code: "INVALID_ADMINISTRATOR_EMAIL",
          message: "A valid administrator email address is required.",
        }, 400);
      }
      if (
        payload.confirmation
          !== platformAdministratorInvitationConfirmation(email)
      ) {
        return c.json({
          available: false,
          code: "PLATFORM_ADMINISTRATOR_INVITATION_CONFIRMATION_MISMATCH",
          message: "The invitation confirmation does not match the requested identity.",
        }, 400);
      }
      try {
        const actor = actorFromContext(c);
        const stepUp = await authenticationService.reauthenticate(
          c.get("resolvedSession"),
          payload.password,
          c.get("authenticationMetadata") || {},
        );
        const result = await controlPlaneService
          .createPlatformAdministratorInvitation(
            {
              email,
              invitedBy: actor.id,
              reauthenticatedAt: stepUp.reauthenticatedAt,
              expiresInHours: 24,
            },
            actor,
          );
        return c.json({
          available: true,
          invitation: result.invitation,
          token: result.token,
          auditEventId: result.auditEventId,
          message: "Platform administrator invitation created. Copy the one-time link now.",
        }, 201);
      } catch (error) {
        return platformAdministratorAccessError(
          c,
          error,
          "The platform administrator invitation could not be created.",
        );
      }
    },
  );

  app.post(
    "/admin/platform/administrators/invitations/:invitationId/revoke",
    requirePlatformAdministratorManage,
    async (c) => {
      if (
        typeof controlPlaneService?.revokePlatformAdministratorInvitation
          !== "function"
        || typeof authenticationService?.reauthenticate !== "function"
      ) {
        return c.json({
          available: false,
          code: "PLATFORM_ADMINISTRATOR_ACCESS_NOT_CONFIGURED",
          message: "Audited platform administrator invitation revocation is not configured.",
        }, 503);
      }
      const payload = await c.req.json().catch(() => ({}));
      const permittedKeys = new Set(["password", "confirmation"]);
      if (Object.keys(payload).some((key) => !permittedKeys.has(key))) {
        return c.json({
          available: false,
          code: "PLATFORM_ADMINISTRATOR_REVOCATION_INPUT_INVALID",
          message: "The invitation revocation contains unsupported fields.",
        }, 400);
      }
      const invitationId = c.req.param("invitationId");
      if (
        payload.confirmation
          !== platformAdministratorRevocationConfirmation(invitationId)
      ) {
        return c.json({
          available: false,
          code: "PLATFORM_ADMINISTRATOR_REVOCATION_CONFIRMATION_MISMATCH",
          message: "The revocation confirmation does not match this invitation.",
        }, 400);
      }
      try {
        const actor = actorFromContext(c);
        const stepUp = await authenticationService.reauthenticate(
          c.get("resolvedSession"),
          payload.password,
          c.get("authenticationMetadata") || {},
        );
        const result = await controlPlaneService
          .revokePlatformAdministratorInvitation(
            {
              invitationId,
              revokedBy: actor.id,
              reauthenticatedAt: stepUp.reauthenticatedAt,
            },
            actor,
          );
        return c.json({
          available: true,
          invitation: result.invitation,
          auditEventId: result.auditEventId,
          message: "Platform administrator invitation revoked.",
        });
      } catch (error) {
        return platformAdministratorAccessError(
          c,
          error,
          "The platform administrator invitation could not be revoked.",
        );
      }
    },
  );

  app.get("/admin/platform/model-deployments", requirePlatformAdmin, async (c) => {
    const repository = controlPlaneRepositories?.modelDeployments;
    if (!repository?.listAll) {
      return c.json({
        available: false,
        code: "MODEL_CATALOGUE_NOT_CONFIGURED",
        message: "The model deployment catalogue is not configured.",
      }, 503);
    }

    const approvedIds = configuredModelDeploymentIds();
    const managedId = String(
      process.env.CLAIMGUARD_MANAGED_MODEL_DEPLOYMENT_ID || "",
    ).trim();
    const models = await repository.listAll();
    return c.json({
      available: true,
      models: models.map((model) =>
        projectDeploymentRuntimeState(model, approvedIds, managedId)),
    });
  });

  app.post("/admin/platform/model-deployments", requirePlatformAdmin, async (c) => {
    const repository = controlPlaneRepositories?.modelDeployments;
    const auditRepository = controlPlaneRepositories?.security;
    const runInTransaction = controlPlaneRepositories?.runInTransaction;
    if (
      !repository?.registerCandidate
      || !auditRepository?.recordPlatformAudit
      || typeof runInTransaction !== "function"
    ) {
      return c.json({
        available: false,
        code: "MODEL_CATALOGUE_NOT_CONFIGURED",
        message: "The audited model deployment catalogue is not configured.",
      }, 503);
    }

    const payload = await c.req.json().catch(() => ({}));
    const permittedKeys = new Set([
      "deploymentId",
      "modelId",
      "modelVersion",
      "displayName",
      "ownerType",
      "ownerOrganisationId",
      "requestSchemaVersion",
      "responseSchemaVersion",
      "featureSchemaVersion",
      "analysisMode",
      "decisionThreshold",
      "artifactSha256",
      "containerImageDigest",
      "capabilities",
      "automaticAdverseAction",
    ]);
    if (Object.keys(payload).some((key) => !permittedKeys.has(key))) {
      return c.json({
        available: false,
        code: "MODEL_DEPLOYMENT_INPUT_INVALID",
        message: "The model deployment payload contains unsupported fields.",
      }, 400);
    }
    if (!payload.artifactSha256 || !payload.containerImageDigest) {
      return c.json({
        available: false,
        code: "MODEL_DEPLOYMENT_DIGESTS_REQUIRED",
        message: "Immutable model artifact and container image digests are required.",
      }, 400);
    }
    if (payload.automaticAdverseAction === true) {
      return c.json({
        available: false,
        code: "MODEL_AUTOMATIC_ADVERSE_ACTION_FORBIDDEN",
        message: "Automatic adverse action is not permitted.",
      }, 400);
    }

    const actor = actorFromContext(c);
    try {
      const { model, audit } = await runInTransaction(async (repositories) => {
        const registeredModel = await repositories.modelDeployments
          .registerCandidate({
            ...payload,
            automaticAdverseAction: false,
            registeredBy: actor.id,
          });
        const auditEvent = await repositories.security.recordPlatformAudit({
          actorType: actor.type,
          actorId: actor.id,
          organisationScopeId: registeredModel.ownerOrganisationId,
          action: "model_deployment.register_candidate",
          targetType: "model_deployment",
          targetId: registeredModel.deploymentId,
          beforeSummary: null,
          afterSummary: {
            deploymentId: registeredModel.deploymentId,
            modelId: registeredModel.modelId,
            modelVersion: registeredModel.modelVersion,
            ownerType: registeredModel.ownerType,
            ownerOrganisationId: registeredModel.ownerOrganisationId,
            lifecycleStatus: registeredModel.lifecycleStatus,
            artifactSha256: registeredModel.artifactSha256,
            containerImageDigest: registeredModel.containerImageDigest,
          },
          correlationId: actor.correlationId,
          outcome: "success",
          source: actor.source,
        });
        return { model: registeredModel, audit: auditEvent };
      });
      return c.json({
        available: true,
        model: projectDeploymentRuntimeState(
          model,
          configuredModelDeploymentIds(),
          String(
            process.env.CLAIMGUARD_MANAGED_MODEL_DEPLOYMENT_ID || "",
          ).trim(),
        ),
        auditEventId: audit.auditEventId,
      }, 201);
    } catch (error) {
      const duplicate = error?.code === "ER_DUP_ENTRY";
      return c.json({
        available: false,
        code: duplicate
          ? "MODEL_DEPLOYMENT_ALREADY_REGISTERED"
          : error?.code || "MODEL_DEPLOYMENT_REGISTRATION_FAILED",
        message: duplicate
          ? "The immutable model deployment is already registered."
          : error?.message || "Failed to register the model deployment.",
      }, duplicate ? 409 : Number.isInteger(error?.status) ? error.status : 400);
    }
  });

  app.post(
    "/admin/platform/model-deployments/:deploymentId/activate",
    requirePlatformAdmin,
    async (c) => {
      const repository = controlPlaneRepositories?.modelDeployments;
      const auditRepository = controlPlaneRepositories?.security;
      const runInTransaction = controlPlaneRepositories?.runInTransaction;
      if (
        !repository?.activateClaimGuardCandidate
        || !auditRepository?.recordPlatformAudit
        || typeof runInTransaction !== "function"
      ) {
        return c.json({
          available: false,
          code: "MODEL_CATALOGUE_NOT_CONFIGURED",
          message: "The audited model deployment catalogue is not configured.",
        }, 503);
      }

      const release = configuredClaimGuardRelease();
      if (Object.values(release).some((value) => !value)) {
        return c.json({
          available: false,
          code: "MODEL_RELEASE_NOT_STAGED",
          message: "No complete production-governed model release is staged.",
        }, 503);
      }

      const deploymentId = String(c.req.param("deploymentId") || "").trim();
      if (deploymentId !== release.deploymentId) {
        return c.json({
          available: false,
          code: "MODEL_RELEASE_TARGET_MISMATCH",
          message: "The requested deployment is not the staged production release.",
        }, 409);
      }
      const payload = await c.req.json().catch(() => ({}));
      if (
        Object.keys(payload).some((key) => key !== "confirmation")
        || payload.confirmation !== `ACTIVATE ${release.deploymentId}`
      ) {
        return c.json({
          available: false,
          code: "MODEL_RELEASE_CONFIRMATION_REQUIRED",
          message: `Confirm the exact staged release with ACTIVATE ${release.deploymentId}.`,
        }, 400);
      }

      const actor = actorFromContext(c);
      try {
        const { activation, audit } = await runInTransaction(
          async (repositories) => {
            const activated = await repositories.modelDeployments
              .activateClaimGuardCandidate({
                deploymentId: release.deploymentId,
                expectedArtifactSha256: release.artifactSha256,
                expectedCandidateImageDigest: release.candidateImageDigest,
                releaseImageDigest: release.releaseImageDigest,
              });
            const auditEvent = await repositories.security.recordPlatformAudit({
              actorType: actor.type,
              actorId: actor.id,
              organisationScopeId: null,
              action: activated.alreadyActive
                ? "model_deployment.activate_idempotent"
                : "model_deployment.activate",
              targetType: "model_deployment",
              targetId: activated.model.deploymentId,
              beforeSummary: {
                deploymentId: activated.previous.deploymentId,
                lifecycleStatus: activated.previous.lifecycleStatus,
                artifactSha256: activated.previous.artifactSha256,
                containerImageDigest:
                  activated.previous.containerImageDigest,
              },
              afterSummary: {
                deploymentId: activated.model.deploymentId,
                lifecycleStatus: activated.model.lifecycleStatus,
                artifactSha256: activated.model.artifactSha256,
                containerImageDigest: activated.model.containerImageDigest,
                retiredDeploymentIds: activated.retiredDeploymentIds,
                automaticAdverseAction:
                  activated.model.automaticAdverseAction,
              },
              correlationId: actor.correlationId,
              outcome: "success",
              source: actor.source,
            });
            return { activation: activated, audit: auditEvent };
          },
        );
        return c.json({
          available: true,
          activated: !activation.alreadyActive,
          alreadyActive: activation.alreadyActive,
          model: projectDeploymentRuntimeState(
            activation.model,
            configuredModelDeploymentIds(),
            String(
              process.env.CLAIMGUARD_MANAGED_MODEL_DEPLOYMENT_ID || "",
            ).trim(),
          ),
          retiredDeploymentIds: activation.retiredDeploymentIds,
          auditEventId: audit.auditEventId,
          runtimeActivationPending:
            String(
              process.env.CLAIMGUARD_MANAGED_MODEL_DEPLOYMENT_ID || "",
            ).trim() !== activation.model.deploymentId,
        }, 200);
      } catch (error) {
        return c.json({
          available: false,
          code: error?.code || "MODEL_DEPLOYMENT_ACTIVATION_FAILED",
          message: error?.message || "Failed to activate the model deployment.",
        }, Number.isInteger(error?.status) ? error.status : 400);
      }
    },
  );

  app.post("/admin/platform/organisations", requirePlatformAdmin, async (c) => {
    const actor = actorFromContext(c);
    const payload = await c.req.json().catch(() => ({}));
    const displayName = String(payload?.displayName || "").trim();
    const canonicalSlug = String(payload?.canonicalSlug || "").trim();
    const requestedDeploymentClass = String(payload?.deploymentClass || deploymentClass).trim().toLowerCase();

    if (!displayName || !canonicalSlug) {
      return c.json({ available: false, code: "INVALID_ORGANISATION_INPUT", message: "displayName and canonicalSlug are required." }, 400);
    }

    if (!allowedDeploymentClasses.has(requestedDeploymentClass)) {
      return c.json({ available: false, code: "DEPLOYMENT_CLASS_NOT_ALLOWED", message: "Requested deployment class is not allowed in this environment." }, 400);
    }

    if (payload?.organisationType && payload.organisationType !== "medical_scheme") {
      return c.json({ available: false, code: "ORGANISATION_TYPE_NOT_ALLOWED", message: "Platform onboarding currently supports medical_scheme only." }, 400);
    }

    try {
      const organisation = await controlPlaneService.createDraftOrganisation({
        displayName,
        canonicalSlug,
        organisationType: "medical_scheme",
        deploymentClass: requestedDeploymentClass,
      }, actor);

      const adminInput = payload?.initialAdministrator || {};
      const adminDisplayName = String(adminInput.displayName || "").trim();
      const adminUsername = String(adminInput.username || adminInput.email || "").trim().toLowerCase();
      if (adminDisplayName && adminUsername) {
        const user = await controlPlaneRepositories.identity.createUser({
          displayName: adminDisplayName,
          canonicalContact: adminUsername,
          status: "active",
        });
        const membership = await controlPlaneService.createMembership({
          userId: user.userId,
          organisationId: organisation.organisationId,
          status: "active",
          validFrom: new Date(),
          invitedBy: actor.id,
        }, actor);
        await controlPlaneService.assignMembershipRole({
          membershipId: membership.membershipId,
          roleKey: "scheme_administrator",
          assignedBy: actor.id,
          actorRoleKeys: c.get("authContext")?.roles || [],
        }, actor);
      }

      const azurePolicy = approvedAzurePolicy({ organisationId: organisation.organisationId, canonicalSlug: organisation.canonicalSlug, deploymentClass: requestedDeploymentClass });
      return c.json({
        available: true,
        organisation,
        provisioningReview: deriveProvisioningReview({
          organisation,
          azurePolicy,
          databaseName: azurePolicy.generatedDatabaseName,
        }),
      }, 201);
    } catch (error) {
      const status = Number.isInteger(error?.status) ? error.status : 400;
      const code = error?.code || "ORGANISATION_CREATE_FAILED";
      return c.json({ available: false, code, message: error?.message || "Failed to create organisation draft." }, status);
    }
  });

  app.post("/admin/platform/organisations/:id/invite-admin", requirePlatformAdmin, async (c) => {
    if (!controlPlaneService?.createAdminInvitation) {
      return c.json({ available: false, code: "NOT_CONFIGURED", message: "Invitations are not configured." }, 404);
    }
    const actor = actorFromContext(c);
    const organisationId = c.req.param("id");
    const payload = await c.req.json().catch(() => ({}));
    const email = String(payload?.email || "").trim().toLowerCase();

    if (!email) {
      return c.json({ available: false, code: "INVALID_INPUT", message: "email is required." }, 400);
    }

    try {
      const result = await controlPlaneService.createAdminInvitation({
        organisationId,
        email,
        invitedBy: actor.id,
      }, actor);

      // We return the raw token so the UI can construct the signup URL
      return c.json({
        available: true,
        invitationId: result.invitationId,
        token: result.token,
        email: result.email,
        expiresAt: result.expiresAt,
      }, 201);
    } catch (error) {
      const status = Number.isInteger(error?.status) ? error.status : 400;
      const code = error?.code || "INVITE_FAILED";
      return c.json({ available: false, code, message: error?.message || "Failed to create invitation." }, status);
    }
  });

  app.get("/admin/platform/organisations/:id/invitations", requirePlatformAdmin, async (c) => {
    if (!controlPlaneService?.listInvitations) {
      return c.json({ available: false, code: "NOT_CONFIGURED", message: "Invitations are not configured." }, 404);
    }
    const organisationId = c.req.param("id");
    try {
      const invitations = await controlPlaneService.listInvitations(organisationId);
      return c.json({ available: true, invitations });
    } catch (error) {
      return c.json({ available: false, code: "FETCH_FAILED", message: "Failed to list invitations." }, 500);
    }
  });

  app.get("/admin/platform/global-detection-engine", requirePlatformAdmin, async (c) => {
    const modelDeploymentId = String(
      process.env.CLAIMGUARD_MANAGED_MODEL_DEPLOYMENT_ID || "",
    ).trim();
    const approvedDeploymentIds = configuredModelDeploymentIds();

    return c.json({
      available: true,
      strategy: {
        modelDeploymentId: modelDeploymentId || null,
        approved: Boolean(
          modelDeploymentId
          && approvedDeploymentIds.has(modelDeploymentId),
        ),
        configurationSource: "deployment_environment",
        writable: false,
        activationMode: "audited_prospective_transition",
      },
    });
  });

  app.put("/admin/platform/global-detection-engine", requirePlatformAdmin, async (c) => {
    c.header("Allow", "GET");
    return c.json({
      available: false,
      code: "MODEL_PROMOTION_DEPLOYMENT_CONTROLLED",
      message: "The fleet-managed model is controlled by validated deployment configuration. Promote it through the production deployment workflow.",
    }, 405);
  });

  app.get("/admin/platform/organisations", requirePlatformAdmin, async (c) => {
    const organisations = (await controlPlaneService.listOrganisations({})).filter((item) => item.organisationType === "medical_scheme");
    const operations = await controlPlaneRepositories.provisioning.listOperations({ limit: 200 });
    const latestByOrganisation = new Map();
    for (const operation of operations) {
      if (!latestByOrganisation.has(operation.organisationId)) latestByOrganisation.set(operation.organisationId, operation);
    }
    return c.json({
      available: true,
      organisations: organisations.map((organisation) => ({
        ...organisation,
        latestProvisioningOperation: latestByOrganisation.get(organisation.organisationId) || null,
      })),
    });
  });

  app.get("/admin/platform/organisations/:organisationId", requirePlatformAdmin, async (c) => {
    const organisationId = c.req.param("organisationId");
    const organisation = await controlPlaneRepositories.organisations.getById(organisationId);
    if (!organisation) {
      return c.json({ available: false, code: "ORGANISATION_NOT_FOUND", message: "Organisation was not found." }, 404);
    }
    const routes = await controlPlaneRepositories.routes.listInternalActiveForOrganisation(organisationId);
    const operations = await controlPlaneRepositories.provisioning.listOperations({ organisationId, limit: 25 });
    return c.json({
      available: true,
      organisation,
      activeRoutes: routes.map((route) => ({
        routeId: route.route_id,
        routeType: route.route_type,
        routeGeneration: Number(route.route_generation),
        provisioningStatus: route.provisioning_status,
        healthStatus: route.health_status,
      })),
      operations,
    });
  });

app.post("/admin/platform/organisations/:organisationId/provision", requirePlatformAdmin, async (c) => {
  const actor = actorFromContext(c);
  const organisationId = c.req.param("organisationId");
  const organisation = await controlPlaneRepositories.organisations.getById(organisationId);
  if (!organisation) {
    return c.json({ available: false, code: "ORGANISATION_NOT_FOUND", message: "Organisation was not found." }, 404);
  }

  const operation = await controlPlaneService.requestProvisioningOperation({
    organisationId,
    operationType: "onboard_private_database",
    requestedBy: actor.id || "platform-admin",
    correlationId: actor.correlationId,
  }, actor).catch((error) => {
    const status = Number.isInteger(error?.status) ? error.status : 409;
    return c.json({ available: false, code: error?.code || "PROVISIONING_REQUEST_FAILED", message: error?.message || "Provisioning could not be requested." }, status);
  });

  if (operation instanceof Response) return operation;

  const workerTrigger = await attemptProvisioningWorkerStart({
    startProvisioningJob,
    operation,
    organisationId,
  });

  return c.json({
    available: true,
    operation: safeProvisioningProjection({ ...operation, steps: [] }),
    workerTrigger,
    message: workerTrigger.status === "started"
      ? "Provisioning queued and the Azure worker was started."
      : "Provisioning was queued, but the Azure worker could not be started automatically.",
  }, 202);
});

  app.post(
    "/admin/platform/organisations/:organisationId/upgrade",
    requirePlatformAdmin,
    async (c) => {
      const actor = actorFromContext(c);
      const organisationId = c.req.param("organisationId");

      try {
        const operation =
          await controlPlaneService.requestProvisioningOperation(
            {
              organisationId,
              operationType: "upgrade_private_database",
              requestedBy: actor.id || "platform-admin",
              correlationId: actor.correlationId,
            },
            actor,
          );

        const workerTrigger =
          await attemptProvisioningWorkerStart({
            startProvisioningJob,
            operation,
            organisationId,
          });

        return c.json(
          {
            available: true,
            operation: safeProvisioningProjection({
              ...operation,
              steps: [],
            }),
            workerTrigger,
            message:
              workerTrigger.status === "started"
                ? "Schema upgrade queued and the Azure worker was started."
                : "Schema upgrade was queued, but the Azure worker could not be started automatically.",
          },
          202,
        );
      } catch (error) {
        const status =
          Number.isInteger(error?.status)
            ? error.status
            : 409;

        return c.json(
          {
            available: false,
            code:
              error?.code
              || "UPGRADE_REQUEST_FAILED",
            message:
              error?.message
              || "Upgrade could not be requested.",
          },
          status,
        );
      }
    },
  );

  app.get("/admin/platform/provisioning/:operationId", requirePlatformAdmin, async (c) => {
    const operationId = c.req.param("operationId");
    try {
      const operation = await controlPlaneService.getProvisioningOperationWithSteps(operationId);
      return c.json({ available: true, operation: safeProvisioningProjection(operation) });
    } catch (error) {
      const status = Number.isInteger(error?.status) ? error.status : 404;
      return c.json({ available: false, code: error?.code || "PROVISIONING_OPERATION_NOT_FOUND", message: error?.message || "Provisioning operation was not found." }, status);
    }
  });

  app.post("/admin/platform/provisioning/:operationId/retry", requirePlatformAdmin, async (c) => {
    const actor = actorFromContext(c);
    const operationId = c.req.param("operationId");
    try {
      const operation = await controlPlaneService.retryProvisioningOperation(operationId, actor);
      return c.json({ available: true, operation: safeProvisioningProjection({ ...operation, steps: [] }) }, 202);
    } catch (error) {
      const status = Number.isInteger(error?.status) ? error.status : 409;
      return c.json({ available: false, code: error?.code || "PROVISIONING_RETRY_FAILED", message: error?.message || "Retry is not allowed for this operation." }, status);
    }
  });

  app.post("/admin/platform/provisioning/:operationId/cancel", requirePlatformAdmin, async (c) => {
    const actor = actorFromContext(c);
    const operationId = c.req.param("operationId");
    try {
      const operation = await controlPlaneService.cancelProvisioningOperation(operationId, actor);
      return c.json({ available: true, operation: safeProvisioningProjection({ ...operation, steps: [] }) }, 202);
    } catch (error) {
      const status = Number.isInteger(error?.status) ? error.status : 409;
      return c.json({ available: false, code: error?.code || "PROVISIONING_CANCEL_FAILED", message: error?.message || "Cancel is not allowed for this operation." }, status);
    }
  });

  app.post("/admin/platform/organisations/:organisationId/activate", requirePlatformAdmin, async (c) => {
    const actor = actorFromContext(c);
    const organisationId = c.req.param("organisationId");
    const organisation = await controlPlaneRepositories.organisations.getById(organisationId);
    if (!organisation) {
      return c.json({ available: false, code: "ORGANISATION_NOT_FOUND", message: "Organisation was not found." }, 404);
    }

    try {
      const activated = await controlPlaneService.activateOrganisation(organisationId, actor);
      return c.json({
        available: true,
        activated: true,
        deferred: false,
        message: "Medical aid activated. Its verified private route is now authoritative.",
        ...activated,
        integrationGuide: integrationGuide(c, activated.organisation),
      });
    } catch (error) {
      const status = Number.isInteger(error?.status) ? error.status : 409;
      return c.json({ available: false, code: error?.code || "ORGANISATION_ACTIVATION_FAILED", message: error?.message || "Organisation could not be activated." }, status);
    }
  });

  app.get("/admin/platform/organisations/:organisationId/integration", requirePlatformAdmin, async (c) => {
    const organisationId = c.req.param("organisationId");
    const organisation = await controlPlaneRepositories.organisations.getById(organisationId);
    if (!organisation || organisation.organisationType !== "medical_scheme") {
      return c.json({ available: false, code: "ORGANISATION_NOT_FOUND", message: "Medical-scheme organisation was not found." }, 404);
    }
    const credentials = await controlPlaneRepositories.integrationCredentials.listForOrganisation(organisationId);
    return c.json({
      available: true,
      organisation,
      credentials,
      guide: integrationGuide(c, organisation),
    });
  });

  app.post("/admin/platform/organisations/:organisationId/integration-credentials", requirePlatformAdmin, async (c) => {
    const actor = actorFromContext(c);
    const organisationId = c.req.param("organisationId");
    const payload = await c.req.json().catch(() => ({}));
    const displayName = String(payload.displayName || "Claims server").trim();
    const serviceActorId = String(payload.serviceActorId || "").trim().toLowerCase();
    const expiresInDays = Math.max(1, Math.min(365, Number.parseInt(payload.expiresInDays || "90", 10) || 90));
    if (!/^[a-z0-9][a-z0-9._:-]{2,127}$/.test(serviceActorId)) {
      return c.json({ available: false, code: "INVALID_SERVICE_ACTOR", message: "serviceActorId must be a stable lowercase identifier." }, 400);
    }
    try {
      const result = await controlPlaneService.createIntegrationCredential({
        organisationId,
        displayName,
        serviceActorId,
        expiresAt: new Date(Date.now() + expiresInDays * 86_400_000),
      }, actor);
      c.header("Cache-Control", "no-store");
      return c.json({
        available: true,
        credential: result.credential,
        bearerToken: result.bearerToken,
        shownOnce: true,
        guide: integrationGuide(c, await controlPlaneRepositories.organisations.getById(organisationId)),
      }, 201);
    } catch (error) {
      const status = Number.isInteger(error?.status) ? error.status : 409;
      return c.json({ available: false, code: error?.code || "INTEGRATION_CREDENTIAL_CREATE_FAILED", message: error?.message || "Integration credential could not be created." }, status);
    }
  });

  app.post("/admin/platform/organisations/:organisationId/integration-credentials/:credentialId/revoke", requirePlatformAdmin, async (c) => {
    const actor = actorFromContext(c);
    try {
      const credential = await controlPlaneService.revokeIntegrationCredential({
        organisationId: c.req.param("organisationId"),
        integrationCredentialId: c.req.param("credentialId"),
      }, actor);
      return c.json({ available: true, credential });
    } catch (error) {
      const status = Number.isInteger(error?.status) ? error.status : 404;
      return c.json({ available: false, code: error?.code || "INTEGRATION_CREDENTIAL_REVOKE_FAILED", message: error?.message || "Integration credential could not be revoked." }, status);
    }
  });

  app.post("/admin/platform/organisations/:organisationId/suspend", requirePlatformAdmin, async (c) => {
    const actor = actorFromContext(c);
    const organisationId = c.req.param("organisationId");
    try {
      const updated = await controlPlaneService.transitionOrganisation(organisationId, "suspended", {
        suspensionReason: "platform_admin_suspended",
        actor,
      });
      return c.json({ available: true, organisation: updated });
    } catch (error) {
      const status = Number.isInteger(error?.status) ? error.status : 409;
      return c.json({ available: false, code: error?.code || "ORGANISATION_SUSPEND_FAILED", message: error?.message || "Organisation could not be suspended." }, status);
    }
  });

  app.get("/admin/platform/organisations/:organisationId/health", requirePlatformAdmin, async (c) => {
    const organisationId = c.req.param("organisationId");
    const organisation = await controlPlaneRepositories.organisations.getById(organisationId);
    if (!organisation) {
      return c.json({ available: false, code: "ORGANISATION_NOT_FOUND", message: "Organisation was not found." }, 404);
    }

    const operations = await controlPlaneRepositories.provisioning.listOperations({ organisationId, limit: 5 });
    const latest = operations[0] || null;
    const latestWithSteps = latest ? await controlPlaneService.getProvisioningOperationWithSteps(latest.operationId) : null;

    const checks = {
      organisationStatus: organisation.status,
      hasPendingProvisioning: Boolean(latest && ["pending", "running", "compensating"].includes(latest.status)),
      readyForActivation: organisation.status === "ready_for_activation",
      latestOperationStatus: latest?.status || null,
      latestOperationId: latest?.operationId || null,
    };

    return c.json({
      available: true,
      organisation,
      checks,
      latestOperation: latestWithSteps ? safeProvisioningProjection(latestWithSteps) : null,
    });
  });
}
