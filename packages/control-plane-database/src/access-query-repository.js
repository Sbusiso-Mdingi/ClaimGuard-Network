import { executorOr } from "./transaction.js";

function required(value, name, max = 128) {
  if (typeof value !== "string" || !value.trim()) throw new TypeError(`${name} is required.`);
  const normalized = value.trim();
  if (normalized.length > max) throw new TypeError(`${name} is too long.`);
  return normalized;
}

function boundedPageSize(value, fallback = 50) {
  const parsed = Number(value ?? fallback);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 100) {
    throw new TypeError("pageSize must be an integer between 1 and 100.");
  }
  return parsed;
}

function parseJsonArray(value) {
  if (Array.isArray(value)) return value;
  if (typeof value !== "string" || !value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function createAccessQueryRepository(defaultExecutor, accessRepository) {
  function exec(explicitExecutor) {
    return executorOr(defaultExecutor, explicitExecutor);
  }

  async function listRoles({ organisationId, executor } = {}) {
    organisationId = required(organisationId, "organisationId", 36);
    const [rows] = await exec(executor).execute(
      `SELECT ard.role_id, ard.organisation_id, ard.role_key, ard.display_name,
              ard.description, ard.role_class, ard.status, ard.version,
              ard.created_at, ard.last_changed_at, arp.permission_key
       FROM access_role_definitions ard
       LEFT JOIN access_role_permissions arp ON arp.role_id = ard.role_id
       WHERE ard.organisation_id = ?
       ORDER BY ard.role_key, arp.permission_key`,
      [organisationId],
    );
    const roles = new Map();
    for (const row of rows || []) {
      if (!roles.has(row.role_id)) {
        roles.set(row.role_id, {
          roleId: row.role_id,
          organisationId: row.organisation_id,
          roleKey: row.role_key,
          displayName: row.display_name,
          description: row.description || "",
          roleClass: row.role_class,
          status: row.status,
          version: row.version,
          createdAt: row.created_at || null,
          lastChangedAt: row.last_changed_at || null,
          permissionKeys: [],
        });
      }
      if (row.permission_key) roles.get(row.role_id).permissionKeys.push(row.permission_key);
    }
    return [...roles.values()];
  }

  async function listAssignments({ organisationId, executor } = {}) {
    organisationId = required(organisationId, "organisationId", 36);
    const [rows] = await exec(executor).execute(
      `SELECT ara.assignment_id, ara.organisation_id, ara.membership_id,
              ara.subject_user_id, ara.role_id, ard.role_key, ard.display_name,
              ara.effective_from, ara.expires_at, ara.status, ara.version,
              ara.created_at, ara.revoked_at, ara.revoke_reason
       FROM access_role_assignments ara
       JOIN access_role_definitions ard ON ard.role_id = ara.role_id
       WHERE ara.organisation_id = ?
       ORDER BY ara.created_at DESC, ara.assignment_id DESC`,
      [organisationId],
    );
    return (rows || []).map((row) => ({
      assignmentId: row.assignment_id,
      organisationId: row.organisation_id,
      membershipId: row.membership_id,
      subjectUserId: row.subject_user_id,
      roleId: row.role_id,
      roleKey: row.role_key,
      roleDisplayName: row.display_name,
      effectiveAt: row.effective_from,
      expiresAt: row.expires_at,
      status: row.status,
      version: row.version,
      createdAt: row.created_at || null,
      revokedAt: row.revoked_at || null,
      revokeReason: row.revoke_reason || null,
    }));
  }

  async function listDelegations({ organisationId, executor } = {}) {
    organisationId = required(organisationId, "organisationId", 36);
    const [rows] = await exec(executor).execute(
      `SELECT d.delegation_id, d.organisation_id, d.grantor_user_id,
              d.grantee_user_id, d.effective_from, d.expires_at, d.reason,
              d.status, d.version, d.created_at, d.revoked_at, d.revoke_reason,
              dp.permission_key
       FROM access_delegations d
       LEFT JOIN access_delegation_permissions dp ON dp.delegation_id = d.delegation_id
       WHERE d.organisation_id = ?
       ORDER BY d.created_at DESC, d.delegation_id DESC, dp.permission_key`,
      [organisationId],
    );
    const delegations = new Map();
    for (const row of rows || []) {
      if (!delegations.has(row.delegation_id)) {
        delegations.set(row.delegation_id, {
          delegationId: row.delegation_id,
          organisationId: row.organisation_id,
          grantorUserId: row.grantor_user_id,
          granteeUserId: row.grantee_user_id,
          effectiveAt: row.effective_from,
          expiresAt: row.expires_at,
          reason: row.reason,
          status: row.status,
          version: row.version,
          createdAt: row.created_at || null,
          revokedAt: row.revoked_at || null,
          revokeReason: row.revoke_reason || null,
          permissionKeys: [],
        });
      }
      if (row.permission_key) delegations.get(row.delegation_id).permissionKeys.push(row.permission_key);
    }
    return [...delegations.values()];
  }

  async function listElevatedRequests({ organisationId, executor } = {}) {
    organisationId = required(organisationId, "organisationId", 36);
    const [rows] = await exec(executor).execute(
      `SELECT request_id, organisation_id, target_type, target_id,
              requested_permissions, requested_by, target_user_id, reason,
              decision, reviewed_by, requested_at, decided_at, decision_reason,
              version
       FROM access_elevated_requests
       WHERE organisation_id = ?
       ORDER BY requested_at DESC, request_id DESC`,
      [organisationId],
    );
    return (rows || []).map((row) => ({
      requestId: row.request_id,
      organisationId: row.organisation_id,
      targetType: row.target_type,
      targetId: row.target_id,
      permissionKeys: parseJsonArray(row.requested_permissions),
      requestedBy: row.requested_by,
      targetUserId: row.target_user_id || null,
      reason: row.reason,
      decision: row.decision,
      reviewedBy: row.reviewed_by || null,
      requestedAt: row.requested_at || null,
      decidedAt: row.decided_at || null,
      decisionReason: row.decision_reason || null,
      version: row.version,
    }));
  }

  return Object.freeze({
    listRoles,
    async getRole({ organisationId, roleId, executor } = {}) {
      roleId = required(roleId, "roleId", 36);
      return (await listRoles({ organisationId, executor })).find((role) => role.roleId === roleId) || null;
    },
    listAssignments,
    async getAssignment({ organisationId, assignmentId, executor } = {}) {
      assignmentId = required(assignmentId, "assignmentId", 36);
      return (await listAssignments({ organisationId, executor }))
        .find((row) => row.assignmentId === assignmentId) || null;
    },
    listDelegations,
    async getDelegation({ organisationId, delegationId, executor } = {}) {
      delegationId = required(delegationId, "delegationId", 36);
      return (await listDelegations({ organisationId, executor }))
        .find((row) => row.delegationId === delegationId) || null;
    },
    listElevatedRequests,
    async getElevatedRequest({ organisationId, requestId, executor } = {}) {
      requestId = required(requestId, "requestId", 36);
      return (await listElevatedRequests({ organisationId, executor }))
        .find((row) => row.requestId === requestId) || null;
    },
    async getMembership({ organisationId, membershipId, executor } = {}) {
      organisationId = required(organisationId, "organisationId", 36);
      membershipId = required(membershipId, "membershipId", 36);
      const [rows] = await exec(executor).execute(
        `SELECT membership_id, user_id, organisation_id, status, authorization_version
         FROM organisation_memberships
         WHERE organisation_id = ? AND membership_id = ? AND status = 'active'
         LIMIT 1`,
        [organisationId, membershipId],
      );
      const row = rows?.[0];
      return row ? {
        membershipId: row.membership_id,
        userId: row.user_id,
        organisationId: row.organisation_id,
        status: row.status,
        authorizationVersion: row.authorization_version,
      } : null;
    },
    async listAudit({
      organisationId, eventType = null, actorId = null, targetUserId = null,
      resourceType = null, from = null, to = null, pageSize = 50, cursor = null,
      executor,
    } = {}) {
      organisationId = required(organisationId, "organisationId", 36);
      pageSize = boundedPageSize(pageSize);
      const clauses = ["organisation_id = ?"];
      const params = [organisationId];
      if (eventType) { clauses.push("action = ?"); params.push(required(eventType, "eventType", 128)); }
      if (actorId) { clauses.push("actor_id = ?"); params.push(required(actorId, "actorId", 36)); }
      if (targetUserId) { clauses.push("subject_id = ?"); params.push(required(targetUserId, "targetUserId", 36)); }
      if (resourceType) { clauses.push("target_type = ?"); params.push(required(resourceType, "resourceType", 64)); }
      if (from) { clauses.push("occurred_at >= ?"); params.push(new Date(from)); }
      if (to) { clauses.push("occurred_at <= ?"); params.push(new Date(to)); }
      if (cursor) { clauses.push("audit_event_id < ?"); params.push(required(cursor, "cursor", 36)); }
      params.push(pageSize + 1);
      const [rows] = await exec(executor).execute(
        `SELECT audit_event_id, actor_type, actor_id, subject_id, action,
                target_type, target_id, before_version, after_version,
                reason, correlation_id, outcome, occurred_at
         FROM access_audit_events
         WHERE ${clauses.join(" AND ")}
         ORDER BY occurred_at DESC, audit_event_id DESC
         LIMIT ?`,
        params,
      );
      const visible = (rows || []).slice(0, pageSize).map((row) => ({
        auditEventId: row.audit_event_id,
        actorType: row.actor_type,
        actorId: row.actor_id,
        subjectId: row.subject_id || null,
        eventType: row.action,
        resourceType: row.target_type,
        resourceId: row.target_id,
        beforeVersion: row.before_version ?? null,
        afterVersion: row.after_version ?? null,
        reason: row.reason || null,
        correlationId: row.correlation_id || null,
        outcome: row.outcome,
        occurredAt: row.occurred_at,
      }));
      return {
        events: visible,
        nextCursor: (rows || []).length > pageSize ? visible.at(-1)?.auditEventId || null : null,
      };
    },
    async explainUserAccess({ organisationId, userId, executor } = {}) {
      organisationId = required(organisationId, "organisationId", 36);
      userId = required(userId, "userId", 36);
      const db = exec(executor);
      const [membershipRows] = await db.execute(
        `SELECT membership_id, user_id, organisation_id, status, authorization_version
         FROM organisation_memberships
         WHERE organisation_id = ? AND user_id = ? AND status = 'active'
         LIMIT 1`,
        [organisationId, userId],
      );
      const membership = membershipRows?.[0];
      if (!membership) return null;
      const resolved = await accessRepository.resolveEffectivePermissions({
        organisationId,
        userId,
        membershipId: membership.membership_id,
        executor: db,
      });
      return {
        userId,
        membershipId: membership.membership_id,
        organisationId,
        authorizationVersion: membership.authorization_version,
        permissions: resolved.permissionKeys,
        sources: resolved.permissions,
        resolvedAt: resolved.resolvedAt,
      };
    },
  });
}
