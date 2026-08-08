import assert from "node:assert/strict";
import test from "node:test";

import { Hono } from "hono";

import { registerAuthRoutes } from "../src/routes/auth-routes.js";
import { scrubSentryEvent } from "../src/sentry-scrub.js";

const SECRET = "INVITE_TOKEN_MUST_NEVER_LEAK_123";

function createApp(invitationOverrides = {}) {
  const app = new Hono();

  registerAuthRoutes(app, {
    authenticationService: {},
    configuration: {
      cookie: {
        name: "cg_session",
        sameSite: "Lax",
        httpOnly: true,
        secure: true,
      },
      deploymentClass: "production",
      demoCredentialsVisible: false,
      demoCredentials: [],
    },
    controlPlaneService: {
      async getInvitationByToken(token) {
        assert.equal(token, SECRET);
        return {
          status: "pending",
          expiresAt: new Date(Date.now() + 60_000),
          organisationName: "Ubuntu Medical Scheme",
          canonicalSlug: "ubuntu",
          email: "admin@ubuntu.example",
          ...invitationOverrides,
        };
      },
    },
  });

  return app;
}

test("invitation validation accepts the token only in a POST body", async () => {
  const app = createApp();

  const response = await app.request("/auth/invitation/validate", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token: SECRET }),
  });

  assert.equal(response.status, 200);
  assert.equal((await response.json()).available, true);

  const legacyResponse = await app.request(`/auth/invitation/${SECRET}`);
  assert.equal(legacyResponse.status, 404);
});

test("platform invitation validation exposes role-aware signup constraints without the token", async () => {
  const app = createApp({
    organisationName: "ClaimGuard",
    canonicalSlug: "claimguard",
    organisationType: "platform",
    invitationType: "platform_administrator",
    roleKey: "platform_administrator",
    email: "second@example.com",
  });

  const response = await app.request("/auth/invitation/validate", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token: SECRET }),
  });
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.invitationType, "platform_administrator");
  assert.equal(body.roleKey, "platform_administrator");
  assert.equal(body.roleLabel, "ClaimGuard Platform Administrator");
  assert.equal(body.passwordMinLength, 12);
  assert.equal("token" in body, false);
  assert.equal(JSON.stringify(body).includes(SECRET), false);
});

test("API telemetry redaction removes invitation and authentication secrets", () => {
  const event = scrubSentryEvent({
    request: {
      url: `https://api.example/auth/invitation/${SECRET}?token=${SECRET}#request=${SECRET}`,
      headers: {
        authorization: `Bearer ${SECRET}`,
        cookie: `session=${SECRET}`,
      },
      data: {
        token: SECRET,
        username: "ubuntu.admin",
      },
    },
    breadcrumbs: [
      {
        message: `GET /signup?token=${SECRET}`,
      },
    ],
  });

  const rendered = JSON.stringify(event);
  assert.equal(rendered.includes(SECRET), false);
  assert.match(rendered, /\[REDACTED\]/);
  assert.match(rendered, /ubuntu\.admin/);
});
