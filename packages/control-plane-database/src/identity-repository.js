import crypto from "node:crypto";

import { ControlPlaneConflictError } from "./errors.js";
import { projectSafeCredential, projectSafeUser } from "./projections.js";
import { executorOr } from "./transaction.js";
import {
  assertNoPlaintextPassword,
  AUTHENTICATION_PROVIDERS,
  canonicalRoleKey,
  CREDENTIAL_STATUSES,
  MEMBERSHIP_STATUSES,
  normalizeUsername,
  requireEnum,
  USER_STATUSES,
} from "./validation.js";

function conflict(error, message, code) {
  if (error?.code === "ER_DUP_ENTRY" || error?.errno === 1062) throw new ControlPlaneConflictError(message, code);
  throw error;
}

function mapMembership(row) {
  if (!row) return null;
  return {
    membershipId: row.membership_id,
    userId: row.user_id,
    organisationId: row.organisation_id,
    status: row.status,
    validFrom: row.valid_from || null,
    validUntil: row.valid_until || null,
    invitedBy: row.invited_by || null,
    activatedBy: row.activated_by || null,
    disabledBy: row.disabled_by || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function createIdentityRepository(defaultExecutor) {
  return {
    async createUser({ userId = crypto.randomUUID(), displayName, canonicalContact = null, status = "invited" }, { executor } = {}) {
      const db = executorOr(defaultExecutor, executor);
      requireEnum(status, USER_STATUSES, "user_status");
      try {
        await db.execute(
          `INSERT INTO users (user_id, display_name, canonical_contact, status) VALUES (?, ?, ?, ?)`,
          [userId, String(displayName || "").trim(), canonicalContact ? String(canonicalContact).trim().toLowerCase() : null, status],
        );
      } catch (error) {
        conflict(error, "User or canonical contact already exists.", "USER_CONFLICT");
      }
      return this.getSafeUser(userId, { executor: db });
    },

    async getSafeUser(userId, { executor } = {}) {
      const [rows] = await executorOr(defaultExecutor, executor).execute("SELECT * FROM users WHERE user_id = ? LIMIT 1", [userId]);
      return projectSafeUser(rows?.[0]);
    },

    async createCredential(input, { executor } = {}) {
      assertNoPlaintextPassword(input);
      const credentialId = input.credentialId || crypto.randomUUID();
      const username = normalizeUsername(input.username);
      const authenticationProvider = requireEnum(input.authenticationProvider || "local_password", AUTHENTICATION_PROVIDERS, "authentication_provider");
      const status = requireEnum(input.status || "pending_activation", CREDENTIAL_STATUSES, "credential_status");
      const db = executorOr(defaultExecutor, executor);
      try {
        await db.execute(
          `INSERT INTO credential_identities
            (credential_id, user_id, organisation_id, authentication_provider, normalized_username,
             external_subject, password_hash, password_algorithm, password_parameters, password_version, status)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [credentialId, input.userId, input.organisationId, authenticationProvider, username,
            input.externalSubject || null, input.passwordHash || null, input.passwordAlgorithm || null,
            input.passwordParameters ? JSON.stringify(input.passwordParameters) : null, input.passwordVersion || null,
            status],
        );
      } catch (error) {
        conflict(error, "Username already exists in this organisation and provider namespace.", "CREDENTIAL_USERNAME_CONFLICT");
      }
      return this.getSafeCredential(credentialId, { executor: db });
    },

    async getInternalCredentialByUsername({ organisationId, authenticationProvider = "local_password", username }, { executor } = {}) {
      const [rows] = await executorOr(defaultExecutor, executor).execute(
        `SELECT * FROM credential_identities
         WHERE organisation_id = ? AND authentication_provider = ? AND normalized_username = ? LIMIT 1`,
        [organisationId, authenticationProvider, normalizeUsername(username)],
      );
      return rows?.[0] || null;
    },

    async getSafeCredential(credentialId, { executor } = {}) {
      const [rows] = await executorOr(defaultExecutor, executor).execute(
        "SELECT * FROM credential_identities WHERE credential_id = ? LIMIT 1",
        [credentialId],
      );
      return projectSafeCredential(rows?.[0]);
    },

    async createMembership(input, { executor } = {}) {
      const membershipId = input.membershipId || crypto.randomUUID();
      requireEnum(input.status || "invited", MEMBERSHIP_STATUSES, "membership_status");
      const db = executorOr(defaultExecutor, executor);
      try {
        await db.execute(
          `INSERT INTO organisation_memberships
            (membership_id, user_id, organisation_id, status, valid_from, valid_until, invited_by)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [membershipId, input.userId, input.organisationId, input.status || "invited", input.validFrom || null, input.validUntil || null, input.invitedBy || null],
        );
      } catch (error) {
        conflict(error, "User already has a membership in this organisation.", "MEMBERSHIP_CONFLICT");
      }
      return this.getMembership(membershipId, { executor: db });
    },

    async getMembership(membershipId, { executor } = {}) {
      const [rows] = await executorOr(defaultExecutor, executor).execute(
        "SELECT * FROM organisation_memberships WHERE membership_id = ? LIMIT 1",
        [membershipId],
      );
      return mapMembership(rows?.[0]);
    },

    async resolveRole(roleKey, { executor } = {}) {
      const canonical = canonicalRoleKey(roleKey);
      const [rows] = await executorOr(defaultExecutor, executor).execute(
        `SELECT role_id, role_key, display_name, organisation_scope, definition_version
         FROM roles WHERE role_key = ? LIMIT 1`,
        [canonical],
      );
      return rows?.[0] ? {
        roleId: rows[0].role_id,
        roleKey: rows[0].role_key,
        displayName: rows[0].display_name,
        organisationScope: rows[0].organisation_scope,
        definitionVersion: Number(rows[0].definition_version),
      } : null;
    },

    async assignRole({ membershipId, roleId, assignedBy = null }, { executor } = {}) {
      const db = executorOr(defaultExecutor, executor);
      await db.execute(
        `INSERT INTO membership_roles (membership_id, role_id, assigned_by)
         VALUES (?, ?, ?)
         ON DUPLICATE KEY UPDATE revoked_at = NULL, assigned_by = VALUES(assigned_by), assigned_at = UTC_TIMESTAMP(3)`,
        [membershipId, roleId, assignedBy],
      );
      return { membershipId, roleId };
    },

    async listMembershipRoles(membershipId, { executor } = {}) {
      const [rows] = await executorOr(defaultExecutor, executor).execute(
        `SELECT r.role_key FROM membership_roles mr JOIN roles r ON r.role_id = mr.role_id
         WHERE mr.membership_id = ? AND mr.revoked_at IS NULL ORDER BY r.role_key`,
        [membershipId],
      );
      return (rows || []).map((row) => row.role_key);
    },
  };
}
