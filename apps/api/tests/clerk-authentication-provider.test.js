import assert from "node:assert/strict";
import test from "node:test";

import { createClerkAuthenticationProvider } from "../src/middleware/clerk-auth-context.js";

const configuration = Object.freeze({
  trustProxy: false,
  cookie: { name: "cg_session_local" },
  clerk: {
    authorizedParties: ["https://work.sequrin.example"],
    allowedExternalAccountProviders: [],
    enterpriseSsoEnabled: false,
  },
});

const validUser = Object.freeze({
  id: "clerk-user-1",
  banned: false,
  locked: false,
  passwordEnabled: false,
  twoFactorEnabled: true,
  primaryEmailAddress: {
    emailAddress: "analyst@example.com",
    verification: { status: "verified" },
  },
  externalAccounts: [],
  enterpriseAccounts: [],
});

function authenticatedState() {
  return {
    isAuthenticated: true,
    toAuth: () => ({
      userId: "clerk-user-1",
      orgId: "clerk-org-1",
      sessionId: "clerk-session-1",
      has: () => true,
      sessionClaims: { iat: 1, exp: 2 },
    }),
  };
}

function providerHarness({ user = validUser, state = authenticatedState(), authentication = {} } = {}) {
  const calls = { resolveSession: [] };
  const actor = {
    user: { userId: "user-1", displayName: "Analyst" },
    membership: { membershipId: "membership-1" },
    organisation: { organisationId: "org-1", organisationType: "medical_scheme" },
    roles: ["fraud_analyst"],
    permissions: ["claims.view_own"],
    authenticationVersion: 2,
    authorizationVersion: 3,
  };
  const authenticationService = {
    async resolveExternalIdentity() { return { actor }; },
    async resolveSession(secret) {
      calls.resolveSession.push(secret);
      return { actor };
    },
    async recordSecurityEvent() {},
    ...authentication,
  };
  return {
    calls,
    provider: createClerkAuthenticationProvider({
      clerkClient: {
        async authenticateRequest() { return state; },
        users: { async getUser() { return user; } },
      },
      authenticationService,
      configuration,
    }),
  };
}

test("Clerk rejects password, missing MFA, social, and enterprise identities fail-closed", async () => {
  const cases = [
    [{ ...validUser, passwordEnabled: true }, "CLERK_PASSWORD_AUTHENTICATION_REJECTED"],
    [{ ...validUser, twoFactorEnabled: false }, "CLERK_MFA_REQUIRED"],
    [{ ...validUser, externalAccounts: [{ provider: "google" }] }, "CLERK_SOCIAL_AUTHENTICATION_REJECTED"],
    [{ ...validUser, enterpriseAccounts: [{ id: "enterprise-1" }] }, "CLERK_ENTERPRISE_SSO_REJECTED"],
  ];

  for (const [user, code] of cases) {
    const { provider } = providerHarness({ user });
    await assert.rejects(
      provider.resolveAuthContext({ request: new Request("https://work.sequrin.example/api/auth/session") }),
      (error) => error.code === code,
    );
  }
});

test("a verified passwordless Clerk identity resolves only server-side authority", async () => {
  const { provider } = providerHarness();
  const result = await provider.resolveAuthContext({
    request: new Request("https://work.sequrin.example/api/auth/session"),
  });

  assert.equal(result.authContext.is_authenticated, true);
  assert.equal(result.authContext.user_id, "user-1");
  assert.equal(result.authContext.organisation_id, "org-1");
  assert.equal(result.authContext.source, "clerk");
  assert.deepEqual([...result.authContext.permissions], ["claims.view_own"]);
});

test("the opaque desktop cookie is accepted only with device proof", async () => {
  const signedOut = { isAuthenticated: false };
  const withDeviceProof = providerHarness({ state: signedOut });
  const accepted = await withDeviceProof.provider.resolveAuthContext({
    request: new Request("https://api.sequrin.example/api/desktop/sync", {
      headers: { cookie: "cg_session_local=opaque-desktop", dpop: "proof" },
    }),
  });
  assert.equal(accepted.authContext.source, "clerk_desktop_session");
  assert.deepEqual(withDeviceProof.calls.resolveSession, ["opaque-desktop"]);

  const browser = providerHarness({ state: signedOut });
  const rejected = await browser.provider.resolveAuthContext({
    request: new Request("https://api.sequrin.example/api/auth/session", {
      headers: { cookie: "cg_session_local=opaque-desktop" },
    }),
  });
  assert.equal(rejected.authContext.is_authenticated, false);
  assert.equal(rejected.authContext.source, "clerk_signed_out");
  assert.equal(browser.calls.resolveSession.length, 0);
});
