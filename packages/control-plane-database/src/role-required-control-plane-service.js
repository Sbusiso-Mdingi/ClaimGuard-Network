import {
  createControlPlaneService as createGuardedControlPlaneService,
} from "./credential-guarded-control-plane-service.js";
import { ControlPlaneNotFoundError } from "./errors.js";

export function createRequiredRoleIdentityRepository(identity) {
  if (!identity || typeof identity !== "object") {
    return identity;
  }

  if (typeof identity.resolveRole !== "function") {
    return identity;
  }

  return {
    ...identity,

    async resolveRole(roleKey, options = {}) {
      const role = await identity.resolveRole(roleKey, options);

      if (roleKey === "scheme_administrator" && !role) {
        throw new ControlPlaneNotFoundError(
          "The required scheme administrator role was not found.",
          "ROLE_NOT_FOUND",
        );
      }

      return role;
    },
  };
}

export function createControlPlaneService({ pool, repositories }) {
  const identity = repositories?.identity;
  const guardedIdentity = createRequiredRoleIdentityRepository(identity);

  if (guardedIdentity === identity) {
    return createGuardedControlPlaneService({ pool, repositories });
  }

  return createGuardedControlPlaneService({
    pool,
    repositories: {
      ...repositories,
      identity: guardedIdentity,
    },
  });
}
