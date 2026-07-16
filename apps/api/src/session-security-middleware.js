import { applicationErrorResponse, ForbiddenError } from "./application-errors.js";
import { isAllowedOrigin } from "./authentication-config.js";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

export function createSessionCsrfMiddleware({ authenticationService, configuration }) {
  return async (c, next) => {
    if (configuration.mode !== "session" || SAFE_METHODS.has(c.req.method.toUpperCase())) return next();
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
