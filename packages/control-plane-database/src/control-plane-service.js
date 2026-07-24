import crypto from "node:crypto";

import { ControlPlaneConflictError, ControlPlaneNotFoundError, ControlPlaneValidationError } from "./errors.js";
import { hashPassword, passwordParametersRecord, ARGON2ID_VERSION } from "./password.js";
import { normalizeUsername } from "./validation.js";
import { withControlPlaneTransaction } from "./transaction.js";

const ORGANISATION_TRANSITIONS = Object.freeze({
  draft: ["provisioning", "failed", "archived"],
  provisioning: ["ready_for_activation", "failed"],
  ready_for_activation: ["active", "failed"],
  active: ["suspended", "archived"],
  suspended: ["active", "archived"],
  failed: ["provisioning", "archived"],
  archived: [],
});

const PROVISIONING_TRANSITIONS = Object.freeze({
  pending: ["running", "failed", "quarantined"],
  running: ["completed", "failed", "compensating", "quarantined"],
  failed: ["pending", "compensating", "quarantined"],
  compensating: ["compensated", "failed", "quarantined"],
  completed: [],
  compensated: [],
  quarantined: ["compensating"],
});

const CANONICAL_PRIVATE_SCHEMA_VERSION =
  "14";

export function createControlPlaneService({ pool, repositories }) {
  if (!pool || !repositories) throw new TypeError("Control-plane pool and repositories are required.");

  async function audit(executor, input) {
    return repositories.security.recordPlatformAudit(input, { executor });
  }

  return {
    async reserveSlug(input, actor) {
      return withControlPlaneTransaction(pool, async (executor) => {
        const slug = await repositories.organisations.reserveSlug(input.slug, {
          organisationId: input.organisationId || null,
          slugType: input.slugType || "reserved",
          redirectToSlug: input.redirectToSlug || null,
          executor,
        });
        await audit(executor, {
          actorType: actor?.type || "system", actorId: actor?.id || null,
          organisationScopeId: input.organisationId || null, action: "organisation_slug.reserve",
          targetType: "organisation_slug", targetId: slug,
          afterSummary: { slugType: input.slugType || "reserved", redirectToSlug: input.redirectToSlug || null },
          correlationId: actor?.correlationId || null, outcome: "success", source: actor?.source || "control-plane-service",
        });
        return slug;
      });
    },

    async createDraftOrganisation(input, actor) {
      return withControlPlaneTransaction(pool, async (executor) => {
        const organisation = await repositories.organisations.createDraft(input, { executor });
        await audit(executor, {
          actorType: actor?.type || "system", actorId: actor?.id || null,
          organisationScopeId: organisation.organisationId, action: "organisation.create_draft",
          targetType: "organisation", targetId: organisation.organisationId,
          afterSummary: { displayName: organisation.displayName, canonicalSlug: organisation.canonicalSlug, status: organisation.status },
          correlationId: actor?.correlationId || null, outcome: "success", source: actor?.source || "control-plane-service",
        });
        return organisation;
      });
    },

    async transitionOrganisation(organisationId, toStatus, { suspensionReason = null, actor } = {}) {
      return withControlPlaneTransaction(pool, async (executor) => {
        const current = await repositories.organisations.getById(organisationId, { executor });
        if (!current) throw new ControlPlaneNotFoundError("Organisation was not found.", "ORGANISATION_NOT_FOUND");
        if (!(ORGANISATION_TRANSITIONS[current.status] || []).includes(toStatus)) {
          throw new ControlPlaneConflictError(`Organisation cannot transition from ${current.status} to ${toStatus}.`, "INVALID_ORGANISATION_TRANSITION");
        }
        const updated = await repositories.organisations.updateStatus(organisationId, toStatus, { suspensionReason, executor });
        await audit(executor, {
          actorType: actor?.type || "system", actorId: actor?.id || null, organisationScopeId: organisationId,
          action: "organisation.transition", targetType: "organisation", targetId: organisationId,
          beforeSummary: { status: current.status }, afterSummary: { status: updated.status },
          correlationId: actor?.correlationId || null, outcome: "success", source: actor?.source || "control-plane-service",
        });
        return updated;
      });
    },

    async activateOrganisation(organisationId, actor) {
      return withControlPlaneTransaction(pool, async (executor) => {
        const organisation = await repositories.organisations.getById(organisationId, { executor });
        if (!organisation) throw new ControlPlaneNotFoundError("Organisation was not found.", "ORGANISATION_NOT_FOUND");
        if (organisation.organisationType !== "medical_scheme" || organisation.status !== "ready_for_activation") {
          throw new ControlPlaneConflictError(
            "Only a ready medical-scheme organisation can be activated.",
            "ORGANISATION_NOT_READY",
          );
        }

        const route =
          await repositories.routes
            .getInternalLatestReadyForOrganisation(
              organisationId,
              {
                executor,
              },
            );

        if (
          !route
          || route.route_type
            !== "private_database"
          || String(
            route.schema_version,
          )
            !== CANONICAL_PRIVATE_SCHEMA_VERSION
        ) {
          throw new ControlPlaneConflictError(
            `A schema-${CANONICAL_PRIVATE_SCHEMA_VERSION} private route is required.`,
            "PRIVATE_ROUTE_NOT_READY",
          );
        }

        const [
          gateRows,
        ] =
          await executor.execute(
    `
              SELECT
                (
                  SELECT COUNT(*)
                  FROM organisation_schema_status
                  WHERE organisation_id = ?
                    AND route_id = ?
                    AND expected_schema_version = ?
                    AND observed_schema_version = ?
                    AND compatibility_status =
                      'compatible'
                ) AS schema_ready,

                (
                  SELECT COUNT(*)
                  FROM worker_routing_status
                  WHERE organisation_id = ?
                    AND worker_type =
                      'report-worker'
                    AND status =
                        'ready'
                ) AS worker_ready,

                (
                  SELECT COUNT(*)
                  FROM report_storage_partitions
                  WHERE organisation_id = ?
                    AND provisioning_status =
                      'ready'
                    AND retired_at IS NULL
                ) AS storage_ready,

                (
                  SELECT COUNT(*)
                  FROM organisation_memberships m
                  JOIN membership_roles mr
                    ON mr.membership_id =
                      m.membership_id
                    AND mr.revoked_at IS NULL
                  JOIN roles r
                    ON r.role_id =
                      mr.role_id
                  WHERE m.organisation_id = ?
                    AND m.status =
                      'active'
                    AND r.role_key =
                      'scheme_administrator'
                ) AS admin_ready
            `,
            [
              organisationId,
              route.route_id,
              CANONICAL_PRIVATE_SCHEMA_VERSION,
              CANONICAL_PRIVATE_SCHEMA_VERSION,
              organisationId,
              organisationId,
              organisationId,
            ],
          );
        
        const gates = gateRows?.[0] || {};
        if (![gates.schema_ready, gates.worker_ready, gates.storage_ready, gates.admin_ready].every((value) => Number(value) > 0)) {
          throw new ControlPlaneConflictError(
            "Schema, report worker, storage, and initial administrator checks must pass before activation.",
            "ACTIVATION_GATES_FAILED",
          );
        }
        const activatedRoute = await repositories.routes.activate(route.route_id, organisationId, { executor });
        const activatedOrganisation = await repositories.organisations.updateStatus(organisationId, "active", { executor });
        await audit(executor, {
          actorType: actor?.type || "user", actorId: actor?.id || null,
          organisationScopeId: organisationId, action: "organisation.activate",
          targetType: "organisation", targetId: organisationId,
          beforeSummary: { status: organisation.status, routeId: route.route_id },
          afterSummary: { status: activatedOrganisation.status, routeId: activatedRoute.routeId },
          correlationId: actor?.correlationId || null, outcome: "success",
          source: actor?.source || "control-plane-service",
        });
        return { organisation: activatedOrganisation, route: activatedRoute };
      });
    },

    async createIntegrationCredential({ organisationId, displayName, serviceActorId, expiresAt = null }, actor) {
      const rawToken = `cg_live_${crypto.randomBytes(32).toString("base64url")}`;
      const tokenHash = crypto.createHash("sha256").update(rawToken).digest("hex");
      const tokenPrefix = rawToken.slice(0, 16);
      return withControlPlaneTransaction(pool, async (executor) => {
        const organisation = await repositories.organisations.getById(organisationId, { executor });
        if (!organisation || organisation.organisationType !== "medical_scheme") {
          throw new ControlPlaneNotFoundError("Medical-scheme organisation was not found.", "ORGANISATION_NOT_FOUND");
        }
        if (organisation.status !== "active" || organisation.activationState !== "activated") {
          throw new ControlPlaneConflictError(
            "Integration credentials can be created only after organisation activation.",
            "ORGANISATION_NOT_ACTIVE",
          );
        }
        const credential = await repositories.integrationCredentials.create({
          organisationId,
          displayName,
          serviceActorId,
          tokenPrefix,
          tokenHash,
          expiresAt,
          createdBy: actor?.id || null,
        }, { executor });
        await audit(executor, {
          actorType: actor?.type || "user", actorId: actor?.id || null,
          organisationScopeId: organisationId, action: "integration_credential.create",
          targetType: "integration_credential", targetId: credential.integrationCredentialId,
          afterSummary: { displayName: credential.displayName, serviceActorId: credential.serviceActorId, roleKey: credential.roleKey },
          correlationId: actor?.correlationId || null, outcome: "success",
          source: actor?.source || "control-plane-service",
        });
        return { credential, bearerToken: rawToken };
      });
    },

    async revokeIntegrationCredential({ organisationId, integrationCredentialId }, actor) {
      return withControlPlaneTransaction(pool, async (executor) => {
        const credential = await repositories.integrationCredentials.revoke({
          organisationId,
          integrationCredentialId,
          revokedBy: actor?.id || null,
        }, { executor });
        await audit(executor, {
          actorType: actor?.type || "user", actorId: actor?.id || null,
          organisationScopeId: organisationId, action: "integration_credential.revoke",
          targetType: "integration_credential", targetId: integrationCredentialId,
          afterSummary: { status: credential.status, serviceActorId: credential.serviceActorId },
          correlationId: actor?.correlationId || null, outcome: "success",
          source: actor?.source || "control-plane-service",
        });
        return credential;
      });
    },

    async createMembership(input, actor) {
      return withControlPlaneTransaction(pool, async (executor) => {
        const membership = await repositories.identity.createMembership(input, { executor });
        await audit(executor, {
          actorType: actor?.type || "system", actorId: actor?.id || null, organisationScopeId: input.organisationId,
          action: "membership.create", targetType: "membership", targetId: membership.membershipId,
          afterSummary: { userId: input.userId, status: membership.status }, correlationId: actor?.correlationId || null,
          outcome: "success", source: actor?.source || "control-plane-service",
        });
        return membership;
      });
    },

    async assignMembershipRole({ membershipId, roleKey, assignedBy = null, actorRoleKeys = [] }, actor) {
      return withControlPlaneTransaction(pool, async (executor) => {
        const membership = await repositories.identity.getMembership(membershipId, { executor });
        if (!membership) throw new ControlPlaneNotFoundError("Membership was not found.", "MEMBERSHIP_NOT_FOUND");
        if (membership.status !== "active") {
          throw new ControlPlaneConflictError("Only an active membership can receive active role authority.", "INACTIVE_MEMBERSHIP_ROLE_ASSIGNMENT");
        }
        const organisation = await repositories.organisations.getById(membership.organisationId, { executor });
        const role = await repositories.identity.resolveRole(roleKey, { executor });
        if (!role) throw new ControlPlaneNotFoundError("Role was not found.", "ROLE_NOT_FOUND");
        if (role.organisationScope !== organisation.organisationType) {
          throw new ControlPlaneValidationError("Role scope does not match the organisation type.", "ROLE_SCOPE_MISMATCH");
        }
        if (role.roleKey === "platform_administrator" && !actorRoleKeys.includes("platform_administrator")) {
          throw new ControlPlaneValidationError("Only a platform administrator may assign platform administrator.", "PLATFORM_ROLE_ASSIGNMENT_FORBIDDEN");
        }
        const assignment = await repositories.identity.assignRole({ membershipId, roleId: role.roleId, assignedBy }, { executor });
        await audit(executor, {
          actorType: actor?.type || "user", actorId: actor?.id || assignedBy, organisationScopeId: membership.organisationId,
          action: "membership.role_assign", targetType: "membership", targetId: membershipId,
          afterSummary: { roleKey: role.roleKey }, correlationId: actor?.correlationId || null,
          outcome: "success", source: actor?.source || "control-plane-service",
        });
        return assignment;
      });
    },

    async registerRoute(input, actor) {
      return withControlPlaneTransaction(pool, async (executor) => {
        const organisation = await repositories.organisations.getById(input.organisationId, { executor });
        if (!organisation) throw new ControlPlaneNotFoundError("Organisation was not found.", "ORGANISATION_NOT_FOUND");
        if (organisation.organisationType === "platform" && input.routeType !== "platform_none") {
          throw new ControlPlaneValidationError("A platform organisation must use platform_none routing.", "PLATFORM_ROUTE_REQUIRED");
        }
        if (organisation.organisationType === "medical_scheme" && input.routeType === "platform_none") {
          throw new ControlPlaneValidationError("A medical-scheme organisation requires an operational route type.", "MEDICAL_SCHEME_ROUTE_REQUIRED");
        }
        const route = await repositories.routes.register(input, { executor });
        await audit(executor, {
          actorType: actor?.type || "system", actorId: actor?.id || null, organisationScopeId: input.organisationId,
          action: "data_plane_route.register", targetType: "data_plane_route", targetId: route.routeId,
          afterSummary: { routeType: route.routeType, generation: route.routeGeneration, provisioningStatus: route.provisioningStatus },
          correlationId: actor?.correlationId || null, outcome: "success", source: actor?.source || "control-plane-service",
        });
        return route;
      });
    },

    async mapLegacyTenant(input, actor) {
      return withControlPlaneTransaction(pool, async (executor) => {
        const organisation = await repositories.organisations.getById(input.organisationId, { executor });
        if (!organisation) throw new ControlPlaneNotFoundError("Organisation was not found.", "ORGANISATION_NOT_FOUND");
        const mapping = await repositories.legacyMappings.create(input, { executor });
        await audit(executor, {
          actorType: actor?.type || "system", actorId: actor?.id || null, organisationScopeId: input.organisationId,
          action: "legacy_tenant.map", targetType: "legacy_tenant_mapping", targetId: mapping.mappingId,
          afterSummary: { legacyTenantId: mapping.legacyTenantId, legacyTenantSlug: mapping.legacyTenantSlug, status: mapping.migrationStatus },
          correlationId: actor?.correlationId || null, outcome: "success", source: actor?.source || "legacy-inventory",
        });
        return mapping;
      });
    },

    async transitionProvisioningOperation(operationId, toStatus, { error = null } = {}) {
      const operation = await repositories.provisioning.getOperation(operationId);
      if (!operation) throw new ControlPlaneNotFoundError("Provisioning operation was not found.", "PROVISIONING_OPERATION_NOT_FOUND");
      const allowed = PROVISIONING_TRANSITIONS[operation.status] || [];
      if (!allowed.includes(toStatus)) {
        throw new ControlPlaneConflictError(`Provisioning cannot transition from ${operation.status} to ${toStatus}.`, "INVALID_PROVISIONING_TRANSITION");
      }
      return repositories.provisioning.transitionOperation(operationId, [operation.status], toStatus, { error });
    },

    async listOrganisations({ status = null } = {}) {
      const organisations = await repositories.organisations.list();
      if (!status) return organisations;
      return organisations.filter((item) => item.status === status);
    },

    async requestProvisioningOperation({ organisationId, operationType = "onboard_private_database", requestedBy, correlationId = null }, actor) {
      return withControlPlaneTransaction(pool, async (executor) => {
        const organisation = await repositories.organisations.getById(organisationId, { executor });
        if (!organisation) throw new ControlPlaneNotFoundError("Organisation was not found.", "ORGANISATION_NOT_FOUND");
        const isUpgrade = operationType === "upgrade_private_database";
        const allowedStatuses = isUpgrade
          ? ["active", "suspended", "ready_for_activation"]
          : ["draft", "failed", "provisioning"];
        if (!allowedStatuses.includes(organisation.status)) {
          throw new ControlPlaneConflictError("Provisioning can be requested only for draft, failed, or provisioning organisations.", "ORGANISATION_NOT_PROVISIONABLE");
        }

        const existing = await repositories.provisioning.listOperations({ organisationId, statuses: ["pending", "running"], limit: 1, executor });
        if (existing.length > 0) {
          return existing[0];
        }

        if (!isUpgrade && organisation.status !== "provisioning") {
          await repositories.organisations.updateStatus(organisationId, "provisioning", { executor });
        }

        const operation = await repositories.provisioning.createOperation({
          organisationId,
          operationType,
          requestedBy,
          correlationId,
        }, { executor });

        await audit(executor, {
          actorType: actor?.type || "system",
          actorId: actor?.id || null,
          organisationScopeId: organisationId,
          action: "organisation.provisioning_requested",
          targetType: "provisioning_operation",
          targetId: operation.operationId,
          afterSummary: { status: operation.status, operationType: operation.operationType },
          correlationId: actor?.correlationId || correlationId || null,
          outcome: "success",
          source: actor?.source || "control-plane-service",
        });

        return operation;
      });
    },

    async getProvisioningOperationWithSteps(operationId) {
      const operation = await repositories.provisioning.getOperation(operationId);
      if (!operation) throw new ControlPlaneNotFoundError("Provisioning operation was not found.", "PROVISIONING_OPERATION_NOT_FOUND");
      const steps = await repositories.provisioning.listSteps(operationId);
      return { ...operation, steps };
    },

    async retryProvisioningOperation(operationId, actor) {
      return withControlPlaneTransaction(pool, async (executor) => {
        const operation = await repositories.provisioning.getOperation(operationId, { executor });
        if (!operation) throw new ControlPlaneNotFoundError("Provisioning operation was not found.", "PROVISIONING_OPERATION_NOT_FOUND");
        if (!["failed", "quarantined", "compensated"].includes(operation.status)) {
          throw new ControlPlaneConflictError("Provisioning retry is not allowed from the current state.", "PROVISIONING_RETRY_NOT_ALLOWED");
        }
        const updated = await repositories.provisioning.transitionOperation(
          operationId,
          [operation.status],
          "pending",
          { executor },
        );
        await audit(executor, {
          actorType: actor?.type || "user",
          actorId: actor?.id || null,
          organisationScopeId: operation.organisationId,
          action: "organisation.provisioning_retry_requested",
          targetType: "provisioning_operation",
          targetId: operationId,
          beforeSummary: { status: operation.status },
          afterSummary: { status: updated.status },
          correlationId: actor?.correlationId || null,
          outcome: "success",
          source: actor?.source || "control-plane-service",
        });
        return updated;
      });
    },

    async cancelProvisioningOperation(operationId, actor) {
      return withControlPlaneTransaction(pool, async (executor) => {
        const operation = await repositories.provisioning.getOperation(operationId, { executor });
        if (!operation) throw new ControlPlaneNotFoundError("Provisioning operation was not found.", "PROVISIONING_OPERATION_NOT_FOUND");
        if (!["pending", "running", "failed", "compensating"].includes(operation.status)) {
          throw new ControlPlaneConflictError("Provisioning cancel is not allowed from the current state.", "PROVISIONING_CANCEL_NOT_ALLOWED");
        }
        const updated = await repositories.provisioning.transitionOperation(
          operationId,
          [operation.status],
          "compensating",
          { executor },
        );
        await audit(executor, {
          actorType: actor?.type || "user",
          actorId: actor?.id || null,
          organisationScopeId: operation.organisationId,
          action: "organisation.provisioning_cancel_requested",
          targetType: "provisioning_operation",
          targetId: operationId,
          beforeSummary: { status: operation.status },
          afterSummary: { status: updated.status },
          correlationId: actor?.correlationId || null,
          outcome: "success",
          source: actor?.source || "control-plane-service",
        });
        return updated;
      });
    },

    async createAdminInvitation({ organisationId, email, invitedBy = null, expiresInHours = 72 }, actor) {
      return withControlPlaneTransaction(pool, async (executor) => {
        const organisation = await repositories.organisations.getById(organisationId, { executor });
        if (!organisation) throw new ControlPlaneNotFoundError("Organisation was not found.", "ORGANISATION_NOT_FOUND");

        const rawToken = crypto.randomBytes(32).toString("base64url");
        const tokenHash = crypto.createHash("sha256").update(rawToken).digest("hex");
        const invitationId = crypto.randomUUID();
        const expiresAt = new Date(Date.now() + expiresInHours * 3600_000);

        await executor.execute(
          `INSERT INTO admin_invitations (invitation_id, organisation_id, email, token_hash, status, invited_by, expires_at)
           VALUES (?, ?, ?, ?, 'pending', ?, ?)`,
          [invitationId, organisationId, email.trim().toLowerCase(), tokenHash, invitedBy, expiresAt],
        );

        await audit(executor, {
          actorType: actor?.type || "user", actorId: actor?.id || null,
          organisationScopeId: organisationId, action: "admin_invitation.create",
          targetType: "admin_invitation", targetId: invitationId,
          afterSummary: { email: email.trim().toLowerCase(), expiresAt: expiresAt.toISOString() },
          correlationId: actor?.correlationId || null, outcome: "success",
          source: actor?.source || "control-plane-service",
        });

        return { invitationId, token: rawToken, email: email.trim().toLowerCase(), expiresAt };
      });
    },

    async getInvitationByToken(rawToken) {
      const tokenHash = crypto.createHash("sha256").update(rawToken).digest("hex");
      const [rows] = await pool.execute(
        `SELECT i.*, o.display_name AS organisation_name, o.canonical_slug
         FROM admin_invitations i
         JOIN organisations o ON o.organisation_id = i.organisation_id
         WHERE i.token_hash = ? LIMIT 1`,
        [tokenHash],
      );
      const row = rows?.[0];
      if (!row) return null;
      return {
        invitationId: row.invitation_id,
        organisationId: row.organisation_id,
        organisationName: row.organisation_name,
        canonicalSlug: row.canonical_slug,
        email: row.email,
        status: row.status,
        expiresAt: row.expires_at,
        consumedAt: row.consumed_at,
      };
    },

    async listInvitations(organisationId) {
      const [rows] = await pool.execute(
        `SELECT invitation_id, email, status, created_at, expires_at, consumed_at
         FROM admin_invitations WHERE organisation_id = ? ORDER BY created_at DESC`,
        [organisationId],
      );
      return (rows || []).map((row) => ({
        invitationId: row.invitation_id,
        email: row.email,
        status: row.status,
        createdAt: row.created_at,
        expiresAt: row.expires_at,
        consumedAt: row.consumed_at,
      }));
    },

    async signupWithInvitation({ token, displayName, username, password }, actor) {
      const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
      return withControlPlaneTransaction(pool, async (executor) => {
        const [invRows] = await executor.execute(
          `SELECT * FROM admin_invitations WHERE token_hash = ? FOR UPDATE`,
          [tokenHash],
        );
        const invitation = invRows?.[0];
        if (!invitation) throw new ControlPlaneNotFoundError("Invitation not found or invalid.", "INVITATION_NOT_FOUND");
        if (invitation.status !== "pending") {
          throw new ControlPlaneConflictError("This invitation has already been used or revoked.", "INVITATION_CONSUMED");
        }
        if (new Date(invitation.expires_at) < new Date()) {
          await executor.execute(`UPDATE admin_invitations SET status = 'expired' WHERE invitation_id = ?`, [invitation.invitation_id]);
          throw new ControlPlaneConflictError("This invitation has expired.", "INVITATION_EXPIRED");
        }

        const organisationId = invitation.organisation_id;

        // Draft onboarding may already have created the administrator's
        // platform-level user identity. Reuse that identity instead of
        // attempting to create a duplicate canonical contact.
        let user =
          await repositories.identity
            .getSafeUserByCanonicalContact(
              invitation.email,
              {
                executor,
                lockForUpdate:
                  true,
              },
            );

        if (!user) {
          user =
            await repositories.identity
              .createUser(
                {
                  displayName:
                    displayName.trim(),
                  canonicalContact:
                    invitation.email,
                  status:
                    "active",
                },
                {
                  executor,
                },
              );
        }

        // Create credential
        const passwordHash = await hashPassword(password);
        await repositories.identity.createCredential({
          userId: user.userId,
          organisationId,
          username: normalizeUsername(username),
          status: "active",
          passwordHash,
          passwordAlgorithm: "argon2id",
          passwordParameters: passwordParametersRecord(),
          passwordVersion: ARGON2ID_VERSION,
        }, { executor });

        // Reuse the onboarding membership when it already exists.
        // Invitation-only users receive a membership in the invited
        // organisation.
        let membership =
          await repositories.identity
            .getMembershipForUserOrganisation(
              {
                userId:
                  user.userId,
                organisationId,
              },
              {
                executor,
                lockForUpdate:
                  true,
              },
            );

        if (!membership) {
          membership =
            await repositories.identity
              .createMembership(
                {
                  userId:
                    user.userId,
                  organisationId,
                  status:
                    "active",
                  validFrom:
                    new Date(),
                  invitedBy:
                    invitation.invited_by,
                },
                {
                  executor,
                },
              );
        }

        // Assign scheme_administrator role
        const role = await repositories.identity.resolveRole("scheme_administrator", { executor });
        if (role) {
          await repositories.identity.assignRole({
            membershipId: membership.membershipId,
            roleId: role.roleId,
            assignedBy: invitation.invited_by,
          }, { executor });
        }

        // Consume the invitation
        await executor.execute(
          `UPDATE admin_invitations SET status = 'consumed', consumed_at = UTC_TIMESTAMP(3), consumed_by_user_id = ? WHERE invitation_id = ?`,
          [user.userId, invitation.invitation_id],
        );

        await audit(executor, {
          actorType: "user", actorId: user.userId,
          organisationScopeId: organisationId, action: "admin_invitation.consumed",
          targetType: "admin_invitation", targetId: invitation.invitation_id,
          afterSummary: { userId: user.userId, username: normalizeUsername(username) },
          correlationId: actor?.correlationId || null, outcome: "success",
          source: "signup",
        });

        return { user, membership, organisationId };
      });
    },

    async createSchemeUser({ organisationId, displayName, username, password, roleKey }, actor) {
      return withControlPlaneTransaction(pool, async (executor) => {
        const organisation = await repositories.organisations.getById(organisationId, { executor });
        if (!organisation || organisation.organisationType !== "medical_scheme") {
          throw new ControlPlaneNotFoundError("Medical-scheme organisation was not found.", "ORGANISATION_NOT_FOUND");
        }

        const passwordHash = await hashPassword(password);
        const user = await repositories.identity.createUser({
          displayName: displayName.trim(),
          canonicalContact: `${normalizeUsername(username)}@${organisation.canonicalSlug}.local`,
          status: "active",
        }, { executor });

        await repositories.identity.createCredential({
          userId: user.userId,
          organisationId,
          username: normalizeUsername(username),
          status: "active",
          passwordHash,
          passwordAlgorithm: "argon2id",
          passwordParameters: passwordParametersRecord(),
          passwordVersion: ARGON2ID_VERSION,
        }, { executor });

        const membership = await repositories.identity.createMembership({
          userId: user.userId,
          organisationId,
          status: "active",
          validFrom: new Date(),
          invitedBy: actor?.id || null,
        }, { executor });

        if (roleKey) {
          const role = await repositories.identity.resolveRole(roleKey, { executor });
          if (!role) throw new ControlPlaneNotFoundError("Role was not found.", "ROLE_NOT_FOUND");
          if (role.organisationScope !== "medical_scheme") {
            throw new ControlPlaneValidationError("Role scope does not match the organisation type.", "ROLE_SCOPE_MISMATCH");
          }
          await repositories.identity.assignRole({
            membershipId: membership.membershipId,
            roleId: role.roleId,
            assignedBy: actor?.id || null,
          }, { executor });
        }

        await audit(executor, {
          actorType: actor?.type || "user", actorId: actor?.id || null,
          organisationScopeId: organisationId, action: "scheme_user.create",
          targetType: "user", targetId: user.userId,
          afterSummary: { displayName: user.displayName, username: normalizeUsername(username), roleKey },
          correlationId: actor?.correlationId || null, outcome: "success",
          source: actor?.source || "scheme-admin",
        });

        return { user, membership };
      });
    },

    async disableSchemeUser({ organisationId, userId }, actor) {
      return withControlPlaneTransaction(pool, async (executor) => {
        const user = await repositories.identity.updateUserStatus(userId, "disabled", { executor });

        // Also disable the membership
        const [membershipRows] = await executor.execute(
          `SELECT membership_id FROM organisation_memberships WHERE user_id = ? AND organisation_id = ? LIMIT 1`,
          [userId, organisationId],
        );
        if (membershipRows?.[0]) {
          await repositories.identity.updateMembershipStatus(membershipRows[0].membership_id, "disabled", { executor });
        }

        // Disable credentials
        const [credRows] = await executor.execute(
          `SELECT credential_id FROM credential_identities WHERE user_id = ? AND organisation_id = ?`,
          [userId, organisationId],
        );
        for (const cred of credRows || []) {
          await repositories.identity.updateCredentialStatus(cred.credential_id, "disabled", { executor });
        }

        await audit(executor, {
          actorType: actor?.type || "user", actorId: actor?.id || null,
          organisationScopeId: organisationId, action: "scheme_user.disable",
          targetType: "user", targetId: userId,
          afterSummary: { status: "disabled" },
          correlationId: actor?.correlationId || null, outcome: "success",
          source: actor?.source || "scheme-admin",
        });

        return user;
      });
    },
  };
}
