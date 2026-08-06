/**
 * Sequrin Transactional Access Repository
 *
 * This repository provides focused, tenant-scoped commands for custom role management,
 * assignment lifecycle, bounded delegation, elevated approval, effective-permission
 * resolution, and authorization-version invalidation.
 *
 * Compatibility model:
 * - Existing system-role tables (roles, role_aliases, role_permissions, membership_roles)
 *   remain immutable compatibility sources.
 * - Custom role definitions live in the PR 3 tenant-scoped access_role_definitions table.
 * - One resolver combines system-role and PR 3 sources through the canonical permission catalogue.
 * - All sources resolve through PERMISSION_KEYS; role names and aliases never authorize directly.
 *
 * Every command:
 * - Derives or requires an already trusted tenant context.
 * - Verifies tenant linkage.
 * - Requires expected versions for updates.
 * - Uses stable domain errors.
 * - Uses idempotency where duplicate effects are possible.
 * - Writes audit evidence.
 * - Advances relevant authorization versions.
 * - Commits atomically.
 * - Rolls back fully on failure.
 */

import crypto from "node:crypto";

import {
  isKnownPermission,
  isTenantAssignable,
  isElevatedPermission,
  isDelegablePermission,
  validatePermissionKeys,
  MAX_DELEGATION_HOURS,
} from "./permission-catalogue.js";
import {
  ACCESS_ERROR_CODE,
  roleNotFound,
  roleKeyConflict,
  systemRoleImmutable,
  permissionUnknown,
  permissionNotAssignable,
  permissionNotDelegable,
  versionConflict,
  assignmentNotFound,
  assignmentInactive,
  assignmentLinkageMismatch,
  delegationNotFound,
  delegationSelfForbidden,
  delegationAuthorityMissing,
  delegationExpiryInvalid,
  delegationCrossTenant,
  elevatedApprovalRequired,
  elevatedReviewerNotIndependent,
  elevatedRequestNotFound,
  elevatedAlreadyDecided,
  idempotencyConflict,
  roleDisabled,
  tenantMismatch,
} from "./access-errors.js";
import { executorOr } from "./transaction.js";

function uuid() {
  return crypto.randomUUID();
}

function intentHash(data) {
  return crypto.createHash("sha256").update(JSON.stringify(data)).digest("hex");
}

function assertRequiredString(value, fieldName, maxLength = 255) {
  if (typeof value !== "string" || !value.trim()) {
    throw new TypeError(`${fieldName} is required and must be a non-empty string.`);
  }
  const trimmed = value.trim();
  if (trimmed.length > maxLength) {
    throw new TypeError(`${fieldName} must be at most ${maxLength} characters.`);
  }
  return trimmed;
}

function assertPositiveInt(value, fieldName) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new TypeError(`${fieldName} must be a positive integer.`);
  }
  return parsed;
}

function nowTimestamp() {
  return new Date();
}

// --- Audit writer (append-only, no update/delete exposed) ---

async function writeAuditEvent(executor, {
  organisationId, actorType, actorId, subjectId = null, action,
  targetType, targetId, beforeVersion = null, afterVersion = null,
  reason = null, correlationId, operationId, outcome = "success",
}) {
  const auditEventId = uuid();
  await executor.execute(
    `INSERT INTO access_audit_events
      (audit_event_id, organisation_id, actor_type, actor_id, subject_id, action,
       target_type, target_id, before_version, after_version, reason,
       correlation_id, operation_id, outcome)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [auditEventId, organisationId, actorType, actorId, subjectId, action,
      targetType, targetId, beforeVersion, afterVersion, reason,
      correlationId, operationId, outcome],
  );
  return auditEventId;
}

// --- Authorization version advancement ---

async function advanceAuthorizationVersion(executor, membershipId) {
  const [result] = await executor.execute(
    `UPDATE organisation_memberships
     SET authorization_version = authorization_version + 1
     WHERE membership_id = ?`,
    [membershipId],
  );
  if (result.affectedRows === 0) {
    throw new TypeError(`Membership ${membershipId} not found for authorization version advancement.`);
  }
}

async function advanceAuthorizationVersionForUser(executor, organisationId, subjectUserId) {
  await executor.execute(
    `UPDATE organisation_memberships
     SET authorization_version = authorization_version + 1
     WHERE organisation_id = ? AND user_id = ? AND status = 'active'`,
    [organisationId, subjectUserId],
  );
}

// --- Idempotency ---

async function checkOrRecordOperation(executor, { organisationId, operationType, idempotencyKey, intentData, resultData }) {
  const hash = intentHash(intentData);
  try {
    const operationId = uuid();
    await executor.execute(
      `INSERT INTO access_authorization_operations
        (operation_id, organisation_id, operation_type, idempotency_key, intent_hash, result_json)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [operationId, organisationId, operationType, idempotencyKey, hash, JSON.stringify(resultData)],
    );
    return { isNew: true, operationId, result: resultData };
  } catch (error) {
    if (error?.code === "ER_DUP_ENTRY" || error?.errno === 1062) {
      const [rows] = await executor.execute(
        `SELECT operation_id, intent_hash, result_json FROM access_authorization_operations
         WHERE organisation_id = ? AND operation_type = ? AND idempotency_key = ?`,
        [organisationId, operationType, idempotencyKey],
      );
      if (rows?.length > 0 && rows[0].intent_hash !== hash) {
        throw idempotencyConflict(operationType, idempotencyKey);
      }
      const existing = rows?.[0];
      return {
        isNew: false,
        operationId: existing?.operation_id,
        result: existing?.result_json ? JSON.parse(existing.result_json) : resultData,
      };
    }
    throw error;
  }
}

// --- Membership linkage verification ---

async function verifyMembershipLinkage(executor, { organisationId, membershipId, subjectUserId }) {
  const [rows] = await executor.execute(
    `SELECT membership_id, user_id, organisation_id, status
     FROM organisation_memberships
     WHERE membership_id = ? LIMIT 1`,
    [membershipId],
  );
  const membership = rows?.[0];
  if (!membership) {
    throw assignmentLinkageMismatch({ reason: "membership_not_found", membershipId });
  }
  if (membership.organisation_id !== organisationId) {
    throw assignmentLinkageMismatch({ reason: "organisation_mismatch", membershipId, expected: organisationId, actual: membership.organisation_id });
  }
  if (membership.user_id !== subjectUserId) {
    throw assignmentLinkageMismatch({ reason: "user_mismatch", membershipId, expected: subjectUserId, actual: membership.user_id });
  }
  return membership;
}

// --- Internal resolver helpers ---

async function resolveSystemRolePermissions(db, membershipId) {
  const [rows] = await db.execute(
    `SELECT DISTINCT p.permission_key, r.role_key
     FROM membership_roles mr
     JOIN roles r ON r.role_id = mr.role_id
     JOIN role_permissions rp ON rp.role_id = mr.role_id
     JOIN permissions p ON p.permission_id = rp.permission_id
     WHERE mr.membership_id = ? AND mr.revoked_at IS NULL`,
    [membershipId],
  );
  return rows || [];
}

async function resolveCustomRolePermissions(db, organisationId, userId, asOfTimestamp) {
  const [rows] = await db.execute(
    `SELECT DISTINCT arp.permission_key, ard.role_key, ara.assignment_id
     FROM access_role_assignments ara
     JOIN access_role_definitions ard ON ard.role_id = ara.role_id AND ard.status = 'active'
     JOIN access_role_permissions arp ON arp.role_id = ara.role_id
     LEFT JOIN access_elevated_requests aer ON aer.request_id = arp.elevated_request_id
     WHERE ara.organisation_id = ?
       AND ara.subject_user_id = ?
       AND ara.status = 'active'
       AND ara.effective_from <= ?
       AND (ara.expires_at IS NULL OR ara.expires_at > ?)
       AND (arp.elevated_request_id IS NULL OR aer.decision = 'approved')`,
    [organisationId, userId, asOfTimestamp, asOfTimestamp],
  );
  return rows || [];
}

// --- Repository factory ---

export function createAccessRepository(defaultExecutor) {
  function exec(explicitExecutor) {
    return executorOr(defaultExecutor, explicitExecutor);
  }

  return {
    // =====================================================================
    // Custom Roles
    // =====================================================================

    async createCustomRole({
      organisationId, roleKey, displayName, description = "", actorId,
      correlationId, idempotencyKey, executor,
    }) {
      organisationId = assertRequiredString(organisationId, "organisationId", 36);
      roleKey = assertRequiredString(roleKey, "roleKey", 64);
      displayName = assertRequiredString(displayName, "displayName", 128);
      actorId = assertRequiredString(actorId, "actorId", 36);
      correlationId = assertRequiredString(correlationId, "correlationId", 128);
      idempotencyKey = assertRequiredString(idempotencyKey, "idempotencyKey", 128);
      const db = exec(executor);

      const roleId = uuid();
      const intentData = { organisationId, roleKey, displayName, description };
      const resultData = { roleId, roleKey, displayName };

      const idempotent = await checkOrRecordOperation(db, {
        organisationId, operationType: "create_custom_role", idempotencyKey, intentData, resultData,
      });
      if (!idempotent.isNew) {
        return { ...idempotent.result, replayed: true, operationId: idempotent.operationId };
      }

      try {
        await db.execute(
          `INSERT INTO access_role_definitions
            (role_id, organisation_id, role_key, display_name, description, role_class, status,
             version, created_by, last_changed_by)
           VALUES (?, ?, ?, ?, ?, 'custom', 'active', 1, ?, ?)`,
          [roleId, organisationId, roleKey, displayName, description, actorId, actorId],
        );
      } catch (error) {
        if (error?.code === "ER_DUP_ENTRY" || error?.errno === 1062) {
          throw roleKeyConflict(organisationId, roleKey);
        }
        throw error;
      }

      await writeAuditEvent(db, {
        organisationId, actorType: "user", actorId, action: "role.created",
        targetType: "access_role", targetId: roleId, afterVersion: 1,
        correlationId, operationId: idempotent.operationId, outcome: "success",
      });

      return { roleId, roleKey, displayName, replayed: false, operationId: idempotent.operationId };
    },

    async updateCustomRoleMetadata({
      organisationId, roleId, displayName, description, expectedVersion, actorId,
      correlationId, executor,
    }) {
      organisationId = assertRequiredString(organisationId, "organisationId", 36);
      roleId = assertRequiredString(roleId, "roleId", 36);
      actorId = assertRequiredString(actorId, "actorId", 36);
      expectedVersion = assertPositiveInt(expectedVersion, "expectedVersion");
      correlationId = assertRequiredString(correlationId, "correlationId", 128);
      const db = exec(executor);

      const [rows] = await db.execute(
        `SELECT role_id, organisation_id, role_class, version, status
         FROM access_role_definitions WHERE role_id = ? LIMIT 1`,
        [roleId],
      );
      const role = rows?.[0];
      if (!role) throw roleNotFound(roleId);
      if (role.organisation_id !== organisationId) throw tenantMismatch(organisationId, role.organisation_id);
      if (role.role_class === "system") throw systemRoleImmutable(roleId);
      if (role.version !== expectedVersion) throw versionConflict("role", roleId, expectedVersion, role.version);

      const newVersion = expectedVersion + 1;
      const updates = [];
      const params = [];
      if (displayName !== undefined) {
        updates.push("display_name = ?");
        params.push(assertRequiredString(displayName, "displayName", 128));
      }
      if (description !== undefined) {
        updates.push("description = ?");
        params.push(typeof description === "string" ? description.slice(0, 512) : "");
      }
      updates.push("version = ?", "last_changed_by = ?", "last_changed_at = CURRENT_TIMESTAMP(3)");
      params.push(newVersion, actorId, roleId, expectedVersion);

      const [result] = await db.execute(
        `UPDATE access_role_definitions SET ${updates.join(", ")} WHERE role_id = ? AND version = ?`,
        params,
      );
      if (result.affectedRows === 0) throw versionConflict("role", roleId, expectedVersion, null);

      await writeAuditEvent(db, {
        organisationId, actorType: "user", actorId, action: "role.metadata_updated",
        targetType: "access_role", targetId: roleId, beforeVersion: expectedVersion, afterVersion: newVersion,
        correlationId, operationId: uuid(), outcome: "success",
      });

      return { roleId, version: newVersion };
    },

    async replaceCustomRolePermissions({
      organisationId, roleId, permissionKeys, expectedVersion, actorId,
      correlationId, executor,
    }) {
      organisationId = assertRequiredString(organisationId, "organisationId", 36);
      roleId = assertRequiredString(roleId, "roleId", 36);
      actorId = assertRequiredString(actorId, "actorId", 36);
      expectedVersion = assertPositiveInt(expectedVersion, "expectedVersion");
      correlationId = assertRequiredString(correlationId, "correlationId", 128);
      const db = exec(executor);

      const [roleRows] = await db.execute(
        `SELECT role_id, organisation_id, role_class, version, status
         FROM access_role_definitions WHERE role_id = ? LIMIT 1`,
        [roleId],
      );
      const role = roleRows?.[0];
      if (!role) throw roleNotFound(roleId);
      if (role.organisation_id !== organisationId) throw tenantMismatch(organisationId, role.organisation_id);
      if (role.role_class === "system") throw systemRoleImmutable(roleId);
      if (role.version !== expectedVersion) throw versionConflict("role", roleId, expectedVersion, role.version);

      // Validate all permission keys
      const { unknown } = validatePermissionKeys(permissionKeys);
      if (unknown.length > 0) throw permissionUnknown(unknown);

      // Validate tenant assignability
      const notAssignable = permissionKeys.filter((key) => !isTenantAssignable(key));
      if (notAssignable.length > 0) throw permissionNotAssignable(notAssignable);

      // Remove existing permissions and replace
      await db.execute("DELETE FROM access_role_permissions WHERE role_id = ?", [roleId]);

      for (const key of permissionKeys) {
        await db.execute(
          `INSERT INTO access_role_permissions (role_id, permission_key, granted_by)
           VALUES (?, ?, ?)`,
          [roleId, key, actorId],
        );
      }

      // Advance role version
      const newVersion = expectedVersion + 1;
      const [result] = await db.execute(
        `UPDATE access_role_definitions
         SET version = ?, last_changed_by = ?, last_changed_at = CURRENT_TIMESTAMP(3)
         WHERE role_id = ? AND version = ?`,
        [newVersion, actorId, roleId, expectedVersion],
      );
      if (result.affectedRows === 0) throw versionConflict("role", roleId, expectedVersion, null);

      // Advance authorization versions for all affected users
      const [assignmentRows] = await db.execute(
        `SELECT DISTINCT membership_id FROM access_role_assignments
         WHERE role_id = ? AND status = 'active'`,
        [roleId],
      );
      for (const row of assignmentRows || []) {
        await advanceAuthorizationVersion(db, row.membership_id);
      }

      const operationId = uuid();
      await writeAuditEvent(db, {
        organisationId, actorType: "user", actorId, action: "role.permissions_replaced",
        targetType: "access_role", targetId: roleId, beforeVersion: expectedVersion, afterVersion: newVersion,
        correlationId, operationId, outcome: "success",
      });

      return { roleId, version: newVersion, permissionCount: permissionKeys.length, operationId };
    },

    async disableCustomRole({
      organisationId, roleId, expectedVersion, actorId, correlationId, executor,
    }) {
      organisationId = assertRequiredString(organisationId, "organisationId", 36);
      roleId = assertRequiredString(roleId, "roleId", 36);
      actorId = assertRequiredString(actorId, "actorId", 36);
      expectedVersion = assertPositiveInt(expectedVersion, "expectedVersion");
      correlationId = assertRequiredString(correlationId, "correlationId", 128);
      const db = exec(executor);

      const [roleRows] = await db.execute(
        `SELECT role_id, organisation_id, role_class, version, status
         FROM access_role_definitions WHERE role_id = ? LIMIT 1`,
        [roleId],
      );
      const role = roleRows?.[0];
      if (!role) throw roleNotFound(roleId);
      if (role.organisation_id !== organisationId) throw tenantMismatch(organisationId, role.organisation_id);
      if (role.role_class === "system") throw systemRoleImmutable(roleId);
      if (role.version !== expectedVersion) throw versionConflict("role", roleId, expectedVersion, role.version);

      const newVersion = expectedVersion + 1;
      const [result] = await db.execute(
        `UPDATE access_role_definitions
         SET status = 'disabled', version = ?, last_changed_by = ?, last_changed_at = CURRENT_TIMESTAMP(3)
         WHERE role_id = ? AND version = ?`,
        [newVersion, actorId, roleId, expectedVersion],
      );
      if (result.affectedRows === 0) throw versionConflict("role", roleId, expectedVersion, null);

      // Advance authorization versions for affected users
      const [assignmentRows] = await db.execute(
        `SELECT DISTINCT membership_id FROM access_role_assignments
         WHERE role_id = ? AND status = 'active'`,
        [roleId],
      );
      for (const row of assignmentRows || []) {
        await advanceAuthorizationVersion(db, row.membership_id);
      }

      const operationId = uuid();
      await writeAuditEvent(db, {
        organisationId, actorType: "user", actorId, action: "role.disabled",
        targetType: "access_role", targetId: roleId, beforeVersion: expectedVersion, afterVersion: newVersion,
        correlationId, operationId, outcome: "success",
      });

      return { roleId, version: newVersion, operationId };
    },

    async getRole(roleId, { executor } = {}) {
      const [rows] = await exec(executor).execute(
        `SELECT role_id, organisation_id, role_key, display_name, description,
                role_class, status, version, created_by, created_at, last_changed_by, last_changed_at
         FROM access_role_definitions WHERE role_id = ? LIMIT 1`,
        [roleId],
      );
      return rows?.[0] || null;
    },

    // =====================================================================
    // Assignments
    // =====================================================================

    async createRoleAssignment({
      organisationId, membershipId, subjectUserId, roleId, effectiveFrom = null,
      expiresAt = null, actorId, correlationId, idempotencyKey, executor,
    }) {
      organisationId = assertRequiredString(organisationId, "organisationId", 36);
      membershipId = assertRequiredString(membershipId, "membershipId", 36);
      subjectUserId = assertRequiredString(subjectUserId, "subjectUserId", 36);
      roleId = assertRequiredString(roleId, "roleId", 36);
      actorId = assertRequiredString(actorId, "actorId", 36);
      correlationId = assertRequiredString(correlationId, "correlationId", 128);
      idempotencyKey = assertRequiredString(idempotencyKey, "idempotencyKey", 128);
      const db = exec(executor);

      // Verify membership linkage
      await verifyMembershipLinkage(db, { organisationId, membershipId, subjectUserId });

      // Verify role exists, belongs to the same tenant, and is active
      const [roleRows] = await db.execute(
        `SELECT role_id, organisation_id, role_class, status
         FROM access_role_definitions WHERE role_id = ? LIMIT 1`,
        [roleId],
      );
      const role = roleRows?.[0];
      if (!role) throw roleNotFound(roleId);
      if (role.organisation_id !== organisationId) throw tenantMismatch(organisationId, role.organisation_id);
      if (role.status === "disabled") throw roleDisabled(roleId);

      const now = effectiveFrom || nowTimestamp();
      const assignmentId = uuid();
      const intentData = { organisationId, membershipId, subjectUserId, roleId };
      const resultData = { assignmentId };

      const idempotent = await checkOrRecordOperation(db, {
        organisationId, operationType: "create_role_assignment", idempotencyKey, intentData, resultData,
      });
      if (!idempotent.isNew) {
        return { ...idempotent.result, replayed: true, operationId: idempotent.operationId };
      }

      await db.execute(
        `INSERT INTO access_role_assignments
          (assignment_id, organisation_id, membership_id, subject_user_id, role_id,
           effective_from, expires_at, status, version, created_by, idempotency_key, intent_hash)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'active', 1, ?, ?, ?)`,
        [assignmentId, organisationId, membershipId, subjectUserId, roleId,
          now, expiresAt, actorId, idempotencyKey, intentHash(intentData)],
      );

      await advanceAuthorizationVersion(db, membershipId);

      await writeAuditEvent(db, {
        organisationId, actorType: "user", actorId, subjectId: subjectUserId,
        action: "assignment.created", targetType: "access_assignment", targetId: assignmentId,
        afterVersion: 1, correlationId, operationId: idempotent.operationId, outcome: "success",
      });

      return { assignmentId, replayed: false, operationId: idempotent.operationId };
    },

    async revokeRoleAssignment({
      organisationId, assignmentId, reason = null, actorId, correlationId, executor,
    }) {
      organisationId = assertRequiredString(organisationId, "organisationId", 36);
      assignmentId = assertRequiredString(assignmentId, "assignmentId", 36);
      actorId = assertRequiredString(actorId, "actorId", 36);
      correlationId = assertRequiredString(correlationId, "correlationId", 128);
      const db = exec(executor);

      const [rows] = await db.execute(
        `SELECT assignment_id, organisation_id, membership_id, subject_user_id, status, version
         FROM access_role_assignments WHERE assignment_id = ? LIMIT 1`,
        [assignmentId],
      );
      const assignment = rows?.[0];
      if (!assignment) throw assignmentNotFound(assignmentId);
      if (assignment.organisation_id !== organisationId) throw tenantMismatch(organisationId, assignment.organisation_id);
      if (assignment.status !== "active") throw assignmentInactive(assignmentId);

      const newVersion = assignment.version + 1;
      await db.execute(
        `UPDATE access_role_assignments
         SET status = 'revoked', revoked_at = CURRENT_TIMESTAMP(3), revoked_by = ?,
             revoke_reason = ?, version = ?
         WHERE assignment_id = ? AND status = 'active'`,
        [actorId, reason, newVersion, assignmentId],
      );

      await advanceAuthorizationVersion(db, assignment.membership_id);

      const operationId = uuid();
      await writeAuditEvent(db, {
        organisationId, actorType: "user", actorId, subjectId: assignment.subject_user_id,
        action: "assignment.revoked", targetType: "access_assignment", targetId: assignmentId,
        beforeVersion: assignment.version, afterVersion: newVersion, reason,
        correlationId, operationId, outcome: "success",
      });

      return { assignmentId, version: newVersion, operationId };
    },

    // =====================================================================
    // Delegations
    // =====================================================================

    async createDelegation({
      organisationId, grantorUserId, granteeUserId, permissionKeys, effectiveFrom = null,
      expiresAt, reason, actorId, correlationId, idempotencyKey,
      grantorEffectivePermissions = null, executor,
    }) {
      organisationId = assertRequiredString(organisationId, "organisationId", 36);
      grantorUserId = assertRequiredString(grantorUserId, "grantorUserId", 36);
      granteeUserId = assertRequiredString(granteeUserId, "granteeUserId", 36);
      actorId = assertRequiredString(actorId, "actorId", 36);
      reason = assertRequiredString(reason, "reason", 512);
      correlationId = assertRequiredString(correlationId, "correlationId", 128);
      idempotencyKey = assertRequiredString(idempotencyKey, "idempotencyKey", 128);
      const db = exec(executor);

      // Self-delegation check
      if (grantorUserId === granteeUserId) throw delegationSelfForbidden();

      // Validate all permission keys
      const { unknown } = validatePermissionKeys(permissionKeys);
      if (unknown.length > 0) throw permissionUnknown(unknown);

      // Validate delegability
      const notDelegable = permissionKeys.filter((key) => !isDelegablePermission(key));
      if (notDelegable.length > 0) throw permissionNotDelegable(notDelegable);

      // Validate expiry
      if (!expiresAt) throw delegationExpiryInvalid("expiry is mandatory");
      const now = effectiveFrom || nowTimestamp();
      const effectiveDate = now instanceof Date ? now : new Date(now);
      const expiryDate = expiresAt instanceof Date ? expiresAt : new Date(expiresAt);
      if (expiryDate <= effectiveDate) throw delegationExpiryInvalid("expires_at must be after effective_from");
      const hoursUntilExpiry = (expiryDate - effectiveDate) / (1000 * 60 * 60);
      if (hoursUntilExpiry > MAX_DELEGATION_HOURS) {
        throw delegationExpiryInvalid(`duration exceeds maximum of ${MAX_DELEGATION_HOURS} hours`);
      }

      // Verify grantor authority (if provided)
      if (grantorEffectivePermissions) {
        const grantorPermSet = grantorEffectivePermissions instanceof Set
          ? grantorEffectivePermissions
          : new Set(grantorEffectivePermissions);
        const missing = permissionKeys.filter((key) => !grantorPermSet.has(key));
        if (missing.length > 0) throw delegationAuthorityMissing(missing);
      }

      const delegationId = uuid();
      const intentData = { organisationId, grantorUserId, granteeUserId, permissionKeys: [...permissionKeys].sort() };
      const resultData = { delegationId };

      const idempotent = await checkOrRecordOperation(db, {
        organisationId, operationType: "create_delegation", idempotencyKey, intentData, resultData,
      });
      if (!idempotent.isNew) {
        return { ...idempotent.result, replayed: true, operationId: idempotent.operationId };
      }

      await db.execute(
        `INSERT INTO access_delegations
          (delegation_id, organisation_id, grantor_user_id, grantee_user_id,
           permissions_json, effective_from, expires_at, reason,
           status, version, created_by, idempotency_key, intent_hash)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', 1, ?, ?, ?)`,
        [delegationId, organisationId, grantorUserId, granteeUserId,
          JSON.stringify(permissionKeys), now, expiresAt, reason,
          actorId, idempotencyKey, intentHash(intentData)],
      );

      // Insert normalized delegation permission rows
      for (const key of permissionKeys) {
        await db.execute(
          `INSERT INTO access_delegation_permissions (delegation_id, permission_key) VALUES (?, ?)`,
          [delegationId, key],
        );
      }

      // Advance authorization version for the grantee
      await advanceAuthorizationVersionForUser(db, organisationId, granteeUserId);

      await writeAuditEvent(db, {
        organisationId, actorType: "user", actorId, subjectId: granteeUserId,
        action: "delegation.created", targetType: "access_delegation", targetId: delegationId,
        afterVersion: 1, reason, correlationId, operationId: idempotent.operationId, outcome: "success",
      });

      return { delegationId, replayed: false, operationId: idempotent.operationId };
    },

    async revokeDelegation({
      organisationId, delegationId, reason = null, actorId, correlationId, executor,
    }) {
      organisationId = assertRequiredString(organisationId, "organisationId", 36);
      delegationId = assertRequiredString(delegationId, "delegationId", 36);
      actorId = assertRequiredString(actorId, "actorId", 36);
      correlationId = assertRequiredString(correlationId, "correlationId", 128);
      const db = exec(executor);

      const [rows] = await db.execute(
        `SELECT delegation_id, organisation_id, grantee_user_id, status, version
         FROM access_delegations WHERE delegation_id = ? LIMIT 1`,
        [delegationId],
      );
      const delegation = rows?.[0];
      if (!delegation) throw delegationNotFound(delegationId);
      if (delegation.organisation_id !== organisationId) throw tenantMismatch(organisationId, delegation.organisation_id);
      if (delegation.status !== "active") {
        return { delegationId, alreadyRevoked: true };
      }

      const newVersion = delegation.version + 1;
      await db.execute(
        `UPDATE access_delegations
         SET status = 'revoked', revoked_at = CURRENT_TIMESTAMP(3), revoked_by = ?,
             revoke_reason = ?, version = ?
         WHERE delegation_id = ? AND status = 'active'`,
        [actorId, reason, newVersion, delegationId],
      );

      await advanceAuthorizationVersionForUser(db, organisationId, delegation.grantee_user_id);

      const operationId = uuid();
      await writeAuditEvent(db, {
        organisationId, actorType: "user", actorId, subjectId: delegation.grantee_user_id,
        action: "delegation.revoked", targetType: "access_delegation", targetId: delegationId,
        beforeVersion: delegation.version, afterVersion: newVersion, reason,
        correlationId, operationId, outcome: "success",
      });

      return { delegationId, version: newVersion, operationId };
    },

    // =====================================================================
    // Elevated Approval
    // =====================================================================

    async createElevatedRequest({
      organisationId, targetType, targetId, requestedPermissions, requestedBy,
      targetUserId = null, reason, correlationId, executor,
    }) {
      organisationId = assertRequiredString(organisationId, "organisationId", 36);
      targetType = assertRequiredString(targetType, "targetType", 24);
      targetId = assertRequiredString(targetId, "targetId", 36);
      requestedBy = assertRequiredString(requestedBy, "requestedBy", 36);
      reason = assertRequiredString(reason, "reason", 512);
      correlationId = assertRequiredString(correlationId, "correlationId", 128);
      const db = exec(executor);

      const requestId = uuid();
      const hash = intentHash({ targetType, targetId, requestedPermissions });

      try {
        await db.execute(
          `INSERT INTO access_elevated_requests
            (request_id, organisation_id, target_type, target_id, requested_permissions,
             requested_by, target_user_id, reason, decision, version, intent_hash)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', 1, ?)`,
          [requestId, organisationId, targetType, targetId,
            JSON.stringify(requestedPermissions), requestedBy, targetUserId, reason, hash],
        );
      } catch (error) {
        if (error?.code === "ER_DUP_ENTRY" || error?.errno === 1062) {
          // Return existing pending request
          const [existing] = await db.execute(
            `SELECT request_id, decision FROM access_elevated_requests
             WHERE organisation_id = ? AND target_type = ? AND target_id = ? AND intent_hash = ?`,
            [organisationId, targetType, targetId, hash],
          );
          if (existing?.length > 0) {
            return { requestId: existing[0].request_id, decision: existing[0].decision, replayed: true };
          }
        }
        throw error;
      }

      const operationId = uuid();
      await writeAuditEvent(db, {
        organisationId, actorType: "user", actorId: requestedBy, subjectId: targetUserId,
        action: "elevated_request.created", targetType: "access_elevated_request", targetId: requestId,
        afterVersion: 1, reason, correlationId, operationId, outcome: "success",
      });

      return { requestId, decision: "pending", replayed: false, operationId };
    },

    async approveElevatedRequest({
      organisationId, requestId, reviewedBy, reason = null, correlationId, executor,
    }) {
      organisationId = assertRequiredString(organisationId, "organisationId", 36);
      requestId = assertRequiredString(requestId, "requestId", 36);
      reviewedBy = assertRequiredString(reviewedBy, "reviewedBy", 36);
      correlationId = assertRequiredString(correlationId, "correlationId", 128);
      const db = exec(executor);

      const [rows] = await db.execute(
        `SELECT request_id, organisation_id, requested_by, target_user_id, decision, version
         FROM access_elevated_requests WHERE request_id = ? LIMIT 1`,
        [requestId],
      );
      const request = rows?.[0];
      if (!request) throw elevatedRequestNotFound(requestId);
      if (request.organisation_id !== organisationId) throw tenantMismatch(organisationId, request.organisation_id);
      if (request.decision !== "pending") throw elevatedAlreadyDecided(requestId, request.decision);

      // Requester cannot approve their own request
      if (request.requested_by === reviewedBy) {
        throw elevatedReviewerNotIndependent("requester_self_approval");
      }
      // Target user cannot self-approve
      if (request.target_user_id && request.target_user_id === reviewedBy) {
        throw elevatedReviewerNotIndependent("target_self_approval");
      }

      const newVersion = request.version + 1;
      await db.execute(
        `UPDATE access_elevated_requests
         SET decision = 'approved', reviewed_by = ?, decided_at = CURRENT_TIMESTAMP(3),
             decision_reason = ?, version = ?
         WHERE request_id = ? AND decision = 'pending'`,
        [reviewedBy, reason, newVersion, requestId],
      );

      // If there's a target user, advance their authorization version
      if (request.target_user_id) {
        await advanceAuthorizationVersionForUser(db, organisationId, request.target_user_id);
      }

      const operationId = uuid();
      await writeAuditEvent(db, {
        organisationId, actorType: "user", actorId: reviewedBy,
        subjectId: request.target_user_id,
        action: "elevated_request.approved", targetType: "access_elevated_request", targetId: requestId,
        beforeVersion: request.version, afterVersion: newVersion, reason,
        correlationId, operationId, outcome: "success",
      });

      return { requestId, decision: "approved", version: newVersion, operationId };
    },

    async rejectElevatedRequest({
      organisationId, requestId, reviewedBy, reason, correlationId, executor,
    }) {
      organisationId = assertRequiredString(organisationId, "organisationId", 36);
      requestId = assertRequiredString(requestId, "requestId", 36);
      reviewedBy = assertRequiredString(reviewedBy, "reviewedBy", 36);
      reason = assertRequiredString(reason, "reason", 512);
      correlationId = assertRequiredString(correlationId, "correlationId", 128);
      const db = exec(executor);

      const [rows] = await db.execute(
        `SELECT request_id, organisation_id, requested_by, target_user_id, decision, version
         FROM access_elevated_requests WHERE request_id = ? LIMIT 1`,
        [requestId],
      );
      const request = rows?.[0];
      if (!request) throw elevatedRequestNotFound(requestId);
      if (request.organisation_id !== organisationId) throw tenantMismatch(organisationId, request.organisation_id);
      if (request.decision !== "pending") throw elevatedAlreadyDecided(requestId, request.decision);

      // Requester cannot reject their own request
      if (request.requested_by === reviewedBy) {
        throw elevatedReviewerNotIndependent("requester_self_rejection");
      }

      const newVersion = request.version + 1;
      await db.execute(
        `UPDATE access_elevated_requests
         SET decision = 'rejected', reviewed_by = ?, decided_at = CURRENT_TIMESTAMP(3),
             decision_reason = ?, version = ?
         WHERE request_id = ? AND decision = 'pending'`,
        [reviewedBy, reason, newVersion, requestId],
      );

      const operationId = uuid();
      await writeAuditEvent(db, {
        organisationId, actorType: "user", actorId: reviewedBy,
        subjectId: request.target_user_id,
        action: "elevated_request.rejected", targetType: "access_elevated_request", targetId: requestId,
        beforeVersion: request.version, afterVersion: newVersion, reason,
        correlationId, operationId, outcome: "success",
      });

      return { requestId, decision: "rejected", version: newVersion, operationId };
    },

    // =====================================================================
    // Effective-Permission Resolver
    // =====================================================================

    /**
     * Resolve effective permissions for a user in a tenant.
     *
     * Combines:
     * 1. Active compatible system-role permissions (from membership_roles → role_permissions).
     * 2. Active custom-role assignment permissions (from access_role_assignments → access_role_permissions).
     * 3. Active approved delegated permissions (from access_delegations → access_delegation_permissions).
     *
     * Every source is tenant-scoped, known in the catalogue, currently effective,
     * unexpired, unrevoked, and attached to an active role.
     *
     * Delegated authority is excluded when the grantor no longer holds the permission.
     * Delegation is non-transitive.
     */
    async resolveEffectivePermissions({
      organisationId, userId, membershipId, asOf = null, executor,
    }) {
      organisationId = assertRequiredString(organisationId, "organisationId", 36);
      userId = assertRequiredString(userId, "userId", 36);
      membershipId = assertRequiredString(membershipId, "membershipId", 36);
      const db = exec(executor);
      const now = asOf || nowTimestamp();

      const permissionSources = new Map(); // key → { permission, sources: [] }

      // 1. System-role permissions
      const systemRows = await resolveSystemRolePermissions(db, membershipId);
      for (const row of systemRows) {
        if (!isKnownPermission(row.permission_key)) continue;
        if (!permissionSources.has(row.permission_key)) {
          permissionSources.set(row.permission_key, { permission: row.permission_key, sources: [] });
        }
        permissionSources.get(row.permission_key).sources.push({
          type: "system_role",
          roleKey: row.role_key,
        });
      }

      // 2. Custom-role assignment permissions
      const assignmentRows = await resolveCustomRolePermissions(db, organisationId, userId, now);
      for (const row of assignmentRows) {
        if (!isKnownPermission(row.permission_key)) continue;
        if (!permissionSources.has(row.permission_key)) {
          permissionSources.set(row.permission_key, { permission: row.permission_key, sources: [] });
        }
        permissionSources.get(row.permission_key).sources.push({
          type: "custom_role_assignment",
          roleKey: row.role_key,
          assignmentId: row.assignment_id,
        });
      }

      // 3. Delegated permissions (non-transitive)
      // First, gather active delegations for this user
      const [delegationRows] = await db.execute(
        `SELECT d.delegation_id, d.grantor_user_id, dp.permission_key
         FROM access_delegations d
         JOIN access_delegation_permissions dp ON dp.delegation_id = d.delegation_id
         LEFT JOIN access_elevated_requests aer ON aer.request_id = d.elevated_request_id
         WHERE d.organisation_id = ?
           AND d.grantee_user_id = ?
           AND d.status = 'active'
           AND d.effective_from <= ?
           AND d.expires_at > ?
           AND (d.elevated_request_id IS NULL OR aer.decision = 'approved')`,
        [organisationId, userId, now, now],
      );

      // Group delegation permissions by grantor for authority verification
      const grantorDelegations = new Map(); // grantorUserId → [{delegationId, permissionKey}]
      for (const row of delegationRows || []) {
        if (!isKnownPermission(row.permission_key)) continue;
        if (!grantorDelegations.has(row.grantor_user_id)) {
          grantorDelegations.set(row.grantor_user_id, []);
        }
        grantorDelegations.get(row.grantor_user_id).push({
          delegationId: row.delegation_id,
          permissionKey: row.permission_key,
        });
      }

      // For each grantor, check that the grantor still holds the delegated permissions
      // (using only system-role and custom-role sources, NOT delegated ones — non-transitive)
      for (const [grantorUserId, delegations] of grantorDelegations) {
        // Find the grantor's membership in this organisation
        const [grantorMembershipRows] = await db.execute(
          `SELECT membership_id FROM organisation_memberships
           WHERE user_id = ? AND organisation_id = ? AND status = 'active' LIMIT 1`,
          [grantorUserId, organisationId],
        );
        const grantorMembershipId = grantorMembershipRows?.[0]?.membership_id;
        if (!grantorMembershipId) continue; // Grantor is no longer a member

        // Get the grantor's own non-delegated permissions
        const grantorPermissions = new Set();

        // Grantor system-role permissions
        const grantorSystemRows = await resolveSystemRolePermissions(db, grantorMembershipId);
        for (const row of grantorSystemRows) {
          grantorPermissions.add(row.permission_key);
        }

        // Grantor custom-role permissions
        const grantorCustomRows = await resolveCustomRolePermissions(db, organisationId, grantorUserId, now);
        for (const row of grantorCustomRows) {
          grantorPermissions.add(row.permission_key);
        }

        // Include only delegated permissions that the grantor still holds
        for (const delegation of delegations) {
          if (!grantorPermissions.has(delegation.permissionKey)) continue;
          if (!permissionSources.has(delegation.permissionKey)) {
            permissionSources.set(delegation.permissionKey, { permission: delegation.permissionKey, sources: [] });
          }
          permissionSources.get(delegation.permissionKey).sources.push({
            type: "delegation",
            delegationId: delegation.delegationId,
            grantorUserId,
          });
        }
      }

      // Build deduplicated, sorted result
      const permissions = [...permissionSources.values()]
        .sort((a, b) => a.permission.localeCompare(b.permission));

      return {
        organisationId,
        userId,
        membershipId,
        permissions,
        permissionKeys: permissions.map((entry) => entry.permission),
        resolvedAt: now,
      };
    },

    // =====================================================================
    // Authorization Version
    // =====================================================================

    async getAuthorizationVersion(membershipId, { executor } = {}) {
      const [rows] = await exec(executor).execute(
        `SELECT authorization_version FROM organisation_memberships WHERE membership_id = ? LIMIT 1`,
        [membershipId],
      );
      return rows?.[0]?.authorization_version ?? null;
    },

    async checkAuthorizationVersionFresh({ membershipId, sessionVersion, executor } = {}) {
      const currentVersion = await this.getAuthorizationVersion(membershipId, { executor });
      if (currentVersion === null) return { fresh: false, reason: "membership_not_found" };
      if (currentVersion !== sessionVersion) {
        return { fresh: false, reason: "version_mismatch", currentVersion, sessionVersion };
      }
      return { fresh: true, currentVersion };
    },

    // =====================================================================
    // Access Audit (read-only; writes happen inside mutations)
    // =====================================================================

    async readAccessAuditHistory({
      organisationId, targetType = null, targetId = null, limit = 50, executor,
    }) {
      organisationId = assertRequiredString(organisationId, "organisationId", 36);
      const db = exec(executor);

      let sql = `SELECT audit_event_id, organisation_id, actor_type, actor_id, subject_id,
                        action, target_type, target_id, before_version, after_version,
                        reason, correlation_id, operation_id, occurred_at, outcome
                 FROM access_audit_events WHERE organisation_id = ?`;
      const params = [organisationId];

      if (targetType) {
        sql += " AND target_type = ?";
        params.push(targetType);
        if (targetId) {
          sql += " AND target_id = ?";
          params.push(targetId);
        }
      }

      sql += " ORDER BY occurred_at DESC LIMIT ?";
      params.push(Math.min(Math.max(1, limit), 500));

      const [rows] = await db.execute(sql, params);
      return rows || [];
    },
  };
}
