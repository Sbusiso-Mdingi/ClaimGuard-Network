import assert from "node:assert/strict";
import test from "node:test";
import { Hono } from "hono";

import { CANONICAL_OPERATIONAL_SCHEMA_VERSION } from "@claimguard/database";

import { createBackendApp } from "../src/backend.js";
import { createAuthenticatedAuthContext } from "../src/middleware/auth-context.js";
import { createDesktopOrganisationEnforcementMiddleware } from "../src/desktop-device-proof.js";
import { registerDesktopRoutes } from "../src/routes/desktop-routes.js";

test("desktop login renews signed offline grace before returning the session", async () => {
  const app = new Hono();
  const loginInputs = [];
  const renewals = [];
  app.use("*", async (c, next) => {
    c.set("desktopDevice", {
      deviceEnrollmentId: "device-alpha",
      organisationId: "org-alpha",
      organisationSlug: "alpha-medical",
      organisationDisplayName: "Alpha Medical",
    });
    await next();
  });
  registerDesktopRoutes(app, {
    desktopEnrollmentService: {
      async renewEnrollment(device) {
        renewals.push(device.deviceEnrollmentId);
        return { signedEnrollment: "renewed-signed-enrollment" };
      },
    },
    authenticationConfiguration: {
      deploymentClass: "test",
      cookie: { name: "claim_guard_session", sameSite: "Strict", httpOnly: true, secure: true },
    },
    authenticationService: {
      async login(input) {
        loginInputs.push(input);
        return {
          bearerSecret: "session-secret",
          csrfToken: "csrf-token",
          actor: {
            user: {
              userId: "user-alpha",
              displayName: "Analyst",
              canonicalContact: "analyst@alpha.example",
              status: "active",
            },
            organisation: {
              organisationId: "org-alpha",
              organisationType: "medical_scheme",
              canonicalSlug: "alpha-medical",
            },
            membership: { status: "active" },
            credential: {
              normalizedUsername: "analyst",
              status: "active",
              authenticationProvider: "local_password",
            },
            roles: ["claims_analyst"],
            permissions: ["claims.view_own"],
          },
          session: {
            issuedAt: "2026-08-01T00:00:00.000Z",
            lastActivityAt: "2026-08-01T00:00:00.000Z",
            idleExpiresAt: "2026-08-01T01:00:00.000Z",
            absoluteExpiresAt: "2026-08-02T00:00:00.000Z",
          },
        };
      },
      async logout() {},
    },
  });
  const response = await app.request("/desktop/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: "analyst", password: "correct-password" }),
  });
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.deepEqual(renewals, ["device-alpha"]);
  assert.equal(body.enrollment.signedEnrollment, "renewed-signed-enrollment");
  assert.equal(body.licensedOrganisation.organisationId, "org-alpha");
  assert.deepEqual(loginInputs, [{
    organisationSlug: "alpha-medical",
    username: "analyst",
    password: "correct-password",
    requiredOrganisationId: "org-alpha",
  }]);
});

test("scheme administrators can use an enrolled scheme desktop while platform administrators are rejected", async () => {
  const renewals = [];
  const loggedOutRoles = [];
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.set("desktopDevice", {
      deviceEnrollmentId: "device-alpha",
      organisationId: "org-alpha",
      organisationSlug: "alpha-medical",
      organisationDisplayName: "Alpha Medical",
    });
    await next();
  });
  registerDesktopRoutes(app, {
    desktopEnrollmentService: {
      async renewEnrollment() {
        renewals.push("renewed");
        return { signedEnrollment: "renewed-signed-enrollment" };
      },
    },
    authenticationConfiguration: {
      deploymentClass: "test",
      cookie: { name: "claim_guard_session", sameSite: "Strict", httpOnly: true, secure: true },
    },
    authenticationService: {
      async login({ username }) {
        const platform = username === "platform-admin";
        const roles = [platform ? "platform_administrator" : "scheme_administrator"];
        return {
          bearerSecret: "session-secret",
          csrfToken: "csrf-token",
          actor: {
            user: { userId: "user-1", displayName: "Administrator", status: "active" },
            organisation: {
              organisationId: "org-alpha",
              organisationType: platform ? "platform" : "medical_scheme",
              canonicalSlug: "alpha-medical",
            },
            membership: { status: "active" },
            credential: { normalizedUsername: username, status: "active", authenticationProvider: "local_password" },
            roles,
            permissions: [],
          },
          session: {
            issuedAt: "2026-08-01T00:00:00.000Z",
            lastActivityAt: "2026-08-01T00:00:00.000Z",
            idleExpiresAt: "2026-08-01T01:00:00.000Z",
            absoluteExpiresAt: "2026-08-02T00:00:00.000Z",
          },
        };
      },
      async logout(result) {
        loggedOutRoles.push(result.actor.roles[0]);
      },
    },
  });

  const schemeResponse = await app.request("/desktop/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: "scheme-admin", password: "correct-password" }),
  });
  assert.equal(schemeResponse.status, 200);
  assert.deepEqual((await schemeResponse.json()).roles, ["scheme_administrator"]);

  const platformResponse = await app.request("/desktop/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: "platform-admin", password: "correct-password" }),
  });
  assert.equal(platformResponse.status, 401);
  assert.equal((await platformResponse.json()).code, "DESKTOP_AUTHENTICATION_FAILED");
  assert.deepEqual(renewals, ["renewed"]);
  assert.deepEqual(loggedOutRoles, ["platform_administrator"]);
});

test("a user from another organisation is denied before desktop route data", async () => {
  let reached = false;
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.set("desktopDevice", { organisationId: "org-alpha" });
    c.set("authContext", { is_authenticated: true, organisation_id: "org-beta" });
    c.set("dataPlaneContext", { organisationId: "org-alpha" });
    await next();
  });
  app.use("*", createDesktopOrganisationEnforcementMiddleware());
  app.get("/desktop/sync/bootstrap", (c) => { reached = true; return c.json({ available: true }); });
  const response = await app.request("/desktop/sync/bootstrap");
  assert.equal(response.status, 403);
  assert.equal((await response.json()).code, "DESKTOP_ORGANISATION_MISMATCH");
  assert.equal(reached, false);
});

test("an enrolled organisation cannot be changed by query or headers", async () => {
  const resolvedOrganisations = [];
  const app = createBackendApp({
    authenticationProvider: {
      async resolveAuthContext() {
        return createAuthenticatedAuthContext({
          userId: "user-alpha",
          roles: ["claims_analyst"],
          permissions: ["claims.view_own"],
          tenantId: "tenant-alpha",
          organisationId: "org-alpha",
          organisation: { organisationId: "org-alpha", organisationType: "medical_scheme" },
        });
      },
    },
    desktopDeviceProofVerifier: {
      async verify() {
        return {
          deviceEnrollmentId: "device-alpha",
          organisationId: "org-alpha",
          organisationDisplayName: "Alpha Medical",
        };
      },
    },
    desktopEnrollmentService: { async renewEnrollment() { return { signedEnrollment: "renewed" }; } },
    desktopSyncService: { async bootstrap() { throw new Error("routing override should be rejected first"); } },
    dataPlaneRuntime: {
      routeResolver: {
        async resolve({ organisationId }) {
          resolvedOrganisations.push(organisationId);
          return {
            organisationId: "org-alpha",
            organisationType: "medical_scheme",
            organisationStatus: "active",
            operationalTenantId: "tenant-alpha",
            operationalTenantSlug: "alpha",
            routeId: "route-alpha",
            routeType: "legacy_shared",
            routeGeneration: 1,
            logicalDatabaseIdentifier: "legacy-shared",
            databaseName: "operational",
            schemaVersion: CANONICAL_OPERATIONAL_SCHEMA_VERSION,
            deploymentClass: "test",
          };
        },
      },
      connectionManager: {
        async acquire() {
          const pool = {
            execute: async () => [[], []],
            query: async () => [[], []],
            async getConnection() {
              return {
                execute: pool.execute,
                query: pool.query,
                beginTransaction: async () => {},
                commit: async () => {},
                rollback: async () => {},
                release() {},
              };
            },
          };
          return { pool, async release() {} };
        },
      },
      logger() {},
    },
  });
  const response = await app.request("http://internal/desktop/sync/bootstrap?organisationId=org-beta", {
    headers: { dpop: "verified-by-test-double", "x-organisation-id": "org-beta" },
  });
  const body = await response.json();
  assert.equal(response.status, 400);
  assert.equal(body.code, "DESKTOP_ROUTING_OVERRIDE_REJECTED");
  assert.deepEqual(resolvedOrganisations, ["org-alpha"]);
});
