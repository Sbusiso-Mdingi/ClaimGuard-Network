import assert from "node:assert/strict";
import test from "node:test";

import { Hono } from "hono";

import { CLAIMGUARD_PERMISSIONS } from "../src/authorization-policy.js";
import { registerPlatformAdminRoutes } from "../src/routes/platform-admin-routes.js";

const invitationId = "12345678-1234-4123-8123-123456789abc";

function createHarness({ permitted = true } = {}) {
  const calls = {
    create: [],
    reauthenticate: [],
    revoke: [],
  };
  const app = new Hono();

  app.use("*", async (c, next) => {
    c.set("authContext", {
      is_authenticated: true,
      user_id: permitted ? "platform-admin-1" : "investigator-1",
      permissions: new Set(
        permitted
          ? [CLAIMGUARD_PERMISSIONS.PLATFORM_ADMINISTRATORS_MANAGE]
          : [],
      ),
    });
    c.set("requestId", "request-platform-access-1");
    c.set("resolvedSession", { sessionId: "session-1" });
    c.set("authenticationMetadata", { sourceNetwork: "test" });
    await next();
  });

  registerPlatformAdminRoutes(app, {
    controlPlaneRepositories: {},
    controlPlaneService: {
      async getPlatformAdministratorAccess() {
        return {
          organisation: {
            organisationId: "org-platform",
            displayName: "ClaimGuard",
            organisationType: "platform",
          },
          administrators: [{
            userId: "platform-admin-1",
            displayName: "Primary Administrator",
            canonicalContact: "primary@example.com",
            userStatus: "active",
            membershipStatus: "active",
            roles: ["platform_administrator"],
          }],
          invitations: [{
            invitationId,
            organisationId: "org-platform",
            invitationType: "platform_administrator",
            email: "second@example.com",
            status: "pending",
            invitedBy: "platform-admin-1",
            createdAt: "2026-07-30T08:00:00.000Z",
            expiresAt: "2026-07-31T08:00:00.000Z",
          }],
        };
      },
      async createPlatformAdministratorInvitation(input, actor) {
        calls.create.push({ input, actor });
        return {
          invitation: {
            invitationId,
            invitationType: "platform_administrator",
            email: input.email,
            status: "pending",
          },
          token: "raw-token-returned-once",
          auditEventId: "audit-create-1",
        };
      },
      async revokePlatformAdministratorInvitation(input, actor) {
        calls.revoke.push({ input, actor });
        return {
          invitation: {
            invitationId,
            invitationType: "platform_administrator",
            email: "second@example.com",
            status: "revoked",
          },
          auditEventId: "audit-revoke-1",
        };
      },
    },
    authenticationService: {
      async reauthenticate(session, password, metadata) {
        calls.reauthenticate.push({ session, password, metadata });
        return { reauthenticatedAt: "2026-07-30T09:00:00.000Z" };
      },
    },
  });

  return { app, calls };
}

test("platform access history is permission-gated and never returns invitation tokens", async () => {
  const { app } = createHarness();
  const response = await app.request("/admin/platform/administrators");
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.available, true);
  assert.equal(body.policy.rawTokenStored, false);
  assert.equal(body.administrators.length, 1);
  assert.equal(body.invitations[0].revocationConfirmation, "REVOKE 12345678");
  assert.equal(JSON.stringify(body).includes("raw-token-returned-once"), false);

  const forbidden = createHarness({ permitted: false });
  const forbiddenResponse = await forbidden.app.request(
    "/admin/platform/administrators",
  );
  assert.equal(forbiddenResponse.status, 403);
});

test("invitation creation requires exact confirmation before reauthentication", async () => {
  const { app, calls } = createHarness();
  const response = await app.request(
    "/admin/platform/administrators/invitations",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        email: "Second@Example.com",
        password: "correct-password",
        confirmation: "INVITE THE WRONG IDENTITY",
      }),
    },
  );

  assert.equal(response.status, 400);
  assert.equal(calls.reauthenticate.length, 0);
  assert.equal(calls.create.length, 0);
});

test("invitation creation reauthenticates, audits, and returns the raw token once", async () => {
  const { app, calls } = createHarness();
  const response = await app.request(
    "/admin/platform/administrators/invitations",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        email: "Second@Example.com",
        password: "correct-password",
        confirmation:
          "INVITE second@example.com AS PLATFORM ADMINISTRATOR",
      }),
    },
  );
  const body = await response.json();

  assert.equal(response.status, 201);
  assert.equal(body.token, "raw-token-returned-once");
  assert.equal(body.auditEventId, "audit-create-1");
  assert.deepEqual(calls.reauthenticate, [{
    session: { sessionId: "session-1" },
    password: "correct-password",
    metadata: { sourceNetwork: "test" },
  }]);
  assert.deepEqual(calls.create[0], {
    input: {
      email: "second@example.com",
      invitedBy: "platform-admin-1",
      reauthenticatedAt: "2026-07-30T09:00:00.000Z",
      expiresInHours: 24,
    },
    actor: {
      type: "user",
      id: "platform-admin-1",
      source: "platform-admin-api",
      correlationId: "request-platform-access-1",
    },
  });
});

test("pending invitation revocation requires step-up authentication and is audited", async () => {
  const { app, calls } = createHarness();
  const response = await app.request(
    `/admin/platform/administrators/invitations/${invitationId}/revoke`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        password: "correct-password",
        confirmation: "REVOKE 12345678",
      }),
    },
  );
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.invitation.status, "revoked");
  assert.equal(body.auditEventId, "audit-revoke-1");
  assert.equal(calls.reauthenticate.length, 1);
  assert.deepEqual(calls.revoke[0].input, {
    invitationId,
    revokedBy: "platform-admin-1",
    reauthenticatedAt: "2026-07-30T09:00:00.000Z",
  });
});
