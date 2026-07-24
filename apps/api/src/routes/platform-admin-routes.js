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

function parseAllowedDeploymentClasses() {
  return new Set(
    String(process.env.PLATFORM_ALLOWED_DEPLOYMENT_CLASSES || "demo")
      .split(",")
      .map((value) => value.trim().toLowerCase())
      .filter(Boolean),
  );
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

export function registerPlatformAdminRoutes(app, {
  controlPlaneRepositories,
  controlPlaneService,
  deploymentClass = "demo",
} = {}) {
  const requirePlatformAdmin = createRequirePermissionMiddleware({
    permission: CLAIMGUARD_PERMISSIONS.TENANTS_MANAGE,
  });
  const allowedDeploymentClasses = parseAllowedDeploymentClasses();

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
    try {
      const flag = await controlPlaneRepositories.configuration.getFeatureFlag({
        flagKey: "global_detection_engine",
      });
      return c.json({
        available: true,
        strategy: flag?.value || { modelDeploymentId: "" },
      });
    } catch (error) {
      return c.json({ available: false, message: "Failed to load global detection engine config" }, 500);
    }
  });

  app.put("/admin/platform/global-detection-engine", requirePlatformAdmin, async (c) => {
    try {
      const payload = await c.req.json();
      const modelDeploymentId = String(payload.modelDeploymentId || "").trim();
      const approvedDeploymentIds = new Set(
        String(process.env.APPROVED_MODEL_DEPLOYMENT_IDS || "")
          .split(",")
          .map((value) => value.trim())
          .filter(Boolean),
      );
      if (!modelDeploymentId || !approvedDeploymentIds.has(modelDeploymentId)) {
        return c.json({ available: false, message: "modelDeploymentId is not approved in this environment." }, 400);
      }
      await controlPlaneRepositories.configuration.setFeatureFlag({
        flagKey: "global_detection_engine",
        valueType: "json",
        value: {
          modelDeploymentId,
        },
        enabled: true,
      });
      return c.json({ available: true, message: "Global detection engine updated" });
    } catch (error) {
      return c.json({ available: false, message: "Failed to update global detection engine config" }, 500);
    }
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

    return c.json({
      available: true,
      operation: safeProvisioningProjection({ ...operation, steps: [] }),
    }, 202);
  });

  app.post("/admin/platform/organisations/:organisationId/upgrade", requirePlatformAdmin, async (c) => {
    const actor = actorFromContext(c);
    const organisationId = c.req.param("organisationId");
    try {
      const operation = await controlPlaneService.requestProvisioningOperation({
        organisationId,
        operationType: "upgrade_private_database",
        requestedBy: actor.id || "platform-admin",
        correlationId: actor.correlationId,
      }, actor);
      return c.json({
        available: true,
        operation: safeProvisioningProjection({ ...operation, steps: [] }),
      }, 202);
    } catch (error) {
      const status = Number.isInteger(error?.status) ? error.status : 409;
      return c.json({ available: false, code: error?.code || "UPGRADE_REQUEST_FAILED", message: error?.message || "Upgrade could not be requested." }, status);
    }
  });

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
