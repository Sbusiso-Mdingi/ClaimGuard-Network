import crypto from "node:crypto";

import {
  ControlPlaneConflictError,
  ControlPlaneNotFoundError,
  sha256,
} from "@claimguard/control-plane-database";

function secret(randomBytes) {
  return randomBytes(32).toString("base64url");
}

function expired(request, timestamp) {
  return new Date(request.expiresAt).getTime() <= timestamp.getTime();
}

function safeRequestStatus(request, timestamp) {
  return expired(request, timestamp) ? "expired" : request.status;
}

export function createClerkDesktopAuthorizationService({
  controlPlaneRepositories,
  authenticationService,
  webOrigin,
  now = () => new Date(),
  randomBytes = crypto.randomBytes,
  lifetimeMs = 10 * 60 * 1000,
} = {}) {
  if (!controlPlaneRepositories?.runInTransaction) {
    throw new TypeError("Control-plane transactions are required for desktop authorization.");
  }
  if (!authenticationService?.createExternalSession) {
    throw new TypeError("External session issuance is required for desktop authorization.");
  }
  const authorizationOrigin = new URL(webOrigin).origin;

  return Object.freeze({
    async start(device, metadata = {}) {
      if (!device?.deviceEnrollmentId || !device.organisationId) {
        throw new ControlPlaneConflictError(
          "A verified desktop enrollment is required.",
          "DEVICE_PROOF_REQUIRED",
        );
      }
      const timestamp = now();
      const expiresAt = new Date(timestamp.getTime() + lifetimeMs);
      const browserSecret = secret(randomBytes);
      const pollingSecret = secret(randomBytes);
      const created = await controlPlaneRepositories.runInTransaction(async (repositories) => {
        const result = await repositories.desktopEnrollment.createAuthenticationRequest({
          deviceEnrollmentId: device.deviceEnrollmentId,
          organisationId: device.organisationId,
          browserSecretHash: sha256(browserSecret),
          pollingSecretHash: sha256(pollingSecret),
          expiresAt,
        });
        await repositories.desktopEnrollment.recordAudit({
          organisationId: device.organisationId,
          deviceEnrollmentId: device.deviceEnrollmentId,
          actorType: "device",
          actorId: device.deviceEnrollmentId,
          action: "desktop_authentication.started",
          outcome: "success",
          correlationId: metadata.correlationId || null,
          occurredAt: timestamp,
        });
        return result;
      });
      const verificationUrl = new URL("/desktop/authorize", authorizationOrigin);
      verificationUrl.searchParams.set("request", browserSecret);
      return {
        requestId: created.requestId,
        pollingSecret,
        verificationUrl: verificationUrl.toString(),
        expiresAt: expiresAt.toISOString(),
        pollingIntervalSeconds: 2,
      };
    },

    async inspect(browserSecret, resolvedIdentity) {
      const timestamp = now();
      const request = await controlPlaneRepositories.desktopEnrollment
        .getAuthenticationRequestByBrowserHash(sha256(browserSecret));
      if (!request) {
        throw new ControlPlaneNotFoundError(
          "The desktop sign-in request was not found.",
          "DESKTOP_AUTHORIZATION_NOT_FOUND",
        );
      }
      const actor = resolvedIdentity?.actor || null;
      if (actor?.organisation?.organisationId !== request.organisationId) {
        throw new ControlPlaneConflictError(
          "This Clerk organisation does not match the licensed workstation.",
          "DESKTOP_AUTHORIZATION_ORGANISATION_MISMATCH",
        );
      }
      return {
        requestId: request.requestId,
        status: safeRequestStatus(request, timestamp),
        expiresAt: new Date(request.expiresAt).toISOString(),
        licensedOrganisation: {
          organisationId: actor.organisation.organisationId,
          displayName: actor.organisation.displayName,
        },
      };
    },

    async approve(browserSecret, resolvedIdentity, metadata = {}) {
      const timestamp = now();
      const actor = resolvedIdentity?.actor || null;
      if (
        !actor?.user?.userId
        || !actor.membership?.membershipId
        || !actor.credential?.credentialId
      ) {
        throw new ControlPlaneConflictError(
          "A verified Clerk workforce identity is required.",
          "CLERK_WORKFORCE_IDENTITY_REQUIRED",
        );
      }
      if (
        actor.organisation?.organisationType === "platform"
        || actor.roles?.includes("platform_administrator")
      ) {
        throw new ControlPlaneConflictError(
          "Platform administration is not a desktop identity.",
          "PLATFORM_DESKTOP_AUTHENTICATION_REJECTED",
        );
      }
      return controlPlaneRepositories.runInTransaction(async (repositories) => {
        const request = await repositories.desktopEnrollment
          .getAuthenticationRequestByBrowserHash(sha256(browserSecret), { forUpdate: true });
        if (!request) {
          throw new ControlPlaneNotFoundError(
            "The desktop sign-in request was not found.",
            "DESKTOP_AUTHORIZATION_NOT_FOUND",
          );
        }
        if (expired(request, timestamp)) {
          throw new ControlPlaneConflictError(
            "The desktop sign-in request has expired.",
            "DESKTOP_AUTHORIZATION_EXPIRED",
          );
        }
        if (request.organisationId !== actor.organisation.organisationId) {
          throw new ControlPlaneConflictError(
            "This Clerk organisation does not match the licensed workstation.",
            "DESKTOP_AUTHORIZATION_ORGANISATION_MISMATCH",
          );
        }
        if (request.status === "approved" && request.approvedUserId === actor.user.userId) {
          return { approved: true, requestId: request.requestId };
        }
        if (request.status !== "pending") {
          throw new ControlPlaneConflictError(
            "The desktop sign-in request is no longer pending.",
            "DESKTOP_AUTHORIZATION_NOT_PENDING",
          );
        }
        const approved = await repositories.desktopEnrollment.approveAuthenticationRequest({
          requestId: request.requestId,
          organisationId: request.organisationId,
          userId: actor.user.userId,
          membershipId: actor.membership.membershipId,
          credentialId: actor.credential.credentialId,
          approvedAt: timestamp,
        });
        if (!approved) {
          throw new ControlPlaneConflictError(
            "The desktop sign-in request is no longer pending.",
            "DESKTOP_AUTHORIZATION_NOT_PENDING",
          );
        }
        await repositories.desktopEnrollment.recordAudit({
          organisationId: request.organisationId,
          deviceEnrollmentId: request.deviceEnrollmentId,
          actorType: "user",
          actorId: actor.user.userId,
          action: "desktop_authentication.approved",
          outcome: "success",
          correlationId: metadata.correlationId || null,
          occurredAt: timestamp,
        });
        return { approved: true, requestId: request.requestId };
      });
    },

    async poll(pollingSecret, device, metadata = {}) {
      const timestamp = now();
      const request = await controlPlaneRepositories.runInTransaction(async (repositories) => {
        const found = await repositories.desktopEnrollment
          .getAuthenticationRequestByPollingHash(sha256(pollingSecret), { forUpdate: true });
        if (!found || found.deviceEnrollmentId !== device?.deviceEnrollmentId) {
          throw new ControlPlaneNotFoundError(
            "The desktop sign-in request was not found.",
            "DESKTOP_AUTHORIZATION_NOT_FOUND",
          );
        }
        if (found.organisationId !== device.organisationId) {
          throw new ControlPlaneConflictError(
            "The desktop sign-in request does not match this workstation.",
            "DESKTOP_AUTHORIZATION_DEVICE_MISMATCH",
          );
        }
        if (expired(found, timestamp)) {
          throw new ControlPlaneConflictError(
            "The desktop sign-in request has expired.",
            "DESKTOP_AUTHORIZATION_EXPIRED",
          );
        }
        if (found.status === "pending") return found;
        if (found.status !== "approved") {
          throw new ControlPlaneConflictError(
            "The desktop sign-in request is no longer available.",
            "DESKTOP_AUTHORIZATION_UNAVAILABLE",
          );
        }
        const claimed = await repositories.desktopEnrollment
          .beginAuthenticationExchange(found.requestId, timestamp);
        if (!claimed) {
          throw new ControlPlaneConflictError(
            "The desktop sign-in request is already being exchanged.",
            "DESKTOP_AUTHORIZATION_EXCHANGE_CONFLICT",
          );
        }
        return { ...found, status: "exchanging" };
      });
      if (request.status === "pending") {
        return { pending: true, expiresAt: new Date(request.expiresAt).toISOString() };
      }

      try {
        const result = await authenticationService.createExternalSession({
          organisationId: request.organisationId,
          userId: request.approvedUserId,
          credentialId: request.approvedCredentialId,
        }, metadata);
        await controlPlaneRepositories.desktopEnrollment
          .completeAuthenticationExchange(request.requestId, now());
        return { pending: false, result };
      } catch (error) {
        await controlPlaneRepositories.desktopEnrollment
          .completeAuthenticationExchange(request.requestId, now(), { failed: true })
          .catch(() => {});
        throw error;
      }
    },
  });
}
