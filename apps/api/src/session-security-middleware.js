import { applicationErrorResponse, ForbiddenError } from "./application-errors.js";
import { isAllowedOrigin } from "./authentication-config.js";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

export function createSessionCsrfMiddleware({ authenticationService, configuration }) {
  return async (c, next) => {
    if (configuration.mode !== "session" || SAFE_METHODS.has(c.req.method.toUpperCase())) return next();
    // Desktop mutations are protected by a verified DPoP-style device proof,
    // including method, route, body digest, timestamp and one-use nonce. They
    // do not rely on a browser origin or expose the HttpOnly web CSRF token.
    if (c.get("desktopDevice")) return next();
    const resolvedSession = c.get("resolvedSession") || null;
    const isLogin = c.req.path === "/auth/login" || /^\/o\/[^/]+\/login$/.test(c.req.path);
    const isLogout = c.req.path === "/auth/logout";
    if (!resolvedSession && !isLogin && !isLogout) return next();
    const metadata = c.get("authenticationMetadata") || {};
    if (!isAllowedOrigin(c.req.raw, configuration)) {
      await authenticationService.recordSecurityEvent("csrf_rejection", "failure", metadata, {
        organisationId: resolvedSession?.session?.organisationId,
        userId: resolvedSession?.session?.userId,
        credentialId: resolvedSession?.session?.credentialId,
      }, "origin_rejected");
      const error = new ForbiddenError("Request origin validation failed.");
      error.code = "CSRF_REJECTED";
      return applicationErrorResponse(c, error);
    }
    if (isLogin || (!resolvedSession && isLogout)) return next();
    const csrfToken = c.req.header("x-csrf-token") || "";
    if (!authenticationService.verifyCsrf(resolvedSession, csrfToken)) {
      await authenticationService.recordSecurityEvent("csrf_rejection", "failure", metadata, {
        organisationId: resolvedSession.session.organisationId,
        userId: resolvedSession.session.userId,
        credentialId: resolvedSession.session.credentialId,
      }, "token_rejected");
      const error = new ForbiddenError("CSRF validation failed.");
      error.code = "CSRF_REJECTED";
      return applicationErrorResponse(c, error);
    }
    return next();
  };
}

export function createClerkOriginMiddleware({ authenticationService, configuration }) {
  return async (c, next) => {
    if (configuration.mode !== "clerk" || SAFE_METHODS.has(c.req.method.toUpperCase())) {
      return next();
    }
    if (c.get("desktopDevice")) return next();
    const authContext = c.get("authContext") || null;
    if (!authContext?.is_authenticated || authContext.actor_type !== "user") return next();
    if (isAllowedOrigin(c.req.raw, configuration)) return next();

    await authenticationService.recordSecurityEvent(
      "csrf_rejection",
      "failure",
      c.get("authenticationMetadata") || {},
      {
        organisationId: authContext.organisation_id || null,
        userId: authContext.user_id || null,
      },
      "origin_rejected",
    );
    const error = new ForbiddenError("Request origin validation failed.");
    error.code = "ORIGIN_REJECTED";
    return applicationErrorResponse(c, error);
  };
}
