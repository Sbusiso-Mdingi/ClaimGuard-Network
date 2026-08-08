import { operationalPermissions } from "../middleware/auth-context.js";

function operationalTenant(actor) {
  if (actor?.legacyTenant?.tenantId) {
    return {
      tenantId: actor.legacyTenant.tenantId,
      tenantSlug: actor.legacyTenant.tenantSlug || null,
    };
  }
  if (actor?.organisation?.organisationType === "medical_scheme") {
    return {
      tenantId: actor.organisation.organisationId,
      tenantSlug: actor.organisation.canonicalSlug || null,
    };
  }
  return null;
}

function claimDate(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0
    ? new Date(numeric * 1000).toISOString()
    : null;
}

export function safeClerkSessionResponse(resolvedIdentity, configuration) {
  const actor = resolvedIdentity.actor;
  const externalIdentity = resolvedIdentity.externalIdentity;
  return {
    authenticated: true,
    authenticationProvider: "clerk",
    user: actor.user,
    organisation: actor.organisation,
    roles: [...actor.roles],
    clientCapabilities: operationalPermissions(actor.permissions),
    operationalTenant: operationalTenant(actor),
    account: {
      username: externalIdentity.verifiedEmail,
      workContact: actor.user.canonicalContact || externalIdentity.verifiedEmail,
      userStatus: actor.user.status || null,
      membershipStatus: actor.membership.status || null,
      credentialStatus: actor.credential.status || null,
      authenticationProvider: "clerk",
      passwordChangeAvailable: false,
      mfaRequired: true,
    },
    sessionActivity: {
      issuedAt: claimDate(externalIdentity.issuedAt),
      lastActivityAt: null,
    },
    expires: {
      idleAt: null,
      absoluteAt: claimDate(externalIdentity.expiresAt),
    },
    deployment: {
      class: configuration.deploymentClass,
      demo: configuration.deploymentClass === "demo",
    },
  };
}

function clerkManagedResponse(c, capability) {
  return c.json({
    available: false,
    code: "CLERK_MANAGED_AUTHENTICATION",
    message: `${capability} is managed by Clerk for this workforce application.`,
  }, 410);
}

export function registerClerkAuthRoutes(app, { configuration }) {
  app.get("/auth/session", (c) => {
    const resolved = c.get("resolvedSession") || null;
    if (!resolved?.externalIdentity) return c.json({ authenticated: false });
    return c.json(safeClerkSessionResponse(resolved, configuration));
  });

  app.post("/auth/logout", (c) => c.json({
    authenticated: false,
    authenticationProvider: "clerk",
  }));

  app.get("/auth/csrf", (c) => clerkManagedResponse(c, "Browser session protection"));
  app.post("/auth/login", (c) => clerkManagedResponse(c, "Sign-in"));
  app.post("/o/:organisationSlug/login", (c) => clerkManagedResponse(c, "Sign-in"));
  app.post("/auth/signup", (c) => clerkManagedResponse(c, "Sign-up"));
  app.post("/auth/invitation/validate", (c) => clerkManagedResponse(c, "Invitation acceptance"));
  app.post("/auth/password/change", (c) => clerkManagedResponse(c, "Password management"));
}
