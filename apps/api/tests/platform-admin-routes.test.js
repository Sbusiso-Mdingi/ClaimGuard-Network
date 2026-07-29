import assert from "node:assert/strict";
import test from "node:test";

import { createBackendApp } from "../src/backend.js";

function platformHeaders(userId = "platform-admin-1") {
  return {
    "x-claimguard-user": userId,
    "x-claimguard-role": "platform_administrator",
    "x-claimguard-user-tenant": "tenant_platform",
  };
}

function investigatorHeaders() {
  return {
    "x-claimguard-user": "investigator-1",
    "x-claimguard-role": "investigator",
    "x-claimguard-user-tenant": "tenant_alpha",
  };
}

function createControlPlaneHarness({
  failModelAudit = false,
  failModelActivationAudit = false,
  failReleaseAudit = false,
} = {}) {
  const organisations = new Map();
  const operations = new Map();
  const stepsByOperation = new Map();
  const integrationCredentials = new Map();
  const modelDeployments = new Map();
  const releases = new Map();
  const promotionRequests = new Map();
  const audits = [];
  const reauthenticationAttempts = [];
  let opCounter = 0;

  let repositories;
  repositories = {
    organisations: {
      async getById(id) {
        return organisations.get(id) || null;
      },
      async list() {
        return [...organisations.values()];
      },
    },
    routes: {
      async listInternalActiveForOrganisation() {
        return [];
      },
    },
    provisioning: {
      async listOperations({ organisationId = null } = {}) {
        const all = [...operations.values()];
        if (!organisationId) return all.sort((a, b) => String(b.operationId).localeCompare(String(a.operationId)));
        return all.filter((entry) => entry.organisationId === organisationId);
      },
    },
    identity: {
      async createUser({ displayName, canonicalContact }) {
        return {
          userId: `user-${canonicalContact}`,
          displayName,
        };
      },
    },
    integrationCredentials: {
      async listForOrganisation(organisationId) {
        return [...integrationCredentials.values()].filter((entry) => entry.organisationId === organisationId);
      },
    },
    modelDeployments: {
      async listAll() {
        return [...modelDeployments.values()];
      },
      async registerCandidate(input) {
        if (modelDeployments.has(input.deploymentId)) {
          const error = new Error("Duplicate model deployment.");
          error.code = "ER_DUP_ENTRY";
          throw error;
        }
        const model = {
          ...input,
          lifecycleStatus: "candidate",
          runtimeConfigKey: "CANDIDATE_RUNTIME_KEY",
          automaticAdverseAction: false,
          validatedAt: null,
          activatedAt: null,
          retiredAt: null,
        };
        modelDeployments.set(model.deploymentId, model);
        return model;
      },
      async activateClaimGuardCandidate({
        deploymentId,
        expectedArtifactSha256,
        expectedCandidateImageDigest,
        releaseImageDigest,
      }) {
        const current = modelDeployments.get(deploymentId);
        if (
          !current
          || current.ownerType !== "claimguard"
          || current.artifactSha256 !== expectedArtifactSha256
          || current.containerImageDigest !== expectedCandidateImageDigest
          || current.lifecycleStatus !== "candidate"
        ) {
          const error = new Error("The governed release does not match.");
          error.code = "MODEL_DEPLOYMENT_RELEASE_MISMATCH";
          error.status = 409;
          throw error;
        }
        const retiredDeploymentIds = [];
        for (const [id, model] of modelDeployments) {
          if (
            id !== deploymentId
            && model.ownerType === "claimguard"
            && model.lifecycleStatus === "active"
          ) {
            retiredDeploymentIds.push(id);
            modelDeployments.set(id, {
              ...model,
              lifecycleStatus: "retired",
              retiredAt: "2026-07-28T10:00:00.000Z",
            });
          }
        }
        const activated = {
          ...current,
          containerImageDigest: releaseImageDigest,
          lifecycleStatus: "active",
          validatedAt: "2026-07-28T10:00:00.000Z",
          activatedAt: "2026-07-28T10:00:00.000Z",
        };
        modelDeployments.set(deploymentId, activated);
        return {
          model: activated,
          previous: current,
          retiredDeploymentIds,
          alreadyActive: false,
        };
      },
    },
    releaseGovernance: {
      async listEligibleReleases() {
        return [...releases.values()];
      },
      async listPromotionRequests() {
        return [...promotionRequests.values()];
      },
      async getCurrentDeployment() {
        return null;
      },
      async getReleaseById(releaseId) {
        return releases.get(releaseId) || null;
      },
      async getPromotionRequest(promotionRequestId) {
        return promotionRequests.get(promotionRequestId) || null;
      },
      async createPromotionRequest({
        releaseId,
        requestReason,
        requestedBy,
        requestedAt,
        requestReauthenticatedAt,
      }) {
        const release = releases.get(releaseId);
        const promotionRequestId = "44444444-4444-4444-8444-444444444444";
        const request = {
          promotionRequestId,
          releaseId,
          commitSha: release.commitSha,
          artifactDigest: release.artifactDigest,
          targetEnvironment: "production",
          status: "pending_approval",
          requestReason,
          requestedBy,
          requestedAt,
          requestReauthenticatedAt,
          approvedBy: null,
        };
        promotionRequests.set(promotionRequestId, request);
        return request;
      },
      async approvePromotionRequest({
        promotionRequestId,
        approvedBy,
        approvedAt,
        approvalReauthenticatedAt,
      }) {
        const request = promotionRequests.get(promotionRequestId);
        if (request.requestedBy === approvedBy) {
          const error = new Error("Production promotion requires approval by a different platform administrator.");
          error.status = 409;
          error.code = "SECOND_APPROVER_REQUIRED";
          throw error;
        }
        const approved = {
          ...request,
          status: "approved",
          approvedBy,
          approvedAt,
          approvalReauthenticatedAt,
        };
        promotionRequests.set(promotionRequestId, approved);
        return approved;
      },
    },
    security: {
      async recordPlatformAudit(event) {
        if (
          (
            failModelAudit
            && event.action === "model_deployment.register_candidate"
          )
          || (
            failModelActivationAudit
            && event.action === "model_deployment.activate"
          )
        ) {
          throw new Error("Simulated audit failure.");
        }
        if (
          failReleaseAudit
          && event.action === "platform_release.request_promotion"
        ) {
          throw new Error("Simulated release audit failure.");
        }
        audits.push(event);
        return { auditEventId: `audit-${audits.length}` };
      },
    },
    async runInTransaction(operation) {
      const modelSnapshot = new Map(modelDeployments);
      const promotionSnapshot = new Map(promotionRequests);
      const auditCount = audits.length;
      try {
        return await operation(repositories);
      } catch (error) {
        modelDeployments.clear();
        for (const [key, value] of modelSnapshot) {
          modelDeployments.set(key, value);
        }
        promotionRequests.clear();
        for (const [key, value] of promotionSnapshot) {
          promotionRequests.set(key, value);
        }
        audits.splice(auditCount);
        throw error;
      }
    },
  };

  const service = {
    async createDraftOrganisation({ displayName, canonicalSlug, organisationType, deploymentClass }) {
      const slugTaken = [...organisations.values()].some((entry) => entry.canonicalSlug === canonicalSlug);
      if (slugTaken) {
        const error = new Error("Organisation ID or canonical slug already exists.");
        error.status = 409;
        error.code = "ORGANISATION_CONFLICT";
        throw error;
      }
      const organisation = {
        organisationId: `org-${canonicalSlug}`,
        displayName,
        canonicalSlug,
        organisationType,
        deploymentClass,
        status: "draft",
      };
      organisations.set(organisation.organisationId, organisation);
      return organisation;
    },
    async createMembership({ userId, organisationId }) {
      return {
        membershipId: `membership-${userId}-${organisationId}`,
      };
    },
    async assignMembershipRole() {
      return { ok: true };
    },
    async listOrganisations() {
      return [...organisations.values()];
    },
    async requestProvisioningOperation({ organisationId, operationType, requestedBy }) {
      opCounter += 1;
      const operation = {
        operationId: `op-${opCounter}`,
        organisationId,
        operationType,
        status: "pending",
        requestedBy,
        correlationId: null,
        startedAt: null,
        completedAt: null,
        safeErrorSummary: null,
      };
      operations.set(operation.operationId, operation);
      stepsByOperation.set(operation.operationId, []);
      const organisation = organisations.get(organisationId);
      organisations.set(organisationId, { ...organisation, status: "provisioning" });
      return operation;
    },
    async getProvisioningOperationWithSteps(operationId) {
      const operation = operations.get(operationId);
      if (!operation) {
        const error = new Error("Provisioning operation was not found.");
        error.status = 404;
        error.code = "PROVISIONING_OPERATION_NOT_FOUND";
        throw error;
      }
      return { ...operation, steps: stepsByOperation.get(operationId) || [] };
    },
    async retryProvisioningOperation(operationId) {
      const operation = operations.get(operationId);
      if (!operation) {
        const error = new Error("Provisioning operation was not found.");
        error.status = 404;
        error.code = "PROVISIONING_OPERATION_NOT_FOUND";
        throw error;
      }
      const updated = { ...operation, status: "pending" };
      operations.set(operationId, updated);
      return updated;
    },
    async cancelProvisioningOperation(operationId) {
      const operation = operations.get(operationId);
      if (!operation) {
        const error = new Error("Provisioning operation was not found.");
        error.status = 404;
        error.code = "PROVISIONING_OPERATION_NOT_FOUND";
        throw error;
      }
      const updated = { ...operation, status: "compensating" };
      operations.set(operationId, updated);
      return updated;
    },
    async transitionOrganisation(organisationId, nextStatus) {
      const organisation = organisations.get(organisationId);
      if (!organisation) {
        const error = new Error("Organisation was not found.");
        error.status = 404;
        error.code = "ORGANISATION_NOT_FOUND";
        throw error;
      }
      const updated = { ...organisation, status: nextStatus };
      organisations.set(organisationId, updated);
      return updated;
    },
    async activateOrganisation(organisationId) {
      const organisation = organisations.get(organisationId);
      if (!organisation || organisation.status !== "ready_for_activation") {
        const error = new Error("Organisation is not ready for activation.");
        error.status = 409;
        error.code = "ORGANISATION_NOT_READY";
        throw error;
      }
      const updated = { ...organisation, status: "active", activationState: "activated" };
      organisations.set(organisationId, updated);
      return { organisation: updated, route: { routeId: `route-${organisationId}`, schemaVersion: "13" } };
    },
    async createIntegrationCredential({ organisationId, displayName, serviceActorId }) {
      const credential = {
        integrationCredentialId: `integration-${serviceActorId}`,
        organisationId,
        displayName,
        serviceActorId,
        tokenPrefix: "cg_live_test",
        roleKey: "claims_analyst",
        status: "active",
      };
      integrationCredentials.set(credential.integrationCredentialId, credential);
      return { credential, bearerToken: "cg_live_once_only_token" };
    },
    async revokeIntegrationCredential({ integrationCredentialId }) {
      const credential = integrationCredentials.get(integrationCredentialId);
      const updated = { ...credential, status: "revoked" };
      integrationCredentials.set(integrationCredentialId, updated);
      return updated;
    },
  };

  const authenticationService = {
    async reauthenticate(_resolvedSession, password) {
      reauthenticationAttempts.push(password);
      if (password !== "correct-password") {
        const error = new Error("The credentials could not be verified.");
        error.status = 401;
        error.code = "AUTHENTICATION_FAILED";
        throw error;
      }
      return {
        reauthenticatedAt: new Date("2026-07-29T12:00:00.000Z"),
      };
    },
  };

  return {
    repositories,
    service,
    authenticationService,
    organisations,
    operations,
    integrationCredentials,
    modelDeployments,
    releases,
    promotionRequests,
    audits,
    reauthenticationAttempts,
  };
}

function createApp(options) {
  const harness = createControlPlaneHarness(options);
  const app = createBackendApp({
    controlPlaneRepositories: harness.repositories,
    controlPlaneService: harness.service,
    authenticationService: harness.authenticationService,
    authenticationConfiguration: {
      mode: "demo_headers",
      deploymentClass: options?.deploymentClass || "demo",
    },
  });
  return { app, harness };
}

test("platform admin creates draft organisation without provisioning infrastructure", async () => {
  const { app } = createApp();

  const response = await app.request("http://localhost/admin/platform/organisations", {
    method: "POST",
    headers: {
      ...platformHeaders(),
      "content-type": "application/json",
    },
    body: JSON.stringify({
      displayName: "Discovery Health",
      canonicalSlug: "discovery-health",
      deploymentClass: "demo",
      initialAdministrator: {
        displayName: "Discovery Admin",
        email: "admin@discovery.demo",
      },
    }),
  });

  const json = await response.json();
  assert.equal(response.status, 201);
  assert.equal(json.available, true);
  assert.equal(json.organisation.status, "draft");
  assert.equal(json.provisioningReview.generatedLogicalDatabaseName.startsWith("claimguard_tenant_"), true);
});

test("production onboarding defaults to production and rejects demo or pilot classes", async () => {
  const { app } = createApp({ deploymentClass: "production" });

  const accepted = await app.request("http://localhost/admin/platform/organisations", {
    method: "POST",
    headers: {
      ...platformHeaders(),
      "content-type": "application/json",
    },
    body: JSON.stringify({
      displayName: "Production Scheme",
      canonicalSlug: "production-scheme",
    }),
  });
  const acceptedJson = await accepted.json();
  assert.equal(accepted.status, 201);
  assert.equal(acceptedJson.organisation.deploymentClass, "production");

  for (const deploymentClass of ["demo", "pilot"]) {
    const rejected = await app.request("http://localhost/admin/platform/organisations", {
      method: "POST",
      headers: {
        ...platformHeaders(),
        "content-type": "application/json",
      },
      body: JSON.stringify({
        displayName: `${deploymentClass} Scheme`,
        canonicalSlug: `${deploymentClass}-scheme`,
        deploymentClass,
      }),
    });
    const rejectedJson = await rejected.json();
    assert.equal(rejected.status, 400);
    assert.equal(rejectedJson.code, "DEPLOYMENT_CLASS_NOT_ALLOWED");
  }
});

test("non-platform user cannot mutate onboarding routes", async () => {
  const { app } = createApp();

  const response = await app.request("http://localhost/admin/platform/organisations", {
    method: "POST",
    headers: {
      ...investigatorHeaders(),
      "content-type": "application/json",
    },
    body: JSON.stringify({ displayName: "X", canonicalSlug: "x" }),
  });

  assert.equal(response.status, 403);
});

test("release governance exposes verified provenance and enforces reauthenticated two-person approval", async () => {
  const { app, harness } = createApp();
  const releaseId = "11111111-1111-4111-8111-111111111111";
  harness.releases.set(releaseId, {
    releaseId,
    commitSha: "a".repeat(40),
    sourceRepository: "Sbusiso-Mdingi/ClaimGuard-Network",
    sourceBranch: "main",
    artifactDigest: "b".repeat(64),
    webArtifactDigest: "c".repeat(64),
    apiArtifactDigest: "d".repeat(64),
    artifactWorkflowRunId: "1000",
    artifactWorkflowRunUrl: "https://github.com/Sbusiso-Mdingi/ClaimGuard-Network/actions/runs/1000",
    ciWorkflowRunId: "1001",
    ciWorkflowRunUrl: "https://github.com/Sbusiso-Mdingi/ClaimGuard-Network/actions/runs/1001",
    securityWorkflowRunId: "1002",
    securityWorkflowRunUrl: "https://github.com/Sbusiso-Mdingi/ClaimGuard-Network/actions/runs/1002",
    eligibleAt: new Date("2026-07-29T10:00:00.000Z"),
  });

  const overview = await app.request("http://localhost/admin/platform/releases", {
    headers: platformHeaders(),
  });
  const overviewBody = await overview.json();
  assert.equal(overview.status, 200);
  assert.equal(overviewBody.releases[0].requestConfirmation, "PROMOTE aaaaaaaaaaaa TO PRODUCTION");
  assert.equal(overviewBody.policy.distinctSecondApproverRequired, true);
  assert.equal(overviewBody.actor.canRequest, true);
  assert.equal(overviewBody.actor.canApprove, true);

  const requested = await app.request(
    `http://localhost/admin/platform/releases/${releaseId}/promotion-requests`,
    {
      method: "POST",
      headers: {
        ...platformHeaders(),
        "content-type": "application/json",
      },
      body: JSON.stringify({
        password: "correct-password",
        confirmation: "PROMOTE aaaaaaaaaaaa TO PRODUCTION",
        reason: "Promote the release after CI and security review.",
      }),
    },
  );
  const requestedBody = await requested.json();
  assert.equal(requested.status, 201);
  assert.equal(requestedBody.promotionRequest.status, "pending_approval");
  assert.equal(requestedBody.auditEventId, "audit-1");
  assert.equal(harness.reauthenticationAttempts.length, 1);
  assert.equal(harness.audits[0].action, "platform_release.request_promotion");

  const requestId = requestedBody.promotionRequest.promotionRequestId;
  const ownApproval = await app.request(
    `http://localhost/admin/platform/promotion-requests/${requestId}/approve`,
    {
      method: "POST",
      headers: {
        ...platformHeaders(),
        "content-type": "application/json",
      },
      body: JSON.stringify({
        password: "correct-password",
        confirmation: "APPROVE 44444444",
      }),
    },
  );
  assert.equal(ownApproval.status, 409);
  assert.equal((await ownApproval.json()).code, "SECOND_APPROVER_REQUIRED");
  assert.equal(harness.reauthenticationAttempts.length, 1);

  const approved = await app.request(
    `http://localhost/admin/platform/promotion-requests/${requestId}/approve`,
    {
      method: "POST",
      headers: {
        ...platformHeaders("platform-admin-2"),
        "content-type": "application/json",
      },
      body: JSON.stringify({
        password: "correct-password",
        confirmation: "APPROVE 44444444",
      }),
    },
  );
  const approvedBody = await approved.json();
  assert.equal(approved.status, 200);
  assert.equal(approvedBody.promotionRequest.status, "approved");
  assert.equal(approvedBody.promotionRequest.approvedBy, "platform-admin-2");
  assert.equal(harness.audits[1].action, "platform_release.approve_promotion");
  assert.equal(harness.reauthenticationAttempts.length, 2);
});

test("release promotion rolls back when its permanent audit cannot be stored", async () => {
  const { app, harness } = createApp({ failReleaseAudit: true });
  const releaseId = "11111111-1111-4111-8111-111111111111";
  harness.releases.set(releaseId, {
    releaseId,
    commitSha: "a".repeat(40),
    artifactDigest: "b".repeat(64),
  });

  const response = await app.request(
    `http://localhost/admin/platform/releases/${releaseId}/promotion-requests`,
    {
      method: "POST",
      headers: {
        ...platformHeaders(),
        "content-type": "application/json",
      },
      body: JSON.stringify({
        password: "correct-password",
        confirmation: "PROMOTE aaaaaaaaaaaa TO PRODUCTION",
        reason: "Promote the release after CI and security review.",
      }),
    },
  );

  assert.equal(response.status, 400);
  assert.equal(harness.promotionRequests.size, 0);
  assert.equal(harness.audits.length, 0);
});

test("platform model endpoint reports the deployment-authoritative configuration", async () => {
  const previousManagedModel = process.env.CLAIMGUARD_MANAGED_MODEL_DEPLOYMENT_ID;
  const previousApprovedModels = process.env.APPROVED_MODEL_DEPLOYMENT_IDS;
  process.env.CLAIMGUARD_MANAGED_MODEL_DEPLOYMENT_ID = "claimguard-claim-fraud-baseline:1.0.0";
  process.env.APPROVED_MODEL_DEPLOYMENT_IDS = [
    "claimguard-claim-fraud-baseline:1.0.0",
    "scheme-owned-model:2.0.0",
  ].join(",");

  try {
    const { app } = createApp();
    const response = await app.request(
      "http://localhost/admin/platform/global-detection-engine",
      { headers: platformHeaders() },
    );
    const json = await response.json();

    assert.equal(response.status, 200);
    assert.deepEqual(json.strategy, {
      modelDeploymentId: "claimguard-claim-fraud-baseline:1.0.0",
      approved: true,
      configurationSource: "deployment_environment",
      writable: false,
      activationMode: "audited_prospective_transition",
    });
  } finally {
    if (previousManagedModel === undefined) {
      delete process.env.CLAIMGUARD_MANAGED_MODEL_DEPLOYMENT_ID;
    } else {
      process.env.CLAIMGUARD_MANAGED_MODEL_DEPLOYMENT_ID = previousManagedModel;
    }
    if (previousApprovedModels === undefined) {
      delete process.env.APPROVED_MODEL_DEPLOYMENT_IDS;
    } else {
      process.env.APPROVED_MODEL_DEPLOYMENT_IDS = previousApprovedModels;
    }
  }
});

test("platform model promotion cannot create a phantom control-plane override", async () => {
  const { app } = createApp();
  const response = await app.request(
    "http://localhost/admin/platform/global-detection-engine",
    {
      method: "PUT",
      headers: {
        ...platformHeaders(),
        "content-type": "application/json",
      },
      body: JSON.stringify({
        modelDeploymentId: "claimguard-claim-fraud-baseline:2.0.0",
      }),
    },
  );
  const json = await response.json();

  assert.equal(response.status, 405);
  assert.equal(response.headers.get("allow"), "GET");
  assert.equal(json.code, "MODEL_PROMOTION_DEPLOYMENT_CONTROLLED");
});

test("platform model catalogue registers an immutable audited candidate", async () => {
  const { app, harness } = createApp();
  const payload = {
    deploymentId: "claimguard-claim-fraud-ensemble:2.0.0",
    modelId: "claimguard-claim-fraud-ensemble",
    modelVersion: "2.0.0",
    displayName: "ClaimGuard fraud ensemble 2.0.0",
    ownerType: "claimguard",
    ownerOrganisationId: null,
    requestSchemaVersion: "claimguard.claim-screening-request.v3",
    responseSchemaVersion: "claimguard.claim-screening-response.v3",
    featureSchemaVersion: "claim-feature-schema-2026.2",
    analysisMode: "PROSPECTIVE_CLAIM_SCREENING",
    decisionThreshold: 0.19,
    artifactSha256: "a".repeat(64),
    containerImageDigest: `registry.example/model@sha256:${"b".repeat(64)}`,
    capabilities: {
      prospectiveClaimScreening: true,
      networkEnrichment: false,
    },
    automaticAdverseAction: false,
  };

  const created = await app.request(
    "http://localhost/admin/platform/model-deployments",
    {
      method: "POST",
      headers: {
        ...platformHeaders(),
        "content-type": "application/json",
      },
      body: JSON.stringify(payload),
    },
  );
  const createdBody = await created.json();
  const listed = await app.request(
    "http://localhost/admin/platform/model-deployments",
    { headers: platformHeaders() },
  );
  const listedBody = await listed.json();

  assert.equal(created.status, 201);
  assert.equal(createdBody.model.lifecycleStatus, "candidate");
  assert.equal(createdBody.model.runtimeApproved, false);
  assert.equal(createdBody.auditEventId, "audit-1");
  assert.equal(listed.status, 200);
  assert.deepEqual(
    listedBody.models.map((model) => model.deploymentId),
    [payload.deploymentId],
  );
  assert.equal(harness.audits[0].action, "model_deployment.register_candidate");
  assert.equal(harness.audits[0].targetId, payload.deploymentId);
});

test("model catalogue rejects automatic adverse action and non-platform access", async () => {
  const { app, harness } = createApp();
  const request = {
    method: "POST",
    headers: {
      ...platformHeaders(),
      "content-type": "application/json",
    },
    body: JSON.stringify({
      deploymentId: "unsafe-model:1.0.0",
      artifactSha256: "a".repeat(64),
      containerImageDigest: `sha256:${"b".repeat(64)}`,
      automaticAdverseAction: true,
    }),
  };

  const rejected = await app.request(
    "http://localhost/admin/platform/model-deployments",
    request,
  );
  const rejectedBody = await rejected.json();
  const forbidden = await app.request(
    "http://localhost/admin/platform/model-deployments",
    {
      ...request,
      headers: {
        ...investigatorHeaders(),
        "content-type": "application/json",
      },
    },
  );

  assert.equal(rejected.status, 400);
  assert.equal(
    rejectedBody.code,
    "MODEL_AUTOMATIC_ADVERSE_ACTION_FORBIDDEN",
  );
  assert.equal(forbidden.status, 403);
  assert.equal(harness.modelDeployments.size, 0);
  assert.equal(harness.audits.length, 0);
});

test("model candidate registration rolls back when its audit cannot be stored", async () => {
  const { app, harness } = createApp({ failModelAudit: true });
  const response = await app.request(
    "http://localhost/admin/platform/model-deployments",
    {
      method: "POST",
      headers: {
        ...platformHeaders(),
        "content-type": "application/json",
      },
      body: JSON.stringify({
        deploymentId: "claimguard-claim-fraud-ensemble:2.0.0",
        modelId: "claimguard-claim-fraud-ensemble",
        modelVersion: "2.0.0",
        displayName: "ClaimGuard fraud ensemble 2.0.0",
        ownerType: "claimguard",
        ownerOrganisationId: null,
        requestSchemaVersion: "claimguard.claim-screening-request.v3",
        responseSchemaVersion: "claimguard.claim-screening-response.v3",
        featureSchemaVersion: "claim-feature-schema-2026.2",
        analysisMode: "PROSPECTIVE_CLAIM_SCREENING",
        decisionThreshold: 0.19,
        artifactSha256: "a".repeat(64),
        containerImageDigest: `registry.example/model@sha256:${"b".repeat(64)}`,
        capabilities: {
          prospectiveClaimScreening: true,
          networkEnrichment: false,
        },
        automaticAdverseAction: false,
      }),
    },
  );

  assert.equal(response.status, 400);
  assert.equal(harness.modelDeployments.size, 0);
  assert.equal(harness.audits.length, 0);
});

test("platform activation promotes only the exact staged ClaimGuard release and audits it", async () => {
  const previous = {
    deploymentId:
      process.env.CLAIMGUARD_RELEASE_CANDIDATE_DEPLOYMENT_ID,
    artifact:
      process.env.CLAIMGUARD_RELEASE_CANDIDATE_ARTIFACT_SHA256,
    candidateImage:
      process.env.CLAIMGUARD_RELEASE_CANDIDATE_IMAGE_DIGEST,
    releaseImage:
      process.env.CLAIMGUARD_RELEASE_IMAGE_DIGEST,
  };
  const deploymentId = "claimguard-claim-fraud-ensemble:2.1.1";
  const artifactSha256 = "a".repeat(64);
  const candidateImageDigest = `registry.example/model@sha256:${"b".repeat(64)}`;
  const releaseImageDigest = `registry.example/model@sha256:${"c".repeat(64)}`;
  process.env.CLAIMGUARD_RELEASE_CANDIDATE_DEPLOYMENT_ID = deploymentId;
  process.env.CLAIMGUARD_RELEASE_CANDIDATE_ARTIFACT_SHA256 = artifactSha256;
  process.env.CLAIMGUARD_RELEASE_CANDIDATE_IMAGE_DIGEST = candidateImageDigest;
  process.env.CLAIMGUARD_RELEASE_IMAGE_DIGEST = releaseImageDigest;

  try {
    const { app, harness } = createApp();
    harness.modelDeployments.set("claimguard-claim-fraud-baseline:1.0.0", {
      deploymentId: "claimguard-claim-fraud-baseline:1.0.0",
      ownerType: "claimguard",
      ownerOrganisationId: null,
      lifecycleStatus: "active",
      automaticAdverseAction: false,
    });
    harness.modelDeployments.set(deploymentId, {
      deploymentId,
      modelId: "claimguard-claim-fraud-ensemble",
      modelVersion: "2.1.1",
      ownerType: "claimguard",
      ownerOrganisationId: null,
      lifecycleStatus: "candidate",
      artifactSha256,
      containerImageDigest: candidateImageDigest,
      automaticAdverseAction: false,
      validatedAt: null,
      activatedAt: null,
      retiredAt: null,
    });

    const response = await app.request(
      `http://localhost/admin/platform/model-deployments/${encodeURIComponent(deploymentId)}/activate`,
      {
        method: "POST",
        headers: {
          ...platformHeaders(),
          "content-type": "application/json",
        },
        body: JSON.stringify({
          confirmation: `ACTIVATE ${deploymentId}`,
        }),
      },
    );
    const json = await response.json();

    assert.equal(response.status, 200);
    assert.equal(json.activated, true);
    assert.equal(json.model.lifecycleStatus, "active");
    assert.equal(json.model.containerImageDigest, releaseImageDigest);
    assert.equal(json.runtimeActivationPending, true);
    assert.deepEqual(json.retiredDeploymentIds, [
      "claimguard-claim-fraud-baseline:1.0.0",
    ]);
    assert.equal(harness.audits[0].action, "model_deployment.activate");
    assert.equal(harness.audits[0].targetId, deploymentId);
  } finally {
    const mappings = [
      ["CLAIMGUARD_RELEASE_CANDIDATE_DEPLOYMENT_ID", previous.deploymentId],
      ["CLAIMGUARD_RELEASE_CANDIDATE_ARTIFACT_SHA256", previous.artifact],
      ["CLAIMGUARD_RELEASE_CANDIDATE_IMAGE_DIGEST", previous.candidateImage],
      ["CLAIMGUARD_RELEASE_IMAGE_DIGEST", previous.releaseImage],
    ];
    for (const [key, value] of mappings) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("model activation rolls back when its audit cannot be stored", async () => {
  const deploymentId = "claimguard-claim-fraud-ensemble:2.1.1";
  const artifactSha256 = "d".repeat(64);
  const candidateImageDigest = `registry.example/model@sha256:${"e".repeat(64)}`;
  const releaseImageDigest = `registry.example/model@sha256:${"f".repeat(64)}`;
  const keys = [
    "CLAIMGUARD_RELEASE_CANDIDATE_DEPLOYMENT_ID",
    "CLAIMGUARD_RELEASE_CANDIDATE_ARTIFACT_SHA256",
    "CLAIMGUARD_RELEASE_CANDIDATE_IMAGE_DIGEST",
    "CLAIMGUARD_RELEASE_IMAGE_DIGEST",
  ];
  const oldValues = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  Object.assign(process.env, {
    CLAIMGUARD_RELEASE_CANDIDATE_DEPLOYMENT_ID: deploymentId,
    CLAIMGUARD_RELEASE_CANDIDATE_ARTIFACT_SHA256: artifactSha256,
    CLAIMGUARD_RELEASE_CANDIDATE_IMAGE_DIGEST: candidateImageDigest,
    CLAIMGUARD_RELEASE_IMAGE_DIGEST: releaseImageDigest,
  });
  try {
    const { app, harness } = createApp({ failModelActivationAudit: true });
    harness.modelDeployments.set(deploymentId, {
      deploymentId,
      ownerType: "claimguard",
      ownerOrganisationId: null,
      lifecycleStatus: "candidate",
      artifactSha256,
      containerImageDigest: candidateImageDigest,
      automaticAdverseAction: false,
    });
    const response = await app.request(
      `http://localhost/admin/platform/model-deployments/${encodeURIComponent(deploymentId)}/activate`,
      {
        method: "POST",
        headers: {
          ...platformHeaders(),
          "content-type": "application/json",
        },
        body: JSON.stringify({ confirmation: `ACTIVATE ${deploymentId}` }),
      },
    );
    assert.equal(response.status, 400);
    assert.equal(
      harness.modelDeployments.get(deploymentId).lifecycleStatus,
      "candidate",
    );
    assert.equal(harness.audits.length, 0);
  } finally {
    for (const key of keys) {
      if (oldValues[key] === undefined) delete process.env[key];
      else process.env[key] = oldValues[key];
    }
  }
});

test("provisioning request returns 202 and operation status can be polled", async () => {
  const { app, harness } = createApp();
  harness.organisations.set("org-bonitas", {
    organisationId: "org-bonitas",
    displayName: "Bonitas",
    canonicalSlug: "bonitas",
    organisationType: "medical_scheme",
    deploymentClass: "demo",
    status: "draft",
  });

  const provision = await app.request("http://localhost/admin/platform/organisations/org-bonitas/provision", {
    method: "POST",
    headers: platformHeaders(),
  });
  const provisionJson = await provision.json();
  assert.equal(provision.status, 202);
  assert.equal(provisionJson.operation.status, "pending");

  const poll = await app.request(`http://localhost/admin/platform/provisioning/${provisionJson.operation.operationId}`, {
    headers: platformHeaders(),
  });
  const pollJson = await poll.json();
  assert.equal(poll.status, 200);
  assert.equal(pollJson.operation.operationId, provisionJson.operation.operationId);
});

test("activation is explicit and returns the medical-aid integration guide", async () => {
  const { app, harness } = createApp();
  harness.organisations.set("org-momentum", {
    organisationId: "org-momentum",
    displayName: "Momentum",
    canonicalSlug: "momentum",
    organisationType: "medical_scheme",
    deploymentClass: "demo",
    status: "ready_for_activation",
  });

  const response = await app.request("http://localhost/admin/platform/organisations/org-momentum/activate", {
    method: "POST",
    headers: platformHeaders(),
  });
  const json = await response.json();
  assert.equal(response.status, 200);
  assert.equal(json.activated, true);
  assert.equal(json.deferred, false);
  assert.equal(json.organisation.status, "active");
  assert.match(json.integrationGuide.endpoint, /\/claims\/ingest$/);
});

test("active medical aid receives a one-time, revocable claims-server credential", async () => {
  const { app, harness } = createApp();
  harness.organisations.set("org-discovery", {
    organisationId: "org-discovery",
    displayName: "Discovery Health",
    canonicalSlug: "discovery-health",
    organisationType: "medical_scheme",
    deploymentClass: "demo",
    status: "active",
    activationState: "activated",
  });

  const created = await app.request("http://localhost/admin/platform/organisations/org-discovery/integration-credentials", {
    method: "POST",
    headers: { ...platformHeaders(), "content-type": "application/json" },
    body: JSON.stringify({ displayName: "Desktop feed", serviceActorId: "discovery-feed-01", expiresInDays: 90 }),
  });
  const createdJson = await created.json();
  assert.equal(created.status, 201);
  assert.equal(created.headers.get("cache-control"), "no-store");
  assert.equal(createdJson.shownOnce, true);
  assert.equal(createdJson.bearerToken, "cg_live_once_only_token");

  const revoked = await app.request(
    `http://localhost/admin/platform/organisations/org-discovery/integration-credentials/${createdJson.credential.integrationCredentialId}/revoke`,
    { method: "POST", headers: platformHeaders() },
  );
  assert.equal(revoked.status, 200);
  assert.equal((await revoked.json()).credential.status, "revoked");
});
