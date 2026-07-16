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
  const privateSchemaVersion = process.env.PRIVATE_TENANT_SCHEMA_VERSION || "8";
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
          status: "invited",
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

    // Phase 11E keeps private routes inactive; activation here only confirms control-plane readiness.
    if (organisation.status !== "ready_for_activation") {
      return c.json({ available: false, code: "ORGANISATION_NOT_READY", message: "Organisation is not ready for activation." }, 409);
    }

    return c.json({
      available: true,
      activated: false,
      deferred: true,
      message: "Activation is explicitly deferred in Phase 11E because route cutover is out of scope.",
      organisation,
    }, 202);
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
