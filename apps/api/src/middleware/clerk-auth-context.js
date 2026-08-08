import {
  ACCESS_ERROR_CODE,
} from "@claimguard/control-plane-database";

import {
  createAnonymousAuthContext,
  createAuthenticatedAuthContext,
  IDENTITY_AUTHORITY_HEADERS,
  LEGACY_SERVICE_IDENTITY_HEADERS,
  operationalPermissions,
  parseCookieHeader,
  requestMetadata,
} from "./auth-context.js";
import { ForbiddenError } from "../application-errors.js";

function actorOperationalTenantId(actor) {
  if (actor?.legacyTenant?.tenantId) return actor.legacyTenant.tenantId;
  if (actor?.organisation?.organisationType === "medical_scheme") {
    return actor.organisation.organisationId || null;
  }
  return null;
}

function bearerValue(request) {
  const authorization = request.headers.get("authorization") || "";
  return authorization.startsWith("Bearer ")
    ? authorization.slice(7).trim()
    : "";
}

function primaryVerifiedEmail(user) {
  const email = user?.primaryEmailAddress || null;
  if (!email || email.verification?.status !== "verified") return null;
  return String(email.emailAddress || "").trim().toLowerCase() || null;
}

function assertWorkforceUser(user, configuration) {
  if (!user || user.banned || user.locked) {
    const error = new ForbiddenError("The workforce identity is unavailable.");
    error.code = "CLERK_IDENTITY_UNAVAILABLE";
    throw error;
  }
  if (user.passwordEnabled) {
    const error = new ForbiddenError("Password authentication is not permitted for this workforce application.");
    error.code = "CLERK_PASSWORD_AUTHENTICATION_REJECTED";
    throw error;
  }
  if (!user.twoFactorEnabled) {
    const error = new ForbiddenError("Multi-factor authentication is required.");
    error.code = "CLERK_MFA_REQUIRED";
    throw error;
  }
  if (!primaryVerifiedEmail(user)) {
    const error = new ForbiddenError("A verified work email address is required.");
    error.code = "CLERK_VERIFIED_EMAIL_REQUIRED";
    throw error;
  }

  const allowedProviders = new Set(configuration.clerk.allowedExternalAccountProviders);
  const prohibitedProviders = (user.externalAccounts || [])
    .map((account) => String(account.provider || "").trim().toLowerCase())
    .filter((provider) => !allowedProviders.has(provider));
  if (prohibitedProviders.length > 0) {
    const error = new ForbiddenError("Consumer social authentication is not permitted for this workforce application.");
    error.code = "CLERK_SOCIAL_AUTHENTICATION_REJECTED";
    throw error;
  }
  if (!configuration.clerk.enterpriseSsoEnabled && (user.enterpriseAccounts || []).length > 0) {
    const error = new ForbiddenError("Enterprise SSO is not enabled for this deployment.");
    error.code = "CLERK_ENTERPRISE_SSO_REJECTED";
    throw error;
  }
}

function externalIdentityContext({ actor, auth, user }) {
  return {
    actor,
    externalIdentity: Object.freeze({
      provider: "clerk",
      subject: auth.userId,
      organisationId: auth.orgId,
      sessionId: auth.sessionId || null,
      verifiedEmail: primaryVerifiedEmail(user),
      factorVerificationAge: auth.factorVerificationAge || null,
      reverified: Boolean(auth.has?.({ reverification: "strict" })),
      issuedAt: auth.sessionClaims?.iat || null,
      expiresAt: auth.sessionClaims?.exp || null,
    }),
  };
}

export function createClerkAuthenticationProvider({
  clerkClient,
  authenticationService,
  configuration,
  workforceService = null,
}) {
  if (!clerkClient?.authenticateRequest || !clerkClient?.users?.getUser) {
    throw new TypeError("A Clerk backend client is required for Clerk authentication mode.");
  }
  if (!authenticationService?.resolveExternalIdentity) {
    throw new TypeError("External identity resolution is required for Clerk authentication mode.");
  }

  return {
    mode: "clerk",
    async resolveAuthContext({ request }) {
      const spoofed = [...IDENTITY_AUTHORITY_HEADERS, ...LEGACY_SERVICE_IDENTITY_HEADERS]
        .filter((name) => request.headers.has(name));
      const metadata = requestMetadata(request, configuration);
      if (spoofed.length > 0) {
        await authenticationService.recordSecurityEvent(
          "header_spoof_attempt",
          "failure",
          metadata,
          {},
          "identity_authority_header",
        );
        const error = new ForbiddenError("Identity-authority headers are not accepted.");
        error.code = "IDENTITY_HEADER_REJECTED";
        throw error;
      }

      const requestState = await clerkClient.authenticateRequest(request, {
        acceptsToken: "session_token",
        authorizedParties: configuration.clerk.authorizedParties,
      });

      if (requestState.isAuthenticated) {
        const auth = requestState.toAuth();
        if (!auth.userId || !auth.orgId) {
          const error = new ForbiddenError("An active workforce organisation is required.");
          error.code = "CLERK_ACTIVE_ORGANISATION_REQUIRED";
          throw error;
        }
        const clerkUser = await clerkClient.users.getUser(auth.userId);
        assertWorkforceUser(clerkUser, configuration);
        let resolved;
        try {
          resolved = await authenticationService.resolveExternalIdentity({
            authenticationProvider: "oidc",
            externalSubject: auth.userId,
            externalOrganisationId: auth.orgId,
          }, metadata);
        } catch (error) {
          if (error?.code === ACCESS_ERROR_CODE.AUTHORIZATION_VERSION_STALE) throw error;
          if (
            error?.internalReason === "external_identity_unlinked"
            && workforceService?.activateAuthenticatedIdentity
          ) {
            await workforceService.activateAuthenticatedIdentity({
              clerkUser,
              clerkOrganisationId: auth.orgId,
              correlationId: metadata.correlationId,
            });
            resolved = await authenticationService.resolveExternalIdentity({
              authenticationProvider: "oidc",
              externalSubject: auth.userId,
              externalOrganisationId: auth.orgId,
            }, metadata);
          } else {
            throw error;
          }
        }
        const { actor } = resolved;
        const resolvedIdentity = externalIdentityContext({ actor, auth, user: clerkUser });
        return {
          resolvedSession: resolvedIdentity,
          metadata,
          authContext: createAuthenticatedAuthContext({
            userId: actor.user.userId,
            displayName: actor.user.displayName,
            roles: actor.roles,
            permissions: operationalPermissions(actor.permissions),
            tenantId: actorOperationalTenantId(actor),
            organisationId: actor.organisation.organisationId,
            membershipId: actor.membership.membershipId,
            organisation: actor.organisation,
            source: "clerk",
            actorType: "user",
            authenticationVersion: actor.authenticationVersion,
            authorizationVersion: actor.authorizationVersion,
            correlationId: metadata.correlationId,
          }),
        };
      }

      const desktopSessionSecret = request.headers.has("dpop")
        ? parseCookieHeader(request.headers.get("cookie"))
            .get(configuration.cookie.name) || null
        : null;
      if (desktopSessionSecret) {
        try {
          const resolvedSession = await authenticationService.resolveSession(
            desktopSessionSecret,
            metadata,
          );
          const { actor } = resolvedSession;
          return {
            resolvedSession,
            metadata,
            authContext: createAuthenticatedAuthContext({
              userId: actor.user.userId,
              displayName: actor.user.displayName,
              roles: actor.roles,
              permissions: operationalPermissions(actor.permissions),
              tenantId: actorOperationalTenantId(actor),
              organisationId: actor.organisation.organisationId,
              membershipId: actor.membership.membershipId,
              organisation: actor.organisation,
              source: "clerk_desktop_session",
              actorType: "user",
              authenticationVersion: actor.authenticationVersion,
              authorizationVersion: actor.authorizationVersion,
              correlationId: metadata.correlationId,
            }),
          };
        } catch (error) {
          if (error?.code === ACCESS_ERROR_CODE.AUTHORIZATION_VERSION_STALE) throw error;
          return {
            authContext: createAnonymousAuthContext({ source: "invalid_desktop_session" }),
            resolvedSession: null,
            metadata,
            dataPlaneOrganisationToRetire: error?.organisationId || null,
          };
        }
      }

      const bearer = bearerValue(request);
      if (bearer) {
        const integration = await authenticationService.resolveIntegrationCredential?.(bearer, metadata);
        if (integration) {
          return {
            authContext: createAuthenticatedAuthContext({
              userId: integration.serviceActorId,
              roles: [integration.roleKey],
              permissions: [],
              tenantId: integration.tenantId,
              organisationId: integration.organisationId,
              source: "internal_service",
              actorType: "service",
              correlationId: metadata.correlationId,
            }),
            resolvedSession: null,
            metadata,
          };
        }
        const error = new ForbiddenError("Authentication failed.");
        error.code = "AUTHENTICATION_FAILED";
        throw error;
      }

      return {
        authContext: createAnonymousAuthContext({ source: "clerk_signed_out" }),
        resolvedSession: null,
        metadata,
      };
    },
  };
}
