import crypto from "node:crypto";

import { createControlPlaneService as createBaseControlPlaneService } from "./control-plane-service.js";
import {
  ControlPlaneConflictError,
  ControlPlaneNotFoundError,
} from "./errors.js";
import { withControlPlaneTransaction } from "./transaction.js";

const CANONICAL_PRIVATE_SCHEMA_VERSION = "14";

export function createSignupCredentialGuardedIdentityRepository(identity) {
  if (!identity || typeof identity !== "object") {
    throw new TypeError("An identity repository is required.");
  }

  // Many control-plane service tests intentionally use partial repository
  // doubles for operations that never create credentials. Leave those
  // fixtures unchanged instead of making unrelated service construction fail.
  if (typeof identity.createCredential !== "function") {
    return identity;
  }

  // The production identity repository exposes
  // getInternalCredentialByUsername(). Lightweight credential-specific tests
  // may omit it, so use it only as a capability marker for the production
  // repository before installing the transaction-scoped guard.
  if (typeof identity.getInternalCredentialByUsername !== "function") {
    return identity;
  }

  return {
    ...identity,

    async createCredential(input, options = {}) {
      const authenticationProvider = String(
        input?.authenticationProvider || "local_password",
      ).trim();

      if (authenticationProvider === "local_password") {
        const userId = String(input?.userId || "").trim();
        const organisationId = String(input?.organisationId || "").trim();
        const executor = options?.executor;

        if (!userId || !organisationId) {
          throw new TypeError(
            "userId and organisationId are required for local credential creation.",
          );
        }

        if (!executor || typeof executor.execute !== "function") {
          throw new TypeError(
            "A transaction executor is required for guarded local credential creation.",
          );
        }

        const [rows] = await executor.execute(
          `SELECT credential_id
           FROM credential_identities
           WHERE user_id = ?
             AND organisation_id = ?
             AND authentication_provider = 'local_password'
           LIMIT 1
           FOR UPDATE`,
          [userId, organisationId],
        );

        if (rows?.[0]) {
          throw new ControlPlaneConflictError(
            "This administrator already has a local-password credential.",
            "ADMIN_CREDENTIAL_ALREADY_CONFIGURED",
          );
        }
      }

      return identity.createCredential(input, options);
    },
  };
}

function createExpiredInvitationAwareSignup({ pool, delegate }) {
  return async function signupWithInvitation(input, actor) {
    const tokenHash = crypto
      .createHash("sha256")
      .update(input.token)
      .digest("hex");

    const invitationState = await withControlPlaneTransaction(
      pool,
      async (executor) => {
        const [rows] = await executor.execute(
          `SELECT invitation_id, status, expires_at
           FROM admin_invitations
           WHERE token_hash = ?
           LIMIT 1
           FOR UPDATE`,
          [tokenHash],
        );

        const invitation = rows?.[0];

        if (!invitation) {
          throw new ControlPlaneNotFoundError(
            "Invitation not found or invalid.",
            "INVITATION_NOT_FOUND",
          );
        }

        if (invitation.status === "expired") {
          return {
            expired: true,
            invitationId: invitation.invitation_id,
          };
        }

        if (invitation.status !== "pending") {
          throw new ControlPlaneConflictError(
            "This invitation has already been used or revoked.",
            "INVITATION_CONSUMED",
          );
        }

        if (new Date(invitation.expires_at) < new Date()) {
          await executor.execute(
            `UPDATE admin_invitations
             SET status = 'expired'
             WHERE invitation_id = ?
               AND status = 'pending'`,
            [invitation.invitation_id],
          );

          return {
            expired: true,
            invitationId: invitation.invitation_id,
          };
        }

        return {
          expired: false,
        };
      },
    );

    if (invitationState.expired) {
      throw new ControlPlaneConflictError(
        "This invitation has expired.",
        "INVITATION_EXPIRED",
      );
    }

    return delegate(input, actor);
  };
}

function createCredentialGatedActivation({ pool, repositories }) {
  return async function activateOrganisation(organisationId, actor) {
    return withControlPlaneTransaction(pool, async (executor) => {
      const organisation = await repositories.organisations.getById(
        organisationId,
        { executor },
      );

      if (!organisation) {
        throw new ControlPlaneNotFoundError(
          "Organisation was not found.",
          "ORGANISATION_NOT_FOUND",
        );
      }

      if (
        organisation.organisationType !== "medical_scheme"
        || organisation.status !== "ready_for_activation"
      ) {
        throw new ControlPlaneConflictError(
          "Only a ready medical-scheme organisation can be activated.",
          "ORGANISATION_NOT_READY",
        );
      }

      const route =
        await repositories.routes.getInternalLatestReadyForOrganisation(
          organisationId,
          { executor },
        );

      if (
        !route
        || route.route_type !== "private_database"
        || String(route.schema_version) !== CANONICAL_PRIVATE_SCHEMA_VERSION
      ) {
        throw new ControlPlaneConflictError(
          `A schema-${CANONICAL_PRIVATE_SCHEMA_VERSION} private route is required.`,
          "PRIVATE_ROUTE_NOT_READY",
        );
      }

      const [gateRows] = await executor.execute(
        `
          SELECT
            (
              SELECT COUNT(*)
              FROM organisation_schema_status
              WHERE organisation_id = ?
                AND route_id = ?
                AND expected_schema_version = ?
                AND observed_schema_version = ?
                AND compatibility_status = 'compatible'
            ) AS schema_ready,
            (
              SELECT COUNT(*)
              FROM worker_routing_status
              WHERE organisation_id = ?
                AND worker_type = 'report-worker'
                AND status = 'ready'
            ) AS worker_ready,
            (
              SELECT COUNT(*)
              FROM report_storage_partitions
              WHERE organisation_id = ?
                AND provisioning_status = 'ready'
                AND retired_at IS NULL
            ) AS storage_ready,
            (
              SELECT COUNT(*)
              FROM organisation_memberships m
              JOIN users u
                ON u.user_id = m.user_id
                AND u.status = 'active'
              JOIN membership_roles mr
                ON mr.membership_id = m.membership_id
                AND mr.revoked_at IS NULL
              JOIN roles r
                ON r.role_id = mr.role_id
              JOIN credential_identities c
                ON c.user_id = m.user_id
                AND c.organisation_id = m.organisation_id
                AND c.authentication_provider = 'local_password'
                AND c.status = 'active'
                AND c.password_hash IS NOT NULL
              WHERE m.organisation_id = ?
                AND m.status = 'active'
                AND r.role_key = 'scheme_administrator'
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
      const allReady = [
        gates.schema_ready,
        gates.worker_ready,
        gates.storage_ready,
        gates.admin_ready,
      ].every((value) => Number(value) > 0);

      if (!allReady) {
        throw new ControlPlaneConflictError(
          "Schema, report worker, storage, and a usable initial administrator credential must pass before activation.",
          "ACTIVATION_GATES_FAILED",
        );
      }

      const activatedRoute = await repositories.routes.activate(
        route.route_id,
        organisationId,
        { executor },
      );

      const activatedOrganisation = await repositories.organisations.updateStatus(
        organisationId,
        "active",
        { executor },
      );

      await repositories.security.recordPlatformAudit(
        {
          actorType: actor?.type || "user",
          actorId: actor?.id || null,
          organisationScopeId: organisationId,
          action: "organisation.activate",
          targetType: "organisation",
          targetId: organisationId,
          beforeSummary: {
            status: organisation.status,
            routeId: route.route_id,
          },
          afterSummary: {
            status: activatedOrganisation.status,
            routeId: activatedRoute.routeId,
          },
          correlationId: actor?.correlationId || null,
          outcome: "success",
          source: actor?.source || "control-plane-service",
        },
        { executor },
      );

      return {
        organisation: activatedOrganisation,
        route: activatedRoute,
      };
    });
  };
}

export function createControlPlaneService({ pool, repositories }) {
  const service = createBaseControlPlaneService({ pool, repositories });
  const identity = repositories?.identity;

  let signupWithInvitation = service.signupWithInvitation;

  if (identity && typeof identity === "object") {
    const guardedIdentity =
      createSignupCredentialGuardedIdentityRepository(identity);

    if (guardedIdentity !== identity) {
      const guardedSignupService = createBaseControlPlaneService({
        pool,
        repositories: {
          ...repositories,
          identity: guardedIdentity,
        },
      });

      signupWithInvitation = guardedSignupService.signupWithInvitation;
    }
  }

  signupWithInvitation = createExpiredInvitationAwareSignup({
    pool,
    delegate: signupWithInvitation,
  });

  return {
    ...service,
    activateOrganisation: createCredentialGatedActivation({
      pool,
      repositories,
    }),
    signupWithInvitation,
  };
}
