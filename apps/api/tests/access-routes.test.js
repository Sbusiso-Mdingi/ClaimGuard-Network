import assert from "node:assert/strict";
import test from "node:test";

import { versionConflict } from "@claimguard/control-plane-database";

import { createAuthenticatedAuthContext } from "../src/middleware/auth-context.js";
import { createBackendApp } from "../src/backend.js";
import { createRequestAuthenticationProvider } from "./helpers/authentication-provider.js";

const organisation = Object.freeze({
  organisationId: "org-alpha",
  organisationType: "medical_scheme",
  displayName: "Alpha Scheme",
});

function provider({
  permissions = [],
  roles = ["scheme_administrator"],
  actorType = "user",
  organisationValue = organisation,
  organisationId = organisationValue.organisationId,
  membershipId = "membership-alpha",
  authenticationVersion = 3,
  authorizationVersion = 7,
} = {}) {
  return createRequestAuthenticationProvider(() => ({
    authContext: createAuthenticatedAuthContext({
      userId: actorType === "service" ? "service-alpha" : "user-admin",
      roles,
      permissions,
      tenantId: "tenant-alpha",
      organisationId,
      membershipId,
      organisation: organisationValue,
      actorType,
      authenticationVersion,
      authorizationVersion,
      source: "test",
    }),
  }));
}

function createAccessStub() {
  const calls = [];
  const state = {
    roles: [{
      roleId: "role-alpha",
      organisationId: "org-alpha",
      roleKey: "claims_reader",
      displayName: "Claims reader",
      description: "",
      roleClass: "custom",
      status: "active",
      version: 2,
      permissionKeys: ["claims.view_own"],
    }],
    assignments: [{
      assignmentId: "assignment-alpha",
      organisationId: "org-alpha",
      membershipId: "membership-user",
      subjectUserId: "user-target",
      roleId: "role-alpha",
      status: "active",
      version: 1,
    }],
    delegations: [{
      delegationId: "delegation-alpha",
      organisationId: "org-alpha",
      grantorUserId: "user-admin",
      granteeUserId: "user-target",
      status: "active",
      version: 1,
      permissionKeys: ["claims.view_own"],
    }],
    elevatedRequests: [{
      requestId: "request-alpha",
      organisationId: "org-alpha",
      requestedBy: "user-requester",
      targetUserId: "user-target",
      decision: "pending",
      version: 1,
      permissionKeys: ["access.assignments.manage"],
    }],
  };
  const access = {
    calls,
    async listRoles(input) { calls.push(["listRoles", input]); return state.roles; },
    async getRole(input) { calls.push(["getRole", input]); return state.roles.find((r) => r.roleId === input.roleId) || null; },
    async createCustomRole(input) { calls.push(["createCustomRole", input]); return { roleId: "role-new", roleKey: input.roleKey, displayName: input.displayName, replayed: false }; },
    async updateCustomRoleMetadata(input) { calls.push(["updateCustomRoleMetadata", input]); return { roleId: input.roleId, version: input.expectedVersion + 1 }; },
    async replaceCustomRolePermissions(input) { calls.push(["replaceCustomRolePermissions", input]); return { roleId: input.roleId, version: input.expectedVersion + 1 }; },
    async disableCustomRole(input) { calls.push(["disableCustomRole", input]); return { roleId: input.roleId, version: input.expectedVersion + 1 }; },
    async listAssignments(input) { calls.push(["listAssignments", input]); return state.assignments; },
    async getAssignment(input) { calls.push(["getAssignment", input]); return state.assignments.find((a) => a.assignmentId === input.assignmentId) || null; },
    async createRoleAssignment(input) { calls.push(["createRoleAssignment", input]); return { assignmentId: "assignment-new", replayed: false }; },
    async revokeRoleAssignment(input) {
      const current = state.assignments.find(
        (entry) => entry.assignmentId === input.assignmentId,
      );
      if (current?.version !== input.expectedVersion) {
        throw versionConflict(
          "assignment",
          input.assignmentId,
          input.expectedVersion,
          current?.version ?? null,
        );
      }
      calls.push(["revokeRoleAssignment", input]);
      return { assignmentId: input.assignmentId, version: 2 };
    },
    async listDelegations(input) { calls.push(["listDelegations", input]); return state.delegations; },
    async getDelegation(input) { calls.push(["getDelegation", input]); return state.delegations.find((d) => d.delegationId === input.delegationId) || null; },
    async createDelegation(input) { calls.push(["createDelegation", input]); return { delegationId: "delegation-new", replayed: false }; },
    async revokeDelegation(input) {
      const current = state.delegations.find(
        (entry) => entry.delegationId === input.delegationId,
      );
      if (current?.version !== input.expectedVersion) {
        throw versionConflict(
          "delegation",
          input.delegationId,
          input.expectedVersion,
          current?.version ?? null,
        );
      }
      calls.push(["revokeDelegation", input]);
      return { delegationId: input.delegationId, version: 2 };
    },
    async listElevatedRequests(input) { calls.push(["listElevatedRequests", input]); return state.elevatedRequests; },
    async getElevatedRequest(input) { calls.push(["getElevatedRequest", input]); return state.elevatedRequests.find((r) => r.requestId === input.requestId) || null; },
    async approveElevatedRequest(input) {
      const current = state.elevatedRequests.find(
        (entry) => entry.requestId === input.requestId,
      );
      if (current?.version !== input.expectedVersion) {
        throw versionConflict(
          "elevated_request",
          input.requestId,
          input.expectedVersion,
          current?.version ?? null,
        );
      }
      calls.push(["approveElevatedRequest", input]);
      return { requestId: input.requestId, decision: "approved", version: 2 };
    },
    async rejectElevatedRequest(input) {
      const current = state.elevatedRequests.find(
        (entry) => entry.requestId === input.requestId,
      );
      if (current?.version !== input.expectedVersion) {
        throw versionConflict(
          "elevated_request",
          input.requestId,
          input.expectedVersion,
          current?.version ?? null,
        );
      }
      calls.push(["rejectElevatedRequest", input]);
      return { requestId: input.requestId, decision: "rejected", version: 2 };
    },
    async listAudit(input) { calls.push(["listAudit", input]); return { events: [], nextCursor: null }; },
    async getMembership({ organisationId, membershipId }) {
      if (organisationId !== "org-alpha" || membershipId !== "membership-user") return null;
      return { membershipId, userId: "user-target", organisationId, status: "active", authorizationVersion: 4 };
    },
    async explainUserAccess({ organisationId, userId }) {
      if (organisationId !== "org-alpha" || !["user-admin", "user-target"].includes(userId)) return null;
      return {
        userId,
        membershipId: userId === "user-admin" ? "membership-alpha" : "membership-user",
        organisationId,
        authorizationVersion: userId === "user-admin" ? 7 : 4,
        permissions: ["claims.view_own"],
        sources: [{ permission: "claims.view_own", sources: [{ type: "system_role", roleKey: "scheme_user" }] }],
      };
    },
  };
  return { access, calls, state };
}

function app({ permissions = [], roles, actorType, organisationValue, organisationId, membershipId, authenticationVersion, authorizationVersion } = {}) {
  const stub = createAccessStub();
  const controlPlaneRepositories = {
    access: stub.access,
    async runInTransaction(operation) { return operation({ access: stub.access }); },
  };
  return {
    api: createBackendApp({
      authenticationProvider: provider({ permissions, roles, actorType, organisationValue, organisationId, membershipId, authenticationVersion, authorizationVersion }),
      controlPlaneRepositories,
    }),
    ...stub,
  };
}

function json(method, body, headers = {}) {
  return {
    method,
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  };
}

test("anonymous requests cannot read the access catalogue", async () => {
  const { api } = app({ membershipId: null });
  const response = await api.request("/api/v1/access/permissions");
  assert.equal(response.status, 403);
});

test("role names alone grant no access-management authority", async () => {
  const { api } = app({ roles: ["scheme_administrator"], permissions: [] });
  const response = await api.request("/api/v1/access/roles");
  assert.equal(response.status, 403);
});

test("explicit canonical permission lists safe catalogue metadata", async () => {
  const { api } = app({ permissions: ["access.roles.read"] });
  const response = await api.request("/api/v1/access/permissions");
  assert.equal(response.status, 200);
  const body = await response.json();
  const legacy = body.permissions.find((entry) => entry.key === "investigations.confirm");
  assert.deepEqual(
    { tenantAssignable: legacy.tenantAssignable, delegable: legacy.delegable, systemOnly: legacy.systemOnly },
    { tenantAssignable: false, delegable: false, systemOnly: true },
  );
  assert.equal(body.permissions.some((entry) => entry.key === "tenant.invented"), false);
});

test("service and platform actors cannot use human scheme access routes", async () => {
  const service = app({ permissions: ["access.roles.read"], actorType: "service" });
  assert.equal((await service.api.request("/api/v1/access/roles")).status, 403);
  const platform = app({
    permissions: ["access.roles.read"],
    organisationValue: { organisationId: "org-platform", organisationType: "platform" },
    organisationId: "org-platform",
  });
  assert.equal((await platform.api.request("/api/v1/access/roles")).status, 403);
});

test("strict mutation schemas reject client authority fields", async () => {
  const { api, calls } = app({ permissions: ["access.roles.manage"] });
  const response = await api.request("/api/v1/access/roles", json("POST", {
    roleKey: "claims_reader",
    displayName: "Claims reader",
    permissionKeys: ["claims.view_own"],
    idempotencyKey: "role-1",
    organisationId: "org-foreign",
    roles: ["scheme_administrator"],
    permissions: ["access.roles.manage"],
  }));
  assert.equal(response.status, 400);
  assert.equal(calls.length, 0);
});

test("unknown and elevated permission requests fail closed before mutation", async () => {
  const first = app({ permissions: ["access.roles.manage"] });
  const unknown = await first.api.request("/api/v1/access/roles/role-alpha/permissions", json("POST", {
    expectedVersion: 2,
    permissionKeys: ["tenant.invented"],
    idempotencyKey: "replace-unknown",
  }));
  assert.equal(unknown.status, 400);
  const second = app({ permissions: ["access.roles.manage"] });
  const elevated = await second.api.request("/api/v1/access/roles/role-alpha/permissions", json("POST", {
    expectedVersion: 2,
    permissionKeys: ["access.assignments.manage"],
    idempotencyKey: "replace-elevated",
  }));
  assert.equal(elevated.status, 422);
  assert.equal(second.calls.some(([name]) => name === "replaceCustomRolePermissions"), false);
});

test("role reads and mutations derive the organisation and actor from trusted context", async () => {
  const { api, calls } = app({ permissions: ["access.roles.read", "access.roles.manage"] });
  assert.equal((await api.request("/api/v1/access/roles")).status, 200);
  const response = await api.request("/api/v1/access/roles/role-alpha", json("PATCH", {
    displayName: "Updated",
    expectedVersion: 2,
  }));
  assert.equal(response.status, 200);
  const call = calls.find(([name]) => name === "updateCustomRoleMetadata")[1];
  assert.equal(call.organisationId, "org-alpha");
  assert.equal(call.actorId, "user-admin");
});

test("foreign roles are not disclosed", async () => {
  const { api } = app({ permissions: ["access.roles.read"] });
  const response = await api.request("/api/v1/access/roles/role-foreign");
  assert.equal(response.status, 404);
  const body = await response.json();
  assert.equal(body.code, "ACCESS_ROLE_NOT_FOUND");
});

test("stale assignment and delegation revocation versions are rejected", async () => {
  const { api, calls } = app({ permissions: ["access.assignments.manage", "access.delegations.revoke"] });
  const assignment = await api.request("/api/v1/access/assignments/assignment-alpha/revoke", json("POST", {
    expectedVersion: 9,
    idempotencyKey: "revoke-a",
  }));
  assert.equal(assignment.status, 409);
  const delegation = await api.request("/api/v1/access/delegations/delegation-alpha/revoke", json("POST", {
    expectedVersion: 9,
    idempotencyKey: "revoke-d",
  }));
  assert.equal(delegation.status, 409);
  assert.equal(calls.some(([name]) => name === "revokeRoleAssignment"), false);
  assert.equal(calls.some(([name]) => name === "revokeDelegation"), false);
});

test("assignment and delegation commands derive tenant-linked target users", async () => {
  const { api, calls } = app({ permissions: ["access.assignments.manage", "access.delegations.grant"] });
  const assignment = await api.request("/api/v1/access/assignments", json("POST", {
    roleId: "role-alpha",
    targetMembershipId: "membership-user",
    expectedMembershipVersion: 4,
    idempotencyKey: "assign-1",
  }));
  assert.equal(assignment.status, 201);
  const delegation = await api.request("/api/v1/access/delegations", json("POST", {
    targetMembershipId: "membership-user",
    permissionKeys: ["claims.view_own"],
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    reason: "Temporary cover",
    idempotencyKey: "delegate-1",
  }));
  assert.equal(delegation.status, 201);
  const assignmentCall = calls.find(([name]) => name === "createRoleAssignment")[1];
  const delegationCall = calls.find(([name]) => name === "createDelegation")[1];
  assert.equal(assignmentCall.organisationId, "org-alpha");
  assert.equal(assignmentCall.subjectUserId, "user-target");
  assert.equal(delegationCall.grantorUserId, "user-admin");
  assert.equal(delegationCall.granteeUserId, "user-target");
  assert.equal("grantorEffectivePermissions" in delegationCall, false);
});

test("elevated decisions require explicit reviewer permission and current version", async () => {
  const denied = app({ permissions: [] });
  assert.equal((await denied.api.request("/api/v1/access/elevated-requests")).status, 403);
  const allowed = app({ permissions: ["access.elevated_permissions.review"] });
  const stale = await allowed.api.request("/api/v1/access/elevated-requests/request-alpha/approve", json("POST", {
    expectedVersion: 4,
    idempotencyKey: "approve-stale",
    decisionReason: "Independent review",
  }));
  assert.equal(stale.status, 409);
});

test("audit pagination is bounded and access explanations are tenant scoped", async () => {
  const { api, calls } = app({ permissions: ["access.audit.read", "access.roles.read"] });
  const invalid = await api.request("/api/v1/access/audit?pageSize=101");
  assert.equal(invalid.status, 400);
  const audit = await api.request("/api/v1/access/audit?pageSize=25&permissions=access.audit.read");
  assert.equal(audit.status, 200);
  assert.equal(calls.find(([name]) => name === "listAudit")[1].organisationId, "org-alpha");
  assert.equal((await api.request("/api/v1/access/users/user-foreign")).status, 404);
});

test("access me returns resolver output and server-derived capabilities", async () => {
  const { api } = app({ permissions: ["access.roles.read", "claims.view_own"] });
  const response = await api.request("/api/v1/access/me");
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.access.organisationId, "org-alpha");
  assert.deepEqual(body.access.permissions, ["claims.view_own"]);
  assert.equal(body.access.capabilities.roles_read, true);
  assert.equal(body.access.capabilities.roles_manage, false);
});
