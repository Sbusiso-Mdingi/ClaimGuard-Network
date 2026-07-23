import assert from "node:assert/strict";
import test from "node:test";

import { createBackendApp } from "../src/backend.js";

function platformHeaders() {
  return {
    "x-claimguard-user": "platform-admin-1",
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

function createControlPlaneHarness() {
  const organisations = new Map();
  const operations = new Map();
  const stepsByOperation = new Map();
  const integrationCredentials = new Map();
  let opCounter = 0;

  const repositories = {
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

  return { repositories, service, organisations, operations, integrationCredentials };
}

function createApp() {
  const harness = createControlPlaneHarness();
  const app = createBackendApp({
    controlPlaneRepositories: harness.repositories,
    controlPlaneService: harness.service,
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
