import crypto from "node:crypto";

import {
  isDelegablePermission,
  isElevatedPermission,
  isKnownPermission,
  isTenantAssignable,
  validatePermissionKeys,
  MAX_DELEGATION_HOURS,
} from "./permission-catalogue.js";
import {
  assignmentInactive,
  assignmentLinkageMismatch,
  assignmentNotFound,
  delegationAuthorityMissing,
  delegationExpiryInvalid,
  delegationNotFound,
  delegationSelfForbidden,
  elevatedAlreadyDecided,
  elevatedApprovalRequired,
  elevatedRequestNotFound,
  elevatedReviewerNotIndependent,
  idempotencyConflict,
  permissionNotAssignable,
  permissionNotDelegable,
  permissionUnknown,
  roleDisabled,
  roleNotFound,
  systemRoleImmutable,
  versionConflict,
} from "./access-errors.js";
import { executorOr } from "./transaction.js";

function uuid() { return crypto.randomUUID(); }
function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
  }
  return value;
}
function hash(value) {
  return crypto.createHash("sha256").update(JSON.stringify(stable(value))).digest("hex");
}
function required(value, name, max = 255) {
  if (typeof value !== "string" || !value.trim()) throw new TypeError(`${name} is required.`);
  const result = value.trim();
  if (result.length > max) throw new TypeError(`${name} must be at most ${max} characters.`);
  return result;
}
function positive(value, name) {
  const result = Number(value);
  if (!Number.isInteger(result) || result < 1) throw new TypeError(`${name} must be a positive integer.`);
  return result;
}
function canonicalPermissions(values, { elevated = null, delegable = null } = {}) {
  const keys = [...new Set((values || []).map((value) => required(value, "permissionKey", 128)))].sort();
  if (keys.length === 0) throw new TypeError("permissionKeys must not be empty.");
  const { unknown } = validatePermissionKeys(keys);
  if (unknown.length) throw permissionUnknown(unknown);
  const unassignable = keys.filter((key) => !isTenantAssignable(key));
  if (unassignable.length) throw permissionNotAssignable(unassignable);
  if (elevated === true) {
    const nonElevated = keys.filter((key) => !isElevatedPermission(key));
    if (nonElevated.length) throw elevatedApprovalRequired(nonElevated);
  }
  if (elevated === false) {
    const elevatedKeys = keys.filter(isElevatedPermission);
    if (elevatedKeys.length) throw elevatedApprovalRequired(elevatedKeys);
  }
  if (delegable === true) {
    const blocked = keys.filter((key) => !isDelegablePermission(key) || isElevatedPermission(key));
    if (blocked.length) throw permissionNotDelegable(blocked);
  }
  return keys;
}
function parsedJson(value) {
  if (value == null) return null;
  return typeof value === "string" ? JSON.parse(value) : value;
}
async function operation(executor, { organisationId, type, key, intent, result }) {
  key = required(key, "idempotencyKey", 128);
  const intentHash = hash(intent);
  const operationId = uuid();
  try {
    await executor.execute(
      `INSERT INTO access_authorization_operations
        (operation_id, organisation_id, operation_type, idempotency_key, intent_hash, result_json)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [operationId, organisationId, type, key, intentHash, JSON.stringify(result)],
    );
    return { replayed: false, operationId, result };
  } catch (error) {
    if (error?.code !== "ER_DUP_ENTRY" && error?.errno !== 1062) throw error;
    const [rows] = await executor.execute(
      `SELECT operation_id, intent_hash, result_json
       FROM access_authorization_operations
       WHERE organisation_id = ? AND operation_type = ? AND idempotency_key = ?`,
      [organisationId, type, key],
    );
    const existing = rows?.[0];
    if (!existing || existing.intent_hash !== intentHash) throw idempotencyConflict(type, key);
    return { replayed: true, operationId: existing.operation_id, result: parsedJson(existing.result_json) };
  }
}
async function audit(executor, input) {
  await executor.execute(
    `INSERT INTO access_audit_events
      (audit_event_id, organisation_id, actor_type, actor_id, subject_id, action,
       target_type, target_id, before_version, after_version, reason,
       correlation_id, operation_id, outcome)
     VALUES (?, ?, 'user', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'success')`,
    [uuid(), input.organisationId, input.actorId, input.subjectId || null, input.action,
      input.targetType, input.targetId, input.beforeVersion || null, input.afterVersion || null,
      input.reason || null, input.correlationId, input.operationId],
  );
}
async function advanceMembership(executor, organisationId, membershipId) {
  const [result] = await executor.execute(
    `UPDATE organisation_memberships
     SET authorization_version = authorization_version + 1
     WHERE organisation_id = ? AND membership_id = ? AND status = 'active'`,
    [organisationId, membershipId],
  );
  if (result.affectedRows !== 1) throw assignmentLinkageMismatch({ membershipId });
}
async function advanceRoleMembers(executor, organisationId, roleId) {
  const [rows] = await executor.execute(
    `SELECT DISTINCT membership_id FROM access_role_assignments
     WHERE organisation_id = ? AND role_id = ? AND status = 'active'`,
    [organisationId, roleId],
  );
  for (const row of rows || []) await advanceMembership(executor, organisationId, row.membership_id);
}
async function membershipForUpdate(executor, organisationId, membershipId) {
  const [rows] = await executor.execute(
    `SELECT membership_id, user_id, organisation_id, status, authorization_version
     FROM organisation_memberships
     WHERE organisation_id = ? AND membership_id = ? LIMIT 1 FOR UPDATE`,
    [organisationId, membershipId],
  );
  return rows?.[0] || null;
}
async function roleForUpdate(executor, organisationId, roleId) {
  const [rows] = await executor.execute(
    `SELECT role_id, organisation_id, role_class, status, version
     FROM access_role_definitions
     WHERE organisation_id = ? AND role_id = ? LIMIT 1 FOR UPDATE`,
    [organisationId, roleId],
  );
  return rows?.[0] || null;
}
async function directPermissionRows(executor, organisationId, userId, at) {
  const [membershipRows] = await executor.execute(
    `SELECT membership_id FROM organisation_memberships
     WHERE organisation_id = ? AND user_id = ? AND status = 'active' LIMIT 1`,
    [organisationId, userId],
  );
  const membershipId = membershipRows?.[0]?.membership_id;
  if (!membershipId) return [];
  const [systemRows] = await executor.execute(
    `SELECT DISTINCT p.permission_key, NULL AS expires_at
     FROM membership_roles mr
     JOIN role_permissions rp ON rp.role_id = mr.role_id
     JOIN permissions p ON p.permission_id = rp.permission_id
     WHERE mr.membership_id = ? AND mr.revoked_at IS NULL`,
    [membershipId],
  );
  const [customRows] = await executor.execute(
    `SELECT DISTINCT arp.permission_key, ard.role_key, ara.assignment_id, ara.expires_at
     FROM access_role_assignments ara
     JOIN access_role_definitions ard ON ard.role_id = ara.role_id AND ard.status = 'active'
     JOIN access_role_permissions arp ON arp.role_id = ara.role_id
     JOIN permissions p ON p.permission_key = arp.permission_key
     LEFT JOIN access_elevated_requests rr ON rr.request_id = arp.elevated_request_id
     LEFT JOIN access_elevated_requests arq ON arq.request_id = ara.elevated_request_id
     WHERE ara.organisation_id = ? AND ara.subject_user_id = ?
       AND ara.status = 'active' AND ara.effective_from <= ?
       AND (ara.expires_at IS NULL OR ara.expires_at > ?)
       AND (p.elevated = 0 OR (
         rr.organisation_id = ara.organisation_id AND rr.target_type = 'role_permission_set'
         AND rr.target_id = ard.role_id AND rr.decision = 'approved'
         AND rr.target_version + 1 = ard.version AND rr.superseded_by_request_id IS NULL
         AND JSON_CONTAINS(rr.requested_permissions, JSON_QUOTE(arp.permission_key))
         AND (rr.effective_from IS NULL OR rr.effective_from <= ?)
         AND (rr.expires_at IS NULL OR rr.expires_at > ?)
         AND arq.organisation_id = ara.organisation_id AND arq.target_type = 'assignment'
         AND arq.target_id = ara.assignment_id AND arq.decision = 'approved'
         AND arq.target_version + 1 = ara.version AND arq.target_membership_id = ara.membership_id
         AND arq.target_user_id = ara.subject_user_id AND arq.superseded_by_request_id IS NULL
         AND JSON_CONTAINS(arq.requested_permissions, JSON_QUOTE(arp.permission_key))
         AND (arq.effective_from IS NULL OR arq.effective_from <= ?)
         AND (arq.expires_at IS NULL OR arq.expires_at > ?)
       ))`,
    [organisationId, userId, at, at, at, at, at, at],
  );
  return [...(systemRows || []), ...(customRows || [])];
}

export function createAccessGovernanceRepository(defaultExecutor) {
  const exec = (explicit) => executorOr(defaultExecutor, explicit);
  return {
    async replaceCustomRolePermissions(input) {
      const db = exec(input.executor);
      const organisationId = required(input.organisationId, "organisationId", 36);
      const roleId = required(input.roleId, "roleId", 36);
      const actorId = required(input.actorId, "actorId", 36);
      const expectedVersion = positive(input.expectedVersion, "expectedVersion");
      const permissionKeys = canonicalPermissions(input.permissionKeys, { elevated: false });
      const resultData = { roleId, version: expectedVersion + 1, permissionCount: permissionKeys.length };
      const op = await operation(db, {
        organisationId, type: "replace_role_permissions", key: input.idempotencyKey,
        intent: { organisationId, roleId, expectedVersion, permissionKeys }, result: resultData,
      });
      if (op.replayed) return { ...op.result, replayed: true, operationId: op.operationId };
      const role = await roleForUpdate(db, organisationId, roleId);
      if (!role) throw roleNotFound(roleId);
      if (role.role_class === "system") throw systemRoleImmutable(roleId);
      if (role.version !== expectedVersion) throw versionConflict("role", roleId, expectedVersion, role.version);
      await db.execute("DELETE FROM access_role_permissions WHERE role_id = ?", [roleId]);
      for (const key of permissionKeys) {
        await db.execute(
          `INSERT INTO access_role_permissions (role_id, permission_key, granted_by)
           VALUES (?, ?, ?)`, [roleId, key, actorId],
        );
      }
      const [updated] = await db.execute(
        `UPDATE access_role_definitions SET version = ?, last_changed_by = ?, last_changed_at = CURRENT_TIMESTAMP(3)
         WHERE organisation_id = ? AND role_id = ? AND version = ?`,
        [expectedVersion + 1, actorId, organisationId, roleId, expectedVersion],
      );
      if (updated.affectedRows !== 1) throw versionConflict("role", roleId, expectedVersion, null);
      await advanceRoleMembers(db, organisationId, roleId);
      await audit(db, { organisationId, actorId, action: "role.permissions_replaced", targetType: "access_role",
        targetId: roleId, beforeVersion: expectedVersion, afterVersion: expectedVersion + 1,
        correlationId: required(input.correlationId, "correlationId", 128), operationId: op.operationId });
      return { ...resultData, replayed: false, operationId: op.operationId };
    },

    async disableCustomRole(input) {
      const db = exec(input.executor);
      const organisationId = required(input.organisationId, "organisationId", 36);
      const roleId = required(input.roleId, "roleId", 36);
      const expectedVersion = positive(input.expectedVersion, "expectedVersion");
      const resultData = { roleId, version: expectedVersion + 1, status: "disabled" };
      const op = await operation(db, { organisationId, type: "disable_role", key: input.idempotencyKey,
        intent: { organisationId, roleId, expectedVersion }, result: resultData });
      if (op.replayed) return { ...op.result, replayed: true, operationId: op.operationId };
      const role = await roleForUpdate(db, organisationId, roleId);
      if (!role) throw roleNotFound(roleId);
      if (role.role_class === "system") throw systemRoleImmutable(roleId);
      if (role.version !== expectedVersion) throw versionConflict("role", roleId, expectedVersion, role.version);
      const [updated] = await db.execute(
        `UPDATE access_role_definitions SET status = 'disabled', version = ?, last_changed_by = ?, last_changed_at = CURRENT_TIMESTAMP(3)
         WHERE organisation_id = ? AND role_id = ? AND version = ? AND status = 'active'`,
        [expectedVersion + 1, input.actorId, organisationId, roleId, expectedVersion],
      );
      if (updated.affectedRows !== 1) throw versionConflict("role", roleId, expectedVersion, role.version);
      await advanceRoleMembers(db, organisationId, roleId);
      await audit(db, { organisationId, actorId: input.actorId, action: "role.disabled", targetType: "access_role",
        targetId: roleId, beforeVersion: expectedVersion, afterVersion: expectedVersion + 1,
        correlationId: input.correlationId, operationId: op.operationId });
      return { ...resultData, replayed: false, operationId: op.operationId };
    },

    async createRoleAssignment(input) {
      const db = exec(input.executor);
      const organisationId = required(input.organisationId, "organisationId", 36);
      const membershipId = required(input.membershipId, "membershipId", 36);
      const roleId = required(input.roleId, "roleId", 36);
      const membership = await membershipForUpdate(db, organisationId, membershipId);
      if (!membership || membership.user_id !== input.subjectUserId || membership.status !== "active") {
        throw assignmentLinkageMismatch({ membershipId });
      }
      if (input.expectedMembershipVersion !== undefined
          && membership.authorization_version !== positive(input.expectedMembershipVersion, "expectedMembershipVersion")) {
        throw versionConflict("membership", membershipId, input.expectedMembershipVersion, membership.authorization_version);
      }
      const role = await roleForUpdate(db, organisationId, roleId);
      if (!role) throw roleNotFound(roleId);
      if (role.status !== "active") throw roleDisabled(roleId);
      const effectiveFrom = input.effectiveFrom || new Date();
      if (input.expiresAt && new Date(input.expiresAt) <= new Date(effectiveFrom)) throw new TypeError("expiresAt must follow effectiveFrom.");
      const assignmentId = uuid();
      const intent = { organisationId, membershipId, roleId, effectiveFrom: new Date(effectiveFrom).toISOString(),
        expiresAt: input.expiresAt ? new Date(input.expiresAt).toISOString() : null,
        expectedMembershipVersion: input.expectedMembershipVersion ?? null };
      const resultData = { assignmentId, version: 1 };
      const op = await operation(db, { organisationId, type: "create_role_assignment_v2", key: input.idempotencyKey, intent, result: resultData });
      if (op.replayed) return { ...op.result, replayed: true, operationId: op.operationId };
      await db.execute(
        `INSERT INTO access_role_assignments
          (assignment_id, organisation_id, membership_id, subject_user_id, role_id,
           effective_from, expires_at, status, version, created_by, idempotency_key, intent_hash)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'active', 1, ?, ?, ?)`,
        [assignmentId, organisationId, membershipId, membership.user_id, roleId, effectiveFrom,
          input.expiresAt || null, input.actorId, input.idempotencyKey, hash(intent)],
      );
      await advanceMembership(db, organisationId, membershipId);
      await audit(db, { organisationId, actorId: input.actorId, subjectId: membership.user_id,
        action: "assignment.created", targetType: "access_assignment", targetId: assignmentId,
        afterVersion: 1, correlationId: input.correlationId, operationId: op.operationId });
      return { ...resultData, replayed: false, operationId: op.operationId };
    },

    async revokeRoleAssignment(input) {
      const db = exec(input.executor);
      const organisationId = required(input.organisationId, "organisationId", 36);
      const assignmentId = required(input.assignmentId, "assignmentId", 36);
      const expectedVersion = positive(input.expectedVersion, "expectedVersion");
      const resultData = { assignmentId, version: expectedVersion + 1, status: "revoked" };
      const op = await operation(db, { organisationId, type: "revoke_role_assignment", key: input.idempotencyKey,
        intent: { organisationId, assignmentId, expectedVersion, reason: input.reason || null }, result: resultData });
      if (op.replayed) return { ...op.result, replayed: true, operationId: op.operationId };
      const [rows] = await db.execute(
        `SELECT assignment_id, membership_id, subject_user_id, status, version
         FROM access_role_assignments WHERE organisation_id = ? AND assignment_id = ? LIMIT 1 FOR UPDATE`,
        [organisationId, assignmentId],
      );
      const assignment = rows?.[0];
      if (!assignment) throw assignmentNotFound(assignmentId);
      if (assignment.version !== expectedVersion) throw versionConflict("assignment", assignmentId, expectedVersion, assignment.version);
      if (assignment.status !== "active") throw assignmentInactive(assignmentId);
      const [updated] = await db.execute(
        `UPDATE access_role_assignments SET status = 'revoked', revoked_at = CURRENT_TIMESTAMP(3),
         revoked_by = ?, revoke_reason = ?, version = ?
         WHERE organisation_id = ? AND assignment_id = ? AND version = ? AND status = 'active'`,
        [input.actorId, input.reason || null, expectedVersion + 1, organisationId, assignmentId, expectedVersion],
      );
      if (updated.affectedRows !== 1) throw versionConflict("assignment", assignmentId, expectedVersion, null);
      await advanceMembership(db, organisationId, assignment.membership_id);
      await audit(db, { organisationId, actorId: input.actorId, subjectId: assignment.subject_user_id,
        action: "assignment.revoked", targetType: "access_assignment", targetId: assignmentId,
        beforeVersion: expectedVersion, afterVersion: expectedVersion + 1, reason: input.reason,
        correlationId: input.correlationId, operationId: op.operationId });
      return { ...resultData, replayed: false, operationId: op.operationId };
    },

    async createDelegation(input) {
      const db = exec(input.executor);
      const organisationId = required(input.organisationId, "organisationId", 36);
      const grantorUserId = required(input.grantorUserId, "grantorUserId", 36);
      const granteeUserId = required(input.granteeUserId, "granteeUserId", 36);
      if (grantorUserId === granteeUserId) throw delegationSelfForbidden();
      const permissionKeys = canonicalPermissions(input.permissionKeys, { delegable: true });
      const effectiveFrom = input.effectiveFrom || new Date();
      const expiresAt = input.expiresAt ? new Date(input.expiresAt) : null;
      if (!expiresAt || expiresAt <= new Date(effectiveFrom)) throw delegationExpiryInvalid("expiry is mandatory and must follow effectiveFrom");
      if ((expiresAt - new Date(effectiveFrom)) / 3600000 > MAX_DELEGATION_HOURS) throw delegationExpiryInvalid("duration exceeds the supported bound");
      const [targetRows] = await db.execute(
        `SELECT membership_id FROM organisation_memberships
         WHERE organisation_id = ? AND user_id = ? AND status = 'active' LIMIT 1 FOR UPDATE`,
        [organisationId, granteeUserId],
      );
      if (!targetRows?.[0]) throw assignmentLinkageMismatch({ userId: granteeUserId });
      const directRows = await directPermissionRows(db, organisationId, grantorUserId, effectiveFrom);
      const direct = new Map(directRows.map((row) => [row.permission_key, row.expires_at]));
      const missing = permissionKeys.filter((key) => !direct.has(key));
      if (missing.length) throw delegationAuthorityMissing(missing);
      for (const key of permissionKeys) {
        const sourceExpiry = direct.get(key);
        if (sourceExpiry && expiresAt > new Date(sourceExpiry)) throw delegationExpiryInvalid("delegation outlives grantor source authority");
      }
      const delegationId = uuid();
      const intent = { organisationId, grantorUserId, granteeUserId, permissionKeys,
        effectiveFrom: new Date(effectiveFrom).toISOString(), expiresAt: expiresAt.toISOString(), reason: input.reason };
      const resultData = { delegationId, version: 1 };
      const op = await operation(db, { organisationId, type: "create_delegation_v2", key: input.idempotencyKey, intent, result: resultData });
      if (op.replayed) return { ...op.result, replayed: true, operationId: op.operationId };
      await db.execute(
        `INSERT INTO access_delegations
          (delegation_id, organisation_id, grantor_user_id, grantee_user_id, permissions_json,
           effective_from, expires_at, reason, status, version, created_by, idempotency_key, intent_hash)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', 1, ?, ?, ?)`,
        [delegationId, organisationId, grantorUserId, granteeUserId, JSON.stringify(permissionKeys),
          effectiveFrom, expiresAt, input.reason, input.actorId, input.idempotencyKey, hash(intent)],
      );
      for (const key of permissionKeys) await db.execute(
        "INSERT INTO access_delegation_permissions (delegation_id, permission_key) VALUES (?, ?)", [delegationId, key],
      );
      await advanceMembership(db, organisationId, targetRows[0].membership_id);
      await audit(db, { organisationId, actorId: input.actorId, subjectId: granteeUserId,
        action: "delegation.created", targetType: "access_delegation", targetId: delegationId,
        afterVersion: 1, reason: input.reason, correlationId: input.correlationId, operationId: op.operationId });
      return { ...resultData, replayed: false, operationId: op.operationId };
    },

    async revokeDelegation(input) {
      const db = exec(input.executor);
      const organisationId = required(input.organisationId, "organisationId", 36);
      const delegationId = required(input.delegationId, "delegationId", 36);
      const expectedVersion = positive(input.expectedVersion, "expectedVersion");
      const resultData = { delegationId, version: expectedVersion + 1, status: "revoked" };
      const op = await operation(db, { organisationId, type: "revoke_delegation", key: input.idempotencyKey,
        intent: { organisationId, delegationId, expectedVersion, reason: input.reason || null }, result: resultData });
      if (op.replayed) return { ...op.result, replayed: true, operationId: op.operationId };
      const [rows] = await db.execute(
        `SELECT delegation_id, grantee_user_id, status, version FROM access_delegations
         WHERE organisation_id = ? AND delegation_id = ? LIMIT 1 FOR UPDATE`, [organisationId, delegationId],
      );
      const delegation = rows?.[0];
      if (!delegation) throw delegationNotFound(delegationId);
      if (delegation.version !== expectedVersion) throw versionConflict("delegation", delegationId, expectedVersion, delegation.version);
      if (delegation.status !== "active") throw versionConflict("delegation", delegationId, expectedVersion, delegation.version);
      const [updated] = await db.execute(
        `UPDATE access_delegations SET status = 'revoked', revoked_at = CURRENT_TIMESTAMP(3), revoked_by = ?,
         revoke_reason = ?, version = ? WHERE organisation_id = ? AND delegation_id = ? AND version = ? AND status = 'active'`,
        [input.actorId, input.reason || null, expectedVersion + 1, organisationId, delegationId, expectedVersion],
      );
      if (updated.affectedRows !== 1) throw versionConflict("delegation", delegationId, expectedVersion, null);
      const [memberships] = await db.execute(
        `SELECT membership_id FROM organisation_memberships WHERE organisation_id = ? AND user_id = ? AND status = 'active'`,
        [organisationId, delegation.grantee_user_id],
      );
      for (const row of memberships || []) await advanceMembership(db, organisationId, row.membership_id);
      await audit(db, { organisationId, actorId: input.actorId, subjectId: delegation.grantee_user_id,
        action: "delegation.revoked", targetType: "access_delegation", targetId: delegationId,
        beforeVersion: expectedVersion, afterVersion: expectedVersion + 1, reason: input.reason,
        correlationId: input.correlationId, operationId: op.operationId });
      return { ...resultData, replayed: false, operationId: op.operationId };
    },

    async createElevatedRequest(input) {
      const db = exec(input.executor);
      const organisationId = required(input.organisationId, "organisationId", 36);
      const targetType = required(input.targetType, "targetType", 24);
      if (!["role_permission_set", "assignment"].includes(targetType)) throw new TypeError("Unsupported elevated target type.");
      const targetId = required(input.targetId, "targetId", 36);
      const targetVersion = positive(input.targetVersion, "targetVersion");
      const requestedPermissions = canonicalPermissions(input.requestedPermissions, { elevated: true });
      const requesterMembershipId = required(input.requesterMembershipId, "requesterMembershipId", 36);
      const requester = await membershipForUpdate(db, organisationId, requesterMembershipId);
      if (!requester || requester.user_id !== input.requestedBy || requester.status !== "active") {
        throw assignmentLinkageMismatch({ requesterMembershipId });
      }
      let targetUserId = null;
      let targetMembershipId = null;
      if (targetType === "role_permission_set") {
        const role = await roleForUpdate(db, organisationId, targetId);
        if (!role) throw roleNotFound(targetId);
        if (role.role_class === "system") throw systemRoleImmutable(targetId);
        if (role.version !== targetVersion) throw versionConflict("role", targetId, targetVersion, role.version);
      } else {
        const [rows] = await db.execute(
          `SELECT assignment_id, membership_id, subject_user_id, role_id, status, version
           FROM access_role_assignments WHERE organisation_id = ? AND assignment_id = ? LIMIT 1 FOR UPDATE`,
          [organisationId, targetId],
        );
        const assignment = rows?.[0];
        if (!assignment) throw assignmentNotFound(targetId);
        if (assignment.version !== targetVersion) throw versionConflict("assignment", targetId, targetVersion, assignment.version);
        if (assignment.status !== "active") throw assignmentInactive(targetId);
        targetUserId = assignment.subject_user_id;
        targetMembershipId = assignment.membership_id;
        const [rolePermissions] = await db.execute(
          `SELECT permission_key FROM access_role_permissions WHERE role_id = ?`, [assignment.role_id],
        );
        const present = new Set((rolePermissions || []).map((row) => row.permission_key));
        const missing = requestedPermissions.filter((key) => !present.has(key));
        if (missing.length) throw elevatedApprovalRequired(missing);
      }
      const effectiveFrom = input.effectiveFrom || null;
      const expiresAt = input.expiresAt || null;
      if (effectiveFrom && expiresAt && new Date(expiresAt) <= new Date(effectiveFrom)) throw new TypeError("expiresAt must follow effectiveFrom.");
      const requestId = uuid();
      const intent = { organisationId, targetType, targetId, targetVersion, requestedPermissions,
        targetMembershipId, targetUserId, effectiveFrom: effectiveFrom ? new Date(effectiveFrom).toISOString() : null,
        expiresAt: expiresAt ? new Date(expiresAt).toISOString() : null, reason: input.reason };
      const resultData = { requestId, decision: "pending", version: 1 };
      const op = await operation(db, { organisationId, type: "create_elevated_request", key: input.idempotencyKey, intent, result: resultData });
      if (op.replayed) return { ...op.result, replayed: true, operationId: op.operationId };
      await db.execute(
        `INSERT INTO access_elevated_requests
          (request_id, organisation_id, target_type, target_id, target_version, requested_permissions,
           requested_by, requester_membership_id, target_user_id, target_membership_id, reason,
           decision, version, intent_hash, idempotency_key, effective_from, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 1, ?, ?, ?, ?)`,
        [requestId, organisationId, targetType, targetId, targetVersion, JSON.stringify(requestedPermissions),
          input.requestedBy, requesterMembershipId, targetUserId, targetMembershipId, input.reason,
          hash(intent), input.idempotencyKey, effectiveFrom, expiresAt],
      );
      await db.execute(
        `UPDATE access_elevated_requests SET decision = 'superseded', superseded_by_request_id = ?,
         decided_at = CURRENT_TIMESTAMP(3), decision_reason = 'Superseded by a newer request.', version = version + 1
         WHERE organisation_id = ? AND target_type = ? AND target_id = ? AND decision = 'pending'
           AND request_id <> ?`,
        [requestId, organisationId, targetType, targetId, requestId],
      );
      await audit(db, { organisationId, actorId: input.requestedBy, subjectId: targetUserId,
        action: "elevated_request.created", targetType: "access_elevated_request", targetId: requestId,
        afterVersion: 1, reason: input.reason, correlationId: input.correlationId, operationId: op.operationId });
      return { ...resultData, replayed: false, operationId: op.operationId };
    },

    async decideElevatedRequest(input) {
      const db = exec(input.executor);
      const organisationId = required(input.organisationId, "organisationId", 36);
      const requestId = required(input.requestId, "requestId", 36);
      const expectedVersion = positive(input.expectedVersion, "expectedVersion");
      const decision = input.decision === "approved" ? "approved" : "rejected";
      const resultData = { requestId, decision, version: expectedVersion + 1 };
      const op = await operation(db, { organisationId, type: `${decision}_elevated_request`, key: input.idempotencyKey,
        intent: { organisationId, requestId, expectedVersion, decision, reason: input.reason }, result: resultData });
      if (op.replayed) return { ...op.result, replayed: true, operationId: op.operationId };
      const [rows] = await db.execute(
        `SELECT * FROM access_elevated_requests
         WHERE organisation_id = ? AND request_id = ? LIMIT 1 FOR UPDATE`, [organisationId, requestId],
      );
      const request = rows?.[0];
      if (!request) throw elevatedRequestNotFound(requestId);
      if (request.version !== expectedVersion) throw versionConflict("elevated_request", requestId, expectedVersion, request.version);
      if (request.decision !== "pending" || request.superseded_by_request_id) throw elevatedAlreadyDecided(requestId, request.decision);
      const [reviewers] = await db.execute(
        `SELECT membership_id, user_id, status FROM organisation_memberships
         WHERE organisation_id = ? AND user_id = ? AND status = 'active' LIMIT 1 FOR UPDATE`,
        [organisationId, input.reviewedBy],
      );
      const reviewer = reviewers?.[0];
      if (!reviewer) throw elevatedReviewerNotIndependent("reviewer_not_active_in_tenant");
      if (request.requested_by === input.reviewedBy) throw elevatedReviewerNotIndependent("requester_self_review");
      if (request.target_user_id === input.reviewedBy || request.target_membership_id === reviewer.membership_id) {
        throw elevatedReviewerNotIndependent("target_self_review");
      }
      let affectedMembershipId = null;
      if (decision === "approved") {
        const permissions = canonicalPermissions(parsedJson(request.requested_permissions), { elevated: true });
        if (request.target_type === "role_permission_set") {
          const role = await roleForUpdate(db, organisationId, request.target_id);
          if (!role) throw roleNotFound(request.target_id);
          if (role.version !== request.target_version) throw versionConflict("role", request.target_id, request.target_version, role.version);
          for (const key of permissions) {
            await db.execute(
              `INSERT INTO access_role_permissions (role_id, permission_key, granted_by, elevated_request_id)
               VALUES (?, ?, ?, ?)
               ON DUPLICATE KEY UPDATE granted_by = VALUES(granted_by), elevated_request_id = VALUES(elevated_request_id), granted_at = CURRENT_TIMESTAMP(3)`,
              [request.target_id, key, input.reviewedBy, requestId],
            );
          }
          const [updated] = await db.execute(
            `UPDATE access_role_definitions SET version = version + 1, last_changed_by = ?, last_changed_at = CURRENT_TIMESTAMP(3)
             WHERE organisation_id = ? AND role_id = ? AND version = ?`,
            [input.reviewedBy, organisationId, request.target_id, request.target_version],
          );
          if (updated.affectedRows !== 1) throw versionConflict("role", request.target_id, request.target_version, null);
          await advanceRoleMembers(db, organisationId, request.target_id);
        } else if (request.target_type === "assignment") {
          const [assignments] = await db.execute(
            `SELECT assignment_id, membership_id, subject_user_id, role_id, status, version
             FROM access_role_assignments WHERE organisation_id = ? AND assignment_id = ? LIMIT 1 FOR UPDATE`,
            [organisationId, request.target_id],
          );
          const assignment = assignments?.[0];
          if (!assignment) throw assignmentNotFound(request.target_id);
          if (assignment.version !== request.target_version) throw versionConflict("assignment", request.target_id, request.target_version, assignment.version);
          if (assignment.status !== "active") throw assignmentInactive(request.target_id);
          if (assignment.membership_id !== request.target_membership_id || assignment.subject_user_id !== request.target_user_id) {
            throw elevatedReviewerNotIndependent("target_intent_changed");
          }
          const [approvedRolePermissions] = await db.execute(
            `SELECT arp.permission_key FROM access_role_permissions arp
             JOIN access_role_definitions ard ON ard.role_id = arp.role_id
             JOIN access_elevated_requests rr ON rr.request_id = arp.elevated_request_id
             WHERE arp.role_id = ? AND rr.organisation_id = ? AND rr.target_type = 'role_permission_set'
               AND rr.target_id = arp.role_id AND rr.decision = 'approved'
               AND rr.target_version + 1 = ard.version AND rr.superseded_by_request_id IS NULL`,
            [assignment.role_id, organisationId],
          );
          const approved = new Set((approvedRolePermissions || []).map((row) => row.permission_key));
          const missing = permissions.filter((key) => !approved.has(key));
          if (missing.length) throw elevatedApprovalRequired(missing);
          const [updated] = await db.execute(
            `UPDATE access_role_assignments SET elevated_request_id = ?, version = version + 1
             WHERE organisation_id = ? AND assignment_id = ? AND version = ? AND status = 'active'`,
            [requestId, organisationId, request.target_id, request.target_version],
          );
          if (updated.affectedRows !== 1) throw versionConflict("assignment", request.target_id, request.target_version, null);
          affectedMembershipId = assignment.membership_id;
          await advanceMembership(db, organisationId, affectedMembershipId);
        } else throw new TypeError("Unsupported elevated target type.");
      }
      const [updatedRequest] = await db.execute(
        `UPDATE access_elevated_requests SET decision = ?, reviewed_by = ?, reviewed_by_membership_id = ?,
         decided_at = CURRENT_TIMESTAMP(3), decision_reason = ?, version = ?
         WHERE organisation_id = ? AND request_id = ? AND version = ? AND decision = 'pending'`,
        [decision, input.reviewedBy, reviewer.membership_id, input.reason, expectedVersion + 1,
          organisationId, requestId, expectedVersion],
      );
      if (updatedRequest.affectedRows !== 1) throw versionConflict("elevated_request", requestId, expectedVersion, null);
      await audit(db, { organisationId, actorId: input.reviewedBy, subjectId: request.target_user_id,
        action: `elevated_request.${decision}`, targetType: "access_elevated_request", targetId: requestId,
        beforeVersion: expectedVersion, afterVersion: expectedVersion + 1, reason: input.reason,
        correlationId: input.correlationId, operationId: op.operationId });
      return { ...resultData, affectedMembershipId, replayed: false, operationId: op.operationId };
    },

    async approveElevatedRequest(input) { return this.decideElevatedRequest({ ...input, decision: "approved" }); },
    async rejectElevatedRequest(input) { return this.decideElevatedRequest({ ...input, decision: "rejected" }); },

    async resolveEffectivePermissions(input) {
      const db = exec(input.executor);
      const organisationId = required(input.organisationId, "organisationId", 36);
      const userId = required(input.userId, "userId", 36);
      const membershipId = required(input.membershipId, "membershipId", 36);
      const at = input.asOf || new Date();
      const sources = new Map();
      const add = (key, source) => {
        if (!isKnownPermission(key)) return;
        if (!sources.has(key)) sources.set(key, { permission: key, sources: [] });
        sources.get(key).sources.push(source);
      };
      const [systemRows] = await db.execute(
        `SELECT DISTINCT p.permission_key, r.role_key FROM membership_roles mr
         JOIN roles r ON r.role_id = mr.role_id JOIN role_permissions rp ON rp.role_id = mr.role_id
         JOIN permissions p ON p.permission_id = rp.permission_id
         WHERE mr.membership_id = ? AND mr.revoked_at IS NULL`, [membershipId],
      );
      for (const row of systemRows || []) add(row.permission_key, { type: "system_role", roleKey: row.role_key });
      const customRows = await directPermissionRows(db, organisationId, userId, at);
      for (const row of customRows) {
        if (row.role_key) add(row.permission_key, { type: "custom_role_assignment", roleKey: row.role_key, assignmentId: row.assignment_id });
      }
      const [delegations] = await db.execute(
        `SELECT d.delegation_id, d.grantor_user_id, dp.permission_key
         FROM access_delegations d JOIN access_delegation_permissions dp ON dp.delegation_id = d.delegation_id
         JOIN permissions p ON p.permission_key = dp.permission_key
         WHERE d.organisation_id = ? AND d.grantee_user_id = ? AND d.status = 'active'
           AND d.effective_from <= ? AND d.expires_at > ? AND p.delegable = 1 AND p.elevated = 0`,
        [organisationId, userId, at, at],
      );
      const byGrantor = new Map();
      for (const row of delegations || []) {
        if (!byGrantor.has(row.grantor_user_id)) byGrantor.set(row.grantor_user_id, []);
        byGrantor.get(row.grantor_user_id).push(row);
      }
      for (const [grantor, rows] of byGrantor) {
        const direct = new Set((await directPermissionRows(db, organisationId, grantor, at)).map((row) => row.permission_key));
        for (const row of rows) if (direct.has(row.permission_key)) {
          add(row.permission_key, { type: "delegation", delegationId: row.delegation_id, grantorUserId: grantor });
        }
      }
      const permissions = [...sources.values()].sort((a, b) => a.permission.localeCompare(b.permission));
      return { organisationId, userId, membershipId, permissions,
        permissionKeys: permissions.map((entry) => entry.permission), resolvedAt: at };
    },
  };
}
