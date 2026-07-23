import { CLAIMGUARD_PERMISSIONS } from "../authorization-policy.js";
import { createRequirePermissionMiddleware } from "../middleware/authorization-middleware.js";

function actorFromContext(c) {
  const auth = c.get("authContext") || {};
  return {
    type: "user",
    id: auth.user_id || null,
    organisationId: auth.organisation_id || null,
    source: "scheme-admin-api",
    correlationId: c.get("requestId") || null,
  };
}

export function registerSchemeAdminRoutes(app, { controlPlaneService }) {
  const requireSchemeUsersManage = createRequirePermissionMiddleware({
    permission: CLAIMGUARD_PERMISSIONS.SCHEME_USERS_MANAGE,
  });

  app.get("/admin/scheme/users", requireSchemeUsersManage, async (c) => {
    if (!controlPlaneService?.listUsersByOrganisation) {
      return c.json({ available: false, code: "NOT_CONFIGURED", message: "User management is not configured." }, 404);
    }
    const actor = actorFromContext(c);
    try {
      const users = await controlPlaneService.listUsersByOrganisation(actor.organisationId, actor);
      return c.json({ available: true, users });
    } catch (error) {
      return c.json({ available: false, code: "FETCH_FAILED", message: "Failed to list users." }, 500);
    }
  });

  app.post("/admin/scheme/users", requireSchemeUsersManage, async (c) => {
    if (!controlPlaneService?.createSchemeUser) {
      return c.json({ available: false, code: "NOT_CONFIGURED", message: "User management is not configured." }, 404);
    }
    const actor = actorFromContext(c);
    const payload = await c.req.json().catch(() => ({}));
    const { displayName, username, password, roleKey } = payload;

    if (!displayName || !username || !password || !roleKey) {
      return c.json({ available: false, code: "INVALID_INPUT", message: "displayName, username, password, and roleKey are required." }, 400);
    }
    if (password.length < 8) {
      return c.json({ available: false, code: "WEAK_PASSWORD", message: "Password must be at least 8 characters." }, 400);
    }

    try {
      const result = await controlPlaneService.createSchemeUser({
        organisationId: actor.organisationId,
        displayName,
        username,
        password,
        roleKey,
      }, actor);

      return c.json({
        available: true,
        user: { userId: result.user.userId, displayName: result.user.displayName },
      }, 201);
    } catch (error) {
      const status = Number.isInteger(error?.status) ? error.status : 400;
      const code = error?.code || "USER_CREATE_FAILED";
      return c.json({ available: false, code, message: error?.message || "Failed to create user." }, status);
    }
  });

  app.delete("/admin/scheme/users/:userId", requireSchemeUsersManage, async (c) => {
    if (!controlPlaneService?.disableSchemeUser) {
      return c.json({ available: false, code: "NOT_CONFIGURED", message: "User management is not configured." }, 404);
    }
    const actor = actorFromContext(c);
    const userId = c.req.param("userId");

    try {
      const user = await controlPlaneService.disableSchemeUser({
        organisationId: actor.organisationId,
        userId,
      }, actor);

      return c.json({ available: true, user });
    } catch (error) {
      const status = Number.isInteger(error?.status) ? error.status : 400;
      const code = error?.code || "USER_DISABLE_FAILED";
      return c.json({ available: false, code, message: error?.message || "Failed to disable user." }, status);
    }
  });
}
