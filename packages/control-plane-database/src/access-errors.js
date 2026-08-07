/**
 * Sequrin Access Domain Errors
 *
 * Bounded, stable error codes for the access control system. These errors follow
 * the existing ControlPlaneError hierarchy established in errors.js.
 *
 * Each error code corresponds to a specific, documented failure mode.
 * Unrelated database failures are never converted into version conflicts.
 */

import { ControlPlaneError } from "./errors.js";

export class AccessError extends ControlPlaneError {
  constructor(message, { code, status = 400, details = null } = {}) {
    super(message, { code, status, details });
  }
}

export class AccessNotFoundError extends AccessError {
  constructor(message, code, details = null) {
    super(message, { code, status: 404, details });
  }
}

export class AccessConflictError extends AccessError {
  constructor(message, code, details = null) {
    super(message, { code, status: 409, details });
  }
}

export class AccessForbiddenError extends AccessError {
  constructor(message, code, details = null) {
    super(message, { code, status: 403, details });
  }
}

// --- Stable error codes ---

export const ACCESS_ERROR_CODE = Object.freeze({
  ROLE_NOT_FOUND: "ACCESS_ROLE_NOT_FOUND",
  ROLE_KEY_CONFLICT: "ACCESS_ROLE_KEY_CONFLICT",
  SYSTEM_ROLE_IMMUTABLE: "ACCESS_SYSTEM_ROLE_IMMUTABLE",
  PERMISSION_UNKNOWN: "ACCESS_PERMISSION_UNKNOWN",
  PERMISSION_NOT_ASSIGNABLE: "ACCESS_PERMISSION_NOT_ASSIGNABLE",
  PERMISSION_NOT_DELEGABLE: "ACCESS_PERMISSION_NOT_DELEGABLE",
  VERSION_CONFLICT: "ACCESS_VERSION_CONFLICT",
  ASSIGNMENT_NOT_FOUND: "ACCESS_ASSIGNMENT_NOT_FOUND",
  ASSIGNMENT_INACTIVE: "ACCESS_ASSIGNMENT_INACTIVE",
  ASSIGNMENT_LINKAGE_MISMATCH: "ACCESS_ASSIGNMENT_LINKAGE_MISMATCH",
  DELEGATION_NOT_FOUND: "ACCESS_DELEGATION_NOT_FOUND",
  DELEGATION_SELF_FORBIDDEN: "ACCESS_DELEGATION_SELF_FORBIDDEN",
  DELEGATION_AUTHORITY_MISSING: "ACCESS_DELEGATION_AUTHORITY_MISSING",
  DELEGATION_EXPIRY_INVALID: "ACCESS_DELEGATION_EXPIRY_INVALID",
  DELEGATION_CROSS_TENANT: "ACCESS_DELEGATION_CROSS_TENANT",
  ELEVATED_APPROVAL_REQUIRED: "ACCESS_ELEVATED_APPROVAL_REQUIRED",
  ELEVATED_REVIEWER_NOT_INDEPENDENT: "ACCESS_ELEVATED_REVIEWER_NOT_INDEPENDENT",
  ELEVATED_REQUEST_NOT_FOUND: "ACCESS_ELEVATED_REQUEST_NOT_FOUND",
  ELEVATED_ALREADY_DECIDED: "ACCESS_ELEVATED_ALREADY_DECIDED",
  IDEMPOTENCY_CONFLICT: "ACCESS_IDEMPOTENCY_CONFLICT",
  AUTHORIZATION_VERSION_STALE: "ACCESS_AUTHORIZATION_VERSION_STALE",
  TENANT_MISMATCH: "ACCESS_TENANT_MISMATCH",
  ROLE_DISABLED: "ACCESS_ROLE_DISABLED",
});

// --- Factory helpers ---

export function roleNotFound(roleId) {
  return new AccessNotFoundError(
    "The role was not found.",
    ACCESS_ERROR_CODE.ROLE_NOT_FOUND,
    { roleId },
  );
}

export function roleKeyConflict(organisationId, roleKey) {
  return new AccessConflictError(
    "A role with this key already exists in the tenant.",
    ACCESS_ERROR_CODE.ROLE_KEY_CONFLICT,
    { organisationId, roleKey },
  );
}

export function systemRoleImmutable(roleId) {
  return new AccessForbiddenError(
    "System roles cannot be modified.",
    ACCESS_ERROR_CODE.SYSTEM_ROLE_IMMUTABLE,
    { roleId },
  );
}

export function permissionUnknown(permissionKeys) {
  return new AccessError(
    "One or more permission keys are not in the canonical catalogue.",
    { code: ACCESS_ERROR_CODE.PERMISSION_UNKNOWN, status: 400, details: { permissionKeys } },
  );
}

export function permissionNotAssignable(permissionKeys) {
  return new AccessForbiddenError(
    "One or more permissions cannot be assigned to tenant roles.",
    ACCESS_ERROR_CODE.PERMISSION_NOT_ASSIGNABLE,
    { permissionKeys },
  );
}

export function permissionNotDelegable(permissionKeys) {
  return new AccessForbiddenError(
    "One or more permissions cannot be delegated.",
    ACCESS_ERROR_CODE.PERMISSION_NOT_DELEGABLE,
    { permissionKeys },
  );
}

export function versionConflict(entityType, entityId, expected, actual) {
  return new AccessConflictError(
    `The ${entityType} was modified by another operation.`,
    ACCESS_ERROR_CODE.VERSION_CONFLICT,
    { entityType, entityId, expectedVersion: expected, actualVersion: actual },
  );
}

export function assignmentNotFound(assignmentId) {
  return new AccessNotFoundError(
    "The assignment was not found.",
    ACCESS_ERROR_CODE.ASSIGNMENT_NOT_FOUND,
    { assignmentId },
  );
}

export function assignmentInactive(assignmentId) {
  return new AccessConflictError(
    "The assignment is not active.",
    ACCESS_ERROR_CODE.ASSIGNMENT_INACTIVE,
    { assignmentId },
  );
}

export function assignmentLinkageMismatch(details) {
  return new AccessError(
    "The assignment subject, membership and organisation do not match.",
    { code: ACCESS_ERROR_CODE.ASSIGNMENT_LINKAGE_MISMATCH, status: 400, details },
  );
}

export function delegationNotFound(delegationId) {
  return new AccessNotFoundError(
    "The delegation was not found.",
    ACCESS_ERROR_CODE.DELEGATION_NOT_FOUND,
    { delegationId },
  );
}

export function delegationSelfForbidden() {
  return new AccessForbiddenError(
    "A user cannot delegate permissions to themselves.",
    ACCESS_ERROR_CODE.DELEGATION_SELF_FORBIDDEN,
  );
}

export function delegationAuthorityMissing(missingPermissions) {
  return new AccessForbiddenError(
    "The grantor does not currently hold one or more delegated permissions.",
    ACCESS_ERROR_CODE.DELEGATION_AUTHORITY_MISSING,
    { missingPermissions },
  );
}

export function delegationExpiryInvalid(reason) {
  return new AccessError(
    `Delegation expiry is invalid: ${reason}.`,
    { code: ACCESS_ERROR_CODE.DELEGATION_EXPIRY_INVALID, status: 400, details: { reason } },
  );
}

export function delegationCrossTenant() {
  return new AccessForbiddenError(
    "Cross-tenant delegation is prohibited.",
    ACCESS_ERROR_CODE.DELEGATION_CROSS_TENANT,
  );
}

export function elevatedApprovalRequired(permissionKeys) {
  return new AccessError(
    "One or more permissions require elevated approval before they contribute authority.",
    { code: ACCESS_ERROR_CODE.ELEVATED_APPROVAL_REQUIRED, status: 422, details: { permissionKeys } },
  );
}

export function elevatedReviewerNotIndependent(reason) {
  return new AccessForbiddenError(
    `The reviewer is not independent: ${reason}.`,
    ACCESS_ERROR_CODE.ELEVATED_REVIEWER_NOT_INDEPENDENT,
    { reason },
  );
}

export function elevatedRequestNotFound(requestId) {
  return new AccessNotFoundError(
    "The elevated request was not found.",
    ACCESS_ERROR_CODE.ELEVATED_REQUEST_NOT_FOUND,
    { requestId },
  );
}

export function elevatedAlreadyDecided(requestId, decision) {
  return new AccessConflictError(
    "The elevated request has already been decided.",
    ACCESS_ERROR_CODE.ELEVATED_ALREADY_DECIDED,
    { requestId, decision },
  );
}

export function idempotencyConflict(operationType, idempotencyKey) {
  return new AccessConflictError(
    "An operation with the same idempotency key but different intent already exists.",
    ACCESS_ERROR_CODE.IDEMPOTENCY_CONFLICT,
    { operationType, idempotencyKey },
  );
}

export function authorizationVersionStale(membershipId, sessionVersion, currentVersion) {
  return new AccessConflictError(
    "The session authorization version is stale.",
    ACCESS_ERROR_CODE.AUTHORIZATION_VERSION_STALE,
    { membershipId, sessionVersion, currentVersion },
  );
}

export function tenantMismatch(expected, actual) {
  return new AccessForbiddenError(
    "The operation crosses tenant boundaries.",
    ACCESS_ERROR_CODE.TENANT_MISMATCH,
    { expected, actual },
  );
}

export function roleDisabled(roleId) {
  return new AccessConflictError(
    "The role is disabled and cannot be used for new assignments.",
    ACCESS_ERROR_CODE.ROLE_DISABLED,
    { roleId },
  );
}
