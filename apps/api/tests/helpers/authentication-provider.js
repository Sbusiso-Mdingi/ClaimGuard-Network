import { getPermissionsForRoles } from "../../src/authorization-policy.js";
import {
  createAnonymousAuthContext,
  createAuthenticatedAuthContext,
} from "../../src/auth-context.js";

export function createStaticAuthenticationProvider({
  userId = "test-user",
  roles = [],
  permissions = null,
  tenantId = null,
  organisationId = null,
  membershipId = null,
  displayName = "Test User",
  organisation = null,
  source = "test_provider",
} = {}) {
  const authContext = createAuthenticatedAuthContext({
    userId,
    roles,
    permissions: permissions || getPermissionsForRoles(roles),
    tenantId,
    organisationId,
    membershipId,
    displayName,
    organisation,
    source,
  });

  return Object.freeze({
    mode: "test",
    async resolveAuthContext() {
      return authContext;
    },
  });
}

export function createAnonymousAuthenticationProvider({ source = "test_anonymous" } = {}) {
  const authContext = createAnonymousAuthContext({ source });
  return Object.freeze({
    mode: "test",
    async resolveAuthContext() {
      return authContext;
    },
  });
}

export function createRequestAuthenticationProvider(resolve) {
  if (typeof resolve !== "function") throw new TypeError("resolve must be a function.");
  return Object.freeze({
    mode: "test",
    async resolveAuthContext(context) {
      return resolve(context);
    },
  });
}
