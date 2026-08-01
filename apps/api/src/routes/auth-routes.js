import { operationalPermissions } from "../middleware/auth-context.js";

const GENERIC_LOGIN_MESSAGE = "The organisation or credentials could not be verified.";

function serializeCookie(configuration, value, { maxAgeSeconds = null, expires = null } = {}) {
  const parts = [`${configuration.cookie.name}=${encodeURIComponent(value)}`, "Path=/", `SameSite=${configuration.cookie.sameSite}`];
  if (configuration.cookie.httpOnly) parts.push("HttpOnly");
  if (configuration.cookie.secure) parts.push("Secure");
  if (maxAgeSeconds != null) parts.push(`Max-Age=${Math.max(0, Math.floor(maxAgeSeconds))}`);
  if (expires) parts.push(`Expires=${expires.toUTCString()}`);
  return parts.join("; ");
}

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

export function safeSessionResponse(result, configuration) {
  const { actor, session } = result;
  const passwordMinLength = actor.organisation.organisationType === "platform" ? 12 : 8;
  return {
    authenticated: true,
    user: actor.user,
    organisation: actor.organisation,
    roles: [...actor.roles],
    clientCapabilities: operationalPermissions(actor.permissions, actor.roles),
    operationalTenant: operationalTenant(actor),
    account: {
      username: actor.credential.normalizedUsername || null,
      workContact: actor.user.canonicalContact || null,
      userStatus: actor.user.status || null,
      membershipStatus: actor.membership.status || null,
      credentialStatus: actor.credential.status || null,
      authenticationProvider: actor.credential.authenticationProvider || null,
      passwordChangeAvailable: actor.credential.authenticationProvider === "local_password",
      passwordMinLength,
    },
    sessionActivity: {
      issuedAt: session.issuedAt,
      lastActivityAt: session.lastActivityAt,
    },
    expires: {
      idleAt: session.idleExpiresAt,
      absoluteAt: session.absoluteExpiresAt,
    },
    deployment: {
      class: configuration.deploymentClass,
      demo: configuration.deploymentClass === "demo",
    },
  };
}

async function loginHandler(c, { authenticationService, configuration }) {
  let input;
  try { input = await c.req.json(); } catch { input = {}; }
  const pathSlug = c.req.param("organisationSlug") || null;
  const pathOrganisation = pathSlug ? await authenticationService.resolveOrganisationCandidate(pathSlug) : null;
  try {
    const result = await authenticationService.login({
      organisationSlug: input.organisationSlug || pathSlug,
      username: input.username,
      password: input.password,
      // A non-ID sentinel guarantees that an unknown path organisation cannot
      // match while still exercising ordinary password timing/throttling.
      requiredOrganisationId: pathSlug ? pathOrganisation?.organisationId || "path-organisation-unresolved" : null,
    }, c.get("authenticationMetadata") || {});
    const previous = c.get("resolvedSession") || null;
    if (previous) await authenticationService.logout(previous, c.get("authenticationMetadata") || {});
    const maxAgeSeconds = Math.max(0, (new Date(result.session.absoluteExpiresAt).getTime() - Date.now()) / 1000);
    c.header("Set-Cookie", serializeCookie(configuration, result.bearerSecret, { maxAgeSeconds }));
    return c.json({ ...safeSessionResponse(result, configuration), csrfToken: result.csrfToken });
  } catch {
    return c.json({ available: false, code: "AUTHENTICATION_FAILED", message: GENERIC_LOGIN_MESSAGE }, 401);
  }
}

export function registerAuthRoutes(app, { authenticationService, configuration, controlPlaneService = null }) {
  app.post("/auth/login", (c) => loginHandler(c, { authenticationService, configuration }));
  app.post("/o/:organisationSlug/login", (c) => loginHandler(c, { authenticationService, configuration }));

  app.get("/auth/session", (c) => {
    const resolved = c.get("resolvedSession") || null;
    if (!resolved) return c.json({ authenticated: false });
    return c.json(safeSessionResponse(resolved, configuration));
  });

  app.get("/auth/csrf", async (c) => {
    const resolved = c.get("resolvedSession") || null;
    if (!resolved) return c.json({ available: false, code: "UNAUTHENTICATED", message: "Authentication is required." }, 401);
    const csrfToken = await authenticationService.rotateCsrf(resolved);
    return c.json({ available: true, csrfToken });
  });

  app.post("/auth/logout", async (c) => {
    const resolved = c.get("resolvedSession") || null;
    if (resolved) await authenticationService.logout(resolved, c.get("authenticationMetadata") || {});
    c.header("Set-Cookie", serializeCookie(configuration, "", { maxAgeSeconds: 0, expires: new Date(0) }));
    return c.json({ authenticated: false });
  });

  app.post("/auth/password/change", async (c) => {
    const resolved = c.get("resolvedSession") || null;
    if (!resolved) {
      return c.json({
        available: false,
        code: "UNAUTHENTICATED",
        message: "Authentication is required.",
      }, 401);
    }

    let input;
    try { input = await c.req.json(); } catch { input = {}; }
    const currentPassword = typeof input.currentPassword === "string" ? input.currentPassword : "";
    const newPassword = typeof input.newPassword === "string" ? input.newPassword : "";
    const minimumLength = resolved.actor.organisation.organisationType === "platform" ? 12 : 8;

    if (!currentPassword || !newPassword) {
      return c.json({
        available: false,
        code: "INVALID_INPUT",
        message: "Current password and new password are required.",
      }, 400);
    }
    if (newPassword.length < minimumLength) {
      return c.json({
        available: false,
        code: "WEAK_PASSWORD",
        message: `Password must be at least ${minimumLength} characters.`,
      }, 400);
    }
    if (newPassword.length > 128) {
      return c.json({
        available: false,
        code: "PASSWORD_TOO_LONG",
        message: "Password must be no more than 128 characters.",
      }, 400);
    }

    try {
      const result = await authenticationService.changePassword(
        resolved,
        { currentPassword, newPassword },
        c.get("authenticationMetadata") || {},
      );
      return c.json({
        available: true,
        changedAt: result.changedAt,
        otherSessionsRevoked: result.otherSessionsRevoked,
      });
    } catch (error) {
      if (error?.code === "AUTHENTICATION_FAILED") {
        return c.json({
          available: false,
          code: "CURRENT_PASSWORD_INCORRECT",
          message: "The current password is incorrect.",
        }, 400);
      }
      const status = Number.isInteger(error?.status) ? error.status : 500;
      return c.json({
        available: false,
        code: error?.code || "PASSWORD_CHANGE_FAILED",
        message: status >= 500
          ? "The password could not be changed. Try again."
          : error.message,
      }, status);
    }
  });

  app.post("/auth/invitation/validate", async (c) => {
    if (!controlPlaneService) {
      return c.json({ available: false, code: "NOT_CONFIGURED", message: "Invitations are not configured." }, 404);
    }

    let input;
    try { input = await c.req.json(); } catch { input = {}; }
    const token = input?.token;

    if (!token || typeof token !== "string") {
      return c.json({ available: false, code: "INVALID_INPUT", message: "An invitation token is required." }, 400);
    }

    try {
      const invitation = await controlPlaneService.getInvitationByToken(token);
      if (!invitation) {
        return c.json({ available: false, code: "INVITATION_NOT_FOUND", message: "This invitation link is invalid." }, 404);
      }
      if (invitation.status !== "pending") {
        return c.json({ available: false, code: "INVITATION_CONSUMED", message: "This invitation has already been used." }, 410);
      }
      if (new Date(invitation.expiresAt) < new Date()) {
        return c.json({ available: false, code: "INVITATION_EXPIRED", message: "This invitation has expired." }, 410);
      }
      const platformAdministrator =
        invitation.invitationType === "platform_administrator";
      return c.json({
        available: true,
        organisationName: invitation.organisationName,
        canonicalSlug: invitation.canonicalSlug,
        organisationType: invitation.organisationType,
        invitationType: invitation.invitationType || "scheme_administrator",
        roleKey: invitation.roleKey || "scheme_administrator",
        roleLabel: platformAdministrator
          ? "ClaimGuard Platform Administrator"
          : "Scheme Administrator",
        passwordMinLength: platformAdministrator ? 12 : 8,
        email: invitation.email,
      });
    } catch {
      return c.json({ available: false, code: "INVITATION_ERROR", message: "Could not validate invitation." }, 400);
    }
  });

  app.post("/auth/signup", async (c) => {
    if (!controlPlaneService) {
      return c.json({ available: false, code: "NOT_CONFIGURED", message: "Signup is not configured." }, 404);
    }
    let input;
    try { input = await c.req.json(); } catch { input = {}; }
    const { token, displayName, username, password } = input;
    if (!token || !displayName || !username || !password) {
      return c.json({ available: false, code: "INVALID_INPUT", message: "token, displayName, username, and password are required." }, 400);
    }
    if (password.length < 8) {
      return c.json({ available: false, code: "WEAK_PASSWORD", message: "Password must be at least 8 characters." }, 400);
    }
    try {
      const result = await controlPlaneService.signupWithInvitation({ token, displayName, username, password }, {});
      return c.json({
        available: true,
        message: result.invitationType === "platform_administrator"
          ? "Platform administrator account created successfully. You can now sign in."
          : "Account created successfully. You can now sign in.",
        invitationType: result.invitationType || "scheme_administrator",
        roleKey: result.roleKey || "scheme_administrator",
        user: { userId: result.user.userId, displayName: result.user.displayName },
      }, 201);
    } catch (error) {
      const status = Number.isInteger(error?.status) ? error.status : 400;
      const code = error?.code || "SIGNUP_FAILED";
      return c.json({ available: false, code, message: error?.message || "Signup failed." }, status);
    }
  });
}

export { GENERIC_LOGIN_MESSAGE, serializeCookie };
