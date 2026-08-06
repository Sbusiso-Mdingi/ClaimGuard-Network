import {
  ACCESS_ERROR_CODE,
  PERMISSION_CATALOGUE,
  isElevatedPermission,
  validatePermissionKeys,
} from "@claimguard/control-plane-database";
import { z } from "zod";

import { hasPermission } from "../authorization-policy.js";
import {
  applicationErrorResponse,
  ForbiddenError,
  UnauthenticatedError,
} from "../application-errors.js";

const ACCESS_PERMISSIONS = Object.freeze({
  ROLES_READ: "access.roles.read",
  ROLES_MANAGE: "access.roles.manage",
  ASSIGNMENTS_READ: "access.assignments.read",
  ASSIGNMENTS_MANAGE: "access.assignments.manage",
  DELEGATIONS_READ: "access.delegations.read",
  DELEGATIONS_GRANT: "access.delegations.grant",
  DELEGATIONS_REVOKE: "access.delegations.revoke",
  ELEVATED_REVIEW: "access.elevated_permissions.review",
  AUDIT_READ: "access.audit.read",
});

const id = z.string().trim().min(1).max(36);
const idempotencyKey = z.string().trim().min(1).max(128);
const expectedVersion = z.number().int().positive();
const permissionKeys = z.array(z.string().trim().min(1).max(128)).max(128)
  .transform((values) => [...new Set(values)]);
const optionalDate = z.string().datetime({ offset: true }).nullable().optional();

const createRoleSchema = z.object({
  roleKey: z.string().trim().regex(/^[a-z][a-z0-9_]{1,62}[a-z0-9]$/),
  displayName: z.string().trim().min(1).max(128),
  description: z.string().max(512).optional().default(""),
  permissionKeys: permissionKeys.optional().default([]),
  idempotencyKey,
}).strict();

const updateRoleSchema = z.object({
  displayName: z.string().trim().min(1).max(128).optional(),
  description: z.string().max(512).optional(),
  expectedVersion,
}).strict().refine(
  (value) => value.displayName !== undefined || value.description !== undefined,
  "At least one mutable metadata field is required.",
);

const replacePermissionsSchema = z.object({ expectedVersion, permissionKeys, idempotencyKey }).strict();
const disableRoleSchema = z.object({ expectedVersion, idempotencyKey }).strict();
const createAssignmentSchema = z.object({
  roleId: id,
  targetMembershipId: id,
  effectiveAt: optionalDate,
  expiresAt: optionalDate,
  expectedMembershipVersion: expectedVersion.optional(),
  idempotencyKey,
}).strict();
const revokeSchema = z.object({
  expectedVersion,
  idempotencyKey,
  reason: z.string().trim().min(1).max(512).optional(),
}).strict();
const createDelegationSchema = z.object({
  targetMembershipId: id,
  permissionKeys,
  expiresAt: z.string().datetime({ offset: true }),
  reason: z.string().trim().min(1).max(512),
  idempotencyKey,
}).strict();
const elevatedDecisionSchema = z.object({
  expectedVersion,
  idempotencyKey,
  decisionReason: z.string().trim().min(1).max(512),
}).strict();
const auditQuerySchema = z.object({
  eventType: z.string().trim().min(1).max(128).optional(),
  actorId: id.optional(),
  targetUserId: id.optional(),
  resourceType: z.string().trim().min(1).max(64).optional(),
  from: z.string().datetime({ offset: true }).optional(),
  to: z.string().datetime({ offset: true }).optional(),
  cursor: id.optional(),
  pageSize: z.coerce.number().int().min(1).max(100).optional().default(50),
  permissions: z.string().optional(),
}).strict();

function trustedActor(c) {
  const auth = c.get("authContext") || null;
  if (!auth?.is_authenticated) throw new UnauthenticatedError();
  if (
    auth.actor_type !== "user"
    || !auth.user_id
    || !auth.membership_id
    || !auth.organisation_id
    || !Number.isInteger(auth.authentication_version)
    || !Number.isInteger(auth.authorization_version)
  ) {
    const error = new ForbiddenError("A trusted human membership context is required.");
    error.code = "ACCESS_TRUSTED_HUMAN_CONTEXT_REQUIRED";
    throw error;
  }
  if (auth.organisation?.organisationType !== "medical_scheme") {
    const error = new ForbiddenError("Medical-scheme membership authority is required.");
    error.code = "ACCESS_SCHEME_MEMBERSHIP_REQUIRED";
    throw error;
  }
  return Object.freeze({
    userId: auth.user_id,
    membershipId: auth.membership_id,
    organisationId: auth.organisation_id,
    authenticationVersion: auth.authentication_version,
    authorizationVersion: auth.authorization_version,
    permissions: auth.permissions,
    correlationId: c.get("requestId") || auth.correlation_id || null,
  });
}

function requirePermission(permission) {
  return async (c, next) => {
    try {
      const actor = trustedActor(c);
      if (!hasPermission(c.get("authContext"), permission)) throw new ForbiddenError();
      c.set("accessActor", actor);
      await next();
    } catch (error) {
      return applicationErrorResponse(c, error);
    }
  };
}

function requireHuman() {
  return async (c, next) => {
    try {
      c.set("accessActor", trustedActor(c));
      await next();
    } catch (error) {
      return applicationErrorResponse(c, error);
    }
  };
}

async function strictJson(c, schema) {
  const body = await c.req.json().catch(() => null);
  const result = schema.safeParse(body);
  if (!result.success) {
    const error = new Error("The request body is invalid.");
    error.status = 400;
    error.code = "ACCESS_INVALID_REQUEST";
    error.details = result.error.issues.map((issue) => ({ path: issue.path.join("."), code: issue.code }));
    throw error;
  }
  return result.data;
}

function strictQuery(c, schema) {
  const result = schema.safeParse(c.req.query());
  if (!result.success) {
    const error = new Error("The request query is invalid.");
    error.status = 400;
    error.code = "ACCESS_INVALID_REQUEST";
    error.details = result.error.issues.map((issue) => ({ path: issue.path.join("."), code: issue.code }));
    throw error;
  }
  return result.data;
}

function safeError(c, error) {
  if (Number.isInteger(error?.status) && typeof error?.code === "string") {
    return c.json({
      available: false,
      code: error.code,
      message: error.message || "The access operation failed.",
      ...(error.details ? { details: error.details } : {}),
    }, error.status);
  }
  if (error instanceof TypeError) {
    return c.json({ available: false, code: "ACCESS_INVALID_REQUEST", message: error.message }, 400);
  }
  return c.json({
    available: false,
    code: "ACCESS_OPERATION_FAILED",
    message: "The access operation could not be completed.",
  }, 500);
}

function notFound(c, code = "ACCESS_RESOURCE_NOT_FOUND") {
  return c.json({ available: false, code, message: "The access resource was not found." }, 404);
}

function ensureCurrentVersion(resource, suppliedVersion) {
  if (!resource) return false;
  if (resource.version !== suppliedVersion) {
    const error = new Error("The access resource was modified by another operation.");
    error.status = 409;
    error.code = ACCESS_ERROR_CODE.VERSION_CONFLICT;
    error.details = { expectedVersion: suppliedVersion, actualVersion: resource.version };
    throw error;
  }
  return true;
}

function accessCapabilities(authContext) {
  return Object.fromEntries(Object.entries(ACCESS_PERMISSIONS).map(([name, permission]) => [
    name.toLowerCase(),
    hasPermission(authContext, permission),
  ]));
}

function ensureCanonicalPermissions(keys) {
  const { unknown } = validatePermissionKeys(keys);
  if (unknown.length > 0) {
    const error = new Error("One or more permission keys are not canonical.");
    error.status = 400;
    error.code = "ACCESS_PERMISSION_UNKNOWN";
    error.details = { permissionKeys: unknown };
    throw error;
  }
}

function ensureNoUnapprovedElevatedPermissions(keys) {
  const elevated = keys.filter((key) => isElevatedPermission(key));
  if (elevated.length > 0) {
    const error = new Error("Elevated permissions require an independently reviewed request.");
    error.status = 422;
    error.code = ACCESS_ERROR_CODE.ELEVATED_APPROVAL_REQUIRED;
    error.details = { permissionKeys: elevated };
    throw error;
  }
}

export function registerAccessRoutes(app, { controlPlaneRepositories } = {}) {
  const access = controlPlaneRepositories?.access || null;
  const transact = controlPlaneRepositories?.runInTransaction || null;
  if (!access) return;
  const runMutation = async (operation) => (
    transact ? transact((repositories) => operation(repositories.access)) : operation(access)
  );

  app.get("/api/v1/access/permissions", requirePermission(ACCESS_PERMISSIONS.ROLES_READ), async (c) => c.json({
    available: true,
    permissions: PERMISSION_CATALOGUE.map((entry) => ({ ...entry })),
  }));

  app.get("/api/v1/access/roles", requirePermission(ACCESS_PERMISSIONS.ROLES_READ), async (c) => {
    const actor = c.get("accessActor");
    try { return c.json({ available: true, roles: await access.listRoles({ organisationId: actor.organisationId }) }); }
    catch (error) { return safeError(c, error); }
  });

  app.post("/api/v1/access/roles", requirePermission(ACCESS_PERMISSIONS.ROLES_MANAGE), async (c) => {
    const actor = c.get("accessActor");
    try {
      const input = await strictJson(c, createRoleSchema);
      ensureCanonicalPermissions(input.permissionKeys);
      ensureNoUnapprovedElevatedPermissions(input.permissionKeys);
      const role = await runMutation(async (repository) => {
        const created = await repository.createCustomRole({
          organisationId: actor.organisationId,
          roleKey: input.roleKey,
          displayName: input.displayName,
          description: input.description,
          actorId: actor.userId,
          correlationId: actor.correlationId,
          idempotencyKey: input.idempotencyKey,
        });
        if (input.permissionKeys.length === 0 || created.replayed) return created;
        const permissions = await repository.replaceCustomRolePermissions({
          organisationId: actor.organisationId,
          roleId: created.roleId,
          permissionKeys: input.permissionKeys,
          expectedVersion: 1,
          actorId: actor.userId,
          correlationId: actor.correlationId,
        });
        return { ...created, version: permissions.version, permissionKeys: input.permissionKeys };
      });
      return c.json({ available: true, role }, role.replayed ? 200 : 201);
    } catch (error) { return safeError(c, error); }
  });

  app.get("/api/v1/access/roles/:roleId", requirePermission(ACCESS_PERMISSIONS.ROLES_READ), async (c) => {
    const actor = c.get("accessActor");
    try {
      const role = await access.getRole({ organisationId: actor.organisationId, roleId: c.req.param("roleId") });
      return role ? c.json({ available: true, role }) : notFound(c, ACCESS_ERROR_CODE.ROLE_NOT_FOUND);
    } catch (error) { return safeError(c, error); }
  });

  app.patch("/api/v1/access/roles/:roleId", requirePermission(ACCESS_PERMISSIONS.ROLES_MANAGE), async (c) => {
    const actor = c.get("accessActor");
    try {
      const input = await strictJson(c, updateRoleSchema);
      const result = await runMutation((repository) => repository.updateCustomRoleMetadata({
        organisationId: actor.organisationId,
        roleId: c.req.param("roleId"),
        displayName: input.displayName,
        description: input.description,
        expectedVersion: input.expectedVersion,
        actorId: actor.userId,
        correlationId: actor.correlationId,
      }));
      return c.json({ available: true, role: result });
    } catch (error) { return safeError(c, error); }
  });

  app.post("/api/v1/access/roles/:roleId/permissions", requirePermission(ACCESS_PERMISSIONS.ROLES_MANAGE), async (c) => {
    const actor = c.get("accessActor");
    try {
      const input = await strictJson(c, replacePermissionsSchema);
      ensureCanonicalPermissions(input.permissionKeys);
      ensureNoUnapprovedElevatedPermissions(input.permissionKeys);
      const result = await runMutation((repository) => repository.replaceCustomRolePermissions({
        organisationId: actor.organisationId,
        roleId: c.req.param("roleId"),
        permissionKeys: input.permissionKeys,
        expectedVersion: input.expectedVersion,
        actorId: actor.userId,
        correlationId: actor.correlationId,
        idempotencyKey: input.idempotencyKey,
      }));
      return c.json({ available: true, role: { ...result, permissionKeys: input.permissionKeys } });
    } catch (error) { return safeError(c, error); }
  });

  app.post("/api/v1/access/roles/:roleId/disable", requirePermission(ACCESS_PERMISSIONS.ROLES_MANAGE), async (c) => {
    const actor = c.get("accessActor");
    try {
      const input = await strictJson(c, disableRoleSchema);
      const result = await runMutation((repository) => repository.disableCustomRole({
        organisationId: actor.organisationId,
        roleId: c.req.param("roleId"),
        expectedVersion: input.expectedVersion,
        actorId: actor.userId,
        correlationId: actor.correlationId,
        idempotencyKey: input.idempotencyKey,
      }));
      return c.json({ available: true, role: result });
    } catch (error) { return safeError(c, error); }
  });

  app.get("/api/v1/access/assignments", requirePermission(ACCESS_PERMISSIONS.ASSIGNMENTS_READ), async (c) => {
    const actor = c.get("accessActor");
    try { return c.json({ available: true, assignments: await access.listAssignments({ organisationId: actor.organisationId }) }); }
    catch (error) { return safeError(c, error); }
  });

  app.post("/api/v1/access/assignments", requirePermission(ACCESS_PERMISSIONS.ASSIGNMENTS_MANAGE), async (c) => {
    const actor = c.get("accessActor");
    try {
      const input = await strictJson(c, createAssignmentSchema);
      const target = await access.getMembership({ organisationId: actor.organisationId, membershipId: input.targetMembershipId });
      if (!target) return notFound(c);
      if (input.expectedMembershipVersion !== undefined) {
        ensureCurrentVersion({ version: target.authorizationVersion }, input.expectedMembershipVersion);
      }
      const result = await runMutation((repository) => repository.createRoleAssignment({
        organisationId: actor.organisationId,
        membershipId: target.membershipId,
        subjectUserId: target.userId,
        roleId: input.roleId,
        effectiveFrom: input.effectiveAt ? new Date(input.effectiveAt) : null,
        expiresAt: input.expiresAt ? new Date(input.expiresAt) : null,
        actorId: actor.userId,
        correlationId: actor.correlationId,
        idempotencyKey: input.idempotencyKey,
      }));
      return c.json({ available: true, assignment: result }, result.replayed ? 200 : 201);
    } catch (error) { return safeError(c, error); }
  });

  app.post("/api/v1/access/assignments/:assignmentId/revoke", requirePermission(ACCESS_PERMISSIONS.ASSIGNMENTS_MANAGE), async (c) => {
    const actor = c.get("accessActor");
    try {
      const input = await strictJson(c, revokeSchema);
      const assignmentId = c.req.param("assignmentId");
      const current = await access.getAssignment({ organisationId: actor.organisationId, assignmentId });
      if (!current) return notFound(c, ACCESS_ERROR_CODE.ASSIGNMENT_NOT_FOUND);
      ensureCurrentVersion(current, input.expectedVersion);
      const result = await runMutation((repository) => repository.revokeRoleAssignment({
        organisationId: actor.organisationId,
        assignmentId,
        reason: input.reason,
        actorId: actor.userId,
        correlationId: actor.correlationId,
        idempotencyKey: input.idempotencyKey,
        expectedVersion: input.expectedVersion,
      }));
      return c.json({ available: true, assignment: result });
    } catch (error) { return safeError(c, error); }
  });

  app.get("/api/v1/access/delegations", requirePermission(ACCESS_PERMISSIONS.DELEGATIONS_READ), async (c) => {
    const actor = c.get("accessActor");
    try { return c.json({ available: true, delegations: await access.listDelegations({ organisationId: actor.organisationId }) }); }
    catch (error) { return safeError(c, error); }
  });

  app.post("/api/v1/access/delegations", requirePermission(ACCESS_PERMISSIONS.DELEGATIONS_GRANT), async (c) => {
    const actor = c.get("accessActor");
    try {
      const input = await strictJson(c, createDelegationSchema);
      ensureCanonicalPermissions(input.permissionKeys);
      const target = await access.getMembership({ organisationId: actor.organisationId, membershipId: input.targetMembershipId });
      if (!target) return notFound(c);
      const result = await runMutation((repository) => repository.createDelegation({
        organisationId: actor.organisationId,
        grantorUserId: actor.userId,
        granteeUserId: target.userId,
        permissionKeys: input.permissionKeys,
        expiresAt: new Date(input.expiresAt),
        reason: input.reason,
        actorId: actor.userId,
        correlationId: actor.correlationId,
        idempotencyKey: input.idempotencyKey,
      }));
      return c.json({ available: true, delegation: result }, result.replayed ? 200 : 201);
    } catch (error) { return safeError(c, error); }
  });

  app.post("/api/v1/access/delegations/:delegationId/revoke", requirePermission(ACCESS_PERMISSIONS.DELEGATIONS_REVOKE), async (c) => {
    const actor = c.get("accessActor");
    try {
      const input = await strictJson(c, revokeSchema);
      const delegationId = c.req.param("delegationId");
      const current = await access.getDelegation({ organisationId: actor.organisationId, delegationId });
      if (!current) return notFound(c, ACCESS_ERROR_CODE.DELEGATION_NOT_FOUND);
      ensureCurrentVersion(current, input.expectedVersion);
      const result = await runMutation((repository) => repository.revokeDelegation({
        organisationId: actor.organisationId,
        delegationId,
        reason: input.reason,
        actorId: actor.userId,
        correlationId: actor.correlationId,
        idempotencyKey: input.idempotencyKey,
        expectedVersion: input.expectedVersion,
      }));
      return c.json({ available: true, delegation: result });
    } catch (error) { return safeError(c, error); }
  });

  app.get("/api/v1/access/elevated-requests", requirePermission(ACCESS_PERMISSIONS.ELEVATED_REVIEW), async (c) => {
    const actor = c.get("accessActor");
    try { return c.json({ available: true, requests: await access.listElevatedRequests({ organisationId: actor.organisationId }) }); }
    catch (error) { return safeError(c, error); }
  });

  for (const decision of ["approve", "reject"]) {
    app.post(`/api/v1/access/elevated-requests/:requestId/${decision}`, requirePermission(ACCESS_PERMISSIONS.ELEVATED_REVIEW), async (c) => {
      const actor = c.get("accessActor");
      try {
        const input = await strictJson(c, elevatedDecisionSchema);
        const requestId = c.req.param("requestId");
        const current = await access.getElevatedRequest({ organisationId: actor.organisationId, requestId });
        if (!current) return notFound(c, ACCESS_ERROR_CODE.ELEVATED_REQUEST_NOT_FOUND);
        ensureCurrentVersion(current, input.expectedVersion);
        const method = decision === "approve" ? "approveElevatedRequest" : "rejectElevatedRequest";
        const result = await runMutation((repository) => repository[method]({
          organisationId: actor.organisationId,
          requestId,
          reviewedBy: actor.userId,
          reason: input.decisionReason,
          correlationId: actor.correlationId,
          idempotencyKey: input.idempotencyKey,
          expectedVersion: input.expectedVersion,
        }));
        return c.json({ available: true, request: result });
      } catch (error) { return safeError(c, error); }
    });
  }

  app.get("/api/v1/access/audit", requirePermission(ACCESS_PERMISSIONS.AUDIT_READ), async (c) => {
    const actor = c.get("accessActor");
    try {
      const query = strictQuery(c, auditQuerySchema);
      const { permissions: ignoredPermissions, ...filters } = query;
      void ignoredPermissions;
      return c.json({ available: true, ...await access.listAudit({ organisationId: actor.organisationId, ...filters }) });
    } catch (error) { return safeError(c, error); }
  });

  app.get("/api/v1/access/me", requireHuman(), async (c) => {
    const actor = c.get("accessActor");
    try {
      const summary = await access.explainUserAccess({ organisationId: actor.organisationId, userId: actor.userId });
      if (!summary || summary.membershipId !== actor.membershipId) return notFound(c);
      return c.json({
        available: true,
        access: {
          ...summary,
          authenticationVersion: actor.authenticationVersion,
          capabilities: accessCapabilities(c.get("authContext")),
        },
      });
    } catch (error) { return safeError(c, error); }
  });

  app.get("/api/v1/access/users/:userId", requirePermission(ACCESS_PERMISSIONS.ROLES_READ), async (c) => {
    const actor = c.get("accessActor");
    try {
      const summary = await access.explainUserAccess({ organisationId: actor.organisationId, userId: c.req.param("userId") });
      return summary ? c.json({ available: true, access: summary }) : notFound(c);
    } catch (error) { return safeError(c, error); }
  });
}
