import assert from "node:assert/strict";
import test from "node:test";

import { createControlPlaneRepositories } from "../src/index.js";

function executor(handler) {
  return { async execute(sql, params = []) { return handler(String(sql).replace(/\s+/g, " ").trim(), params); } };
}

test("shadow credential accepts nullable hash, scopes username, and safe DTO hides hash", async () => {
  let stored = null;
  const db = executor(async (sql, params) => {
    if (sql.startsWith("INSERT INTO credential_identities")) {
      stored = {
        credential_id: params[0], user_id: params[1], organisation_id: params[2], authentication_provider: params[3],
        normalized_username: params[4], password_hash: params[6], status: params[10], failed_attempt_count: 0,
      };
      return [{ affectedRows: 1 }, []];
    }
    if (sql.startsWith("SELECT * FROM credential_identities WHERE credential_id")) return [[stored], []];
    throw new Error(`Unexpected SQL: ${sql}`);
  });
  const repositories = createControlPlaneRepositories(db);
  const credential = await repositories.identity.createCredential({
    userId: "user-1", organisationId: "org-1", username: " Shadow.User ", status: "pending_activation",
  });
  assert.equal(credential.normalizedUsername, "shadow.user");
  assert.equal(credential.passwordConfigured, false);
  assert.equal(Object.hasOwn(credential, "passwordHash"), false);
  await assert.rejects(
    () => repositories.identity.createCredential({ userId: "u", organisationId: "o", username: "x", password: "unsafe" }),
    /Plaintext/,
  );
});

test("session foundation stores only a hash and safe projection excludes it", async () => {
  let stored = null;
  const db = executor(async (sql, params) => {
    if (sql.startsWith("INSERT INTO login_sessions")) {
      stored = {
        session_id: params[0], hashed_bearer_secret: params[1], user_id: params[3], organisation_id: params[4],
        membership_id: params[5], issued_at: params[6], last_activity_at: params[7], idle_expires_at: params[8],
        absolute_expires_at: params[9], authorization_version: params[10],
      };
      return [{ affectedRows: 1 }, []];
    }
    if (sql.startsWith("SELECT * FROM login_sessions")) return [[stored], []];
    throw new Error(`Unexpected SQL: ${sql}`);
  });
  const repository = createControlPlaneRepositories(db).security;
  const session = await repository.storeSessionFoundation({
    hashedBearerSecret: "a".repeat(64), signingKeyId: "key-1", userId: "u", organisationId: "o", membershipId: "m",
    issuedAt: new Date(), idleExpiresAt: new Date(Date.now() + 1000), absoluteExpiresAt: new Date(Date.now() + 2000), authorizationVersion: 1,
  });
  assert.equal(Object.hasOwn(session, "hashedBearerSecret"), false);
  await assert.rejects(() => repository.storeSessionFoundation({ bearerSecret: "raw" }), /Raw session/);
});

test("audit repository preserves correlation and rejects private medical fields", async () => {
  const inserts = [];
  const db = executor(async (sql, params) => { inserts.push({ sql, params }); return [{ affectedRows: 1 }, []]; });
  const repository = createControlPlaneRepositories(db).security;
  const result = await repository.recordPlatformAudit({
    actorType: "system", action: "organisation.check", targetType: "organisation", targetId: "o",
    afterSummary: { status: "active" }, correlationId: "corr-1", outcome: "success", source: "test",
  });
  assert.equal(result.correlationId, "corr-1");
  await assert.rejects(
    () => repository.recordPlatformAudit({ actorType: "system", action: "x", targetType: "x", afterSummary: { claim_payload: {} }, source: "test" }),
    /not permitted/,
  );
});

test("demo catalogue requires demo organisation and never returns secret reference", async () => {
  const row = {
    catalogue_entry_id: "d", organisation_id: "o", membership_id: "m", display_label: "Demo Investigator",
    role_label: "Investigator", username_display_value: "demo", secret_reference: "kv://demo", enabled: 1, display_order: 1,
  };
  const db = executor(async (sql) => {
    if (sql.startsWith("SELECT deployment_class")) return [[{ deployment_class: "demo" }], []];
    if (sql.startsWith("INSERT INTO demo_account_catalogue")) return [{ affectedRows: 1 }, []];
    if (sql.startsWith("SELECT * FROM demo_account_catalogue")) return [[row], []];
    throw new Error(`Unexpected SQL: ${sql}`);
  });
  const repository = createControlPlaneRepositories(db).configuration;
  await repository.createDemoCatalogueEntry({
    organisationId: "o", membershipId: "m", displayLabel: "Demo Investigator", roleLabel: "Investigator",
    usernameDisplayValue: "demo", secretReference: "kv://demo", enabled: true,
  });
  const [safe] = await repository.listSafeEnabledDemoCatalogue("o");
  assert.equal(Object.hasOwn(safe, "secretReference"), false);
});

test("route registration increments generation and safe routes omit secret references", async () => {
  let stored = null;
  const db = executor(async (sql, params) => {
    if (sql.startsWith("SELECT COALESCE(MAX(route_generation)")) return [[{ next_generation: 4 }], []];
    if (sql.startsWith("UPDATE data_plane_routes")) return [{ affectedRows: 1 }, []];
    if (sql.startsWith("INSERT INTO data_plane_routes")) {
      stored = {
        route_id: params[0], organisation_id: params[1], route_type: params[2], logical_database_identifier: params[3],
        secret_reference: params[6], region: params[7], route_generation: params[8], schema_version: params[9],
        provisioning_status: params[10], health_status: params[11], active_at: params[12],
      };
      return [{ affectedRows: 1 }, []];
    }
    if (sql.startsWith("SELECT * FROM data_plane_routes WHERE route_id")) return [[stored], []];
    throw new Error(`Unexpected SQL: ${sql}`);
  });
  const repository = createControlPlaneRepositories(db).routes;
  const route = await repository.register({
    organisationId: "org-1", routeType: "legacy_shared", logicalDatabaseIdentifier: "legacy-operational",
    databaseName: "legacy", secretReference: "kv://legacy-db", activate: true,
  });
  assert.equal(route.routeGeneration, 4);
  assert.equal(Object.hasOwn(route, "secretReference"), false);
  await assert.rejects(
    () => repository.register({ organisationId: "org-1", routeType: "legacy_shared", logicalDatabaseIdentifier: "x", secretReference: "mysql://u:p@h/d" }),
    /secret value|connection string/,
  );
});

test("authentication events accept safe hashes and preserve correlation IDs", async () => {
  let inserted = null;
  const db = executor(async (sql, params) => { inserted = { sql, params }; return [{ affectedRows: 1 }, []]; });
  const repository = createControlPlaneRepositories(db).security;
  const event = await repository.recordAuthenticationEvent({
    eventType: "login_failure", organisationCandidateHash: "a".repeat(64), sourceNetworkHash: "b".repeat(64),
    userAgentHash: "c".repeat(64), correlationId: "corr-auth", result: "failure", failureCategory: "invalid_credentials",
  });
  assert.equal(event.correlationId, "corr-auth");
  assert.equal(inserted.params.includes("password"), false);
  await assert.rejects(() => repository.recordAuthenticationEvent({ eventType: "unknown" }), /Unsupported/);
  await assert.rejects(
    () => repository.recordAuthenticationEvent({ eventType: "login_failure", password: "unsafe" }),
    /not permitted/,
  );
  await assert.rejects(
    () => repository.recordAuthenticationEvent({ eventType: "login_failure", sourceNetworkHash: "not-a-hash" }),
    /SHA-256/,
  );
});

test("users are platform-level and one user can hold memberships in multiple organisations", async () => {
  const memberships = new Map();
  let userInsertSql = "";
  const db = executor(async (sql, params) => {
    if (sql.startsWith("INSERT INTO users")) { userInsertSql = sql; return [{ affectedRows: 1 }, []]; }
    if (sql.startsWith("SELECT * FROM users")) {
      return [[{ user_id: "user-1", display_name: "Shared User", status: "active", authentication_version: 1 }], []];
    }
    if (sql.startsWith("INSERT INTO organisation_memberships")) {
      memberships.set(params[0], {
        membership_id: params[0], user_id: params[1], organisation_id: params[2], status: params[3],
      });
      return [{ affectedRows: 1 }, []];
    }
    if (sql.startsWith("SELECT * FROM organisation_memberships")) return [[memberships.get(params[0])], []];
    throw new Error(`Unexpected SQL: ${sql}`);
  });
  const identity = createControlPlaneRepositories(db).identity;
  const user = await identity.createUser({ userId: "user-1", displayName: "Shared User", status: "active" });
  const first = await identity.createMembership({ membershipId: "m-1", userId: user.userId, organisationId: "org-1", status: "active" });
  const second = await identity.createMembership({ membershipId: "m-2", userId: user.userId, organisationId: "org-2", status: "active" });
  assert.doesNotMatch(userInsertSql, /organisation_id/);
  assert.equal(first.userId, second.userId);
  assert.notEqual(first.organisationId, second.organisationId);
});

test("repository conflicts preserve typed duplicate slug and username errors", async () => {
  const duplicate = new Error("duplicate");
  duplicate.code = "ER_DUP_ENTRY";
  const db = executor(async (sql) => {
    if (sql.startsWith("INSERT INTO organisations") || sql.startsWith("INSERT INTO credential_identities")) throw duplicate;
    throw new Error(`Unexpected SQL: ${sql}`);
  });
  const repositories = createControlPlaneRepositories(db);
  await assert.rejects(
    () => repositories.organisations.createDraft({
      organisationId: "org-1", displayName: "Alpha", canonicalSlug: "alpha", organisationType: "medical_scheme", deploymentClass: "demo",
    }),
    (error) => error.code === "ORGANISATION_CONFLICT",
  );
  await assert.rejects(
    () => repositories.identity.createCredential({ userId: "u", organisationId: "o", username: "same" }),
    (error) => error.code === "CREDENTIAL_USERNAME_CONFLICT",
  );
});

test("demo catalogue rejects non-demo organisations and plaintext password aliases", async () => {
  const db = executor(async (sql) => {
    if (sql.startsWith("SELECT deployment_class")) return [[{ deployment_class: "production" }], []];
    throw new Error(`Unexpected SQL: ${sql}`);
  });
  const repository = createControlPlaneRepositories(db).configuration;
  await assert.rejects(
    () => repository.createDemoCatalogueEntry({ organisationId: "o", plaintextPassword: "unsafe" }),
    /Plaintext/,
  );
  await assert.rejects(
    () => repository.createDemoCatalogueEntry({ organisationId: "o" }),
    /demo-classified/,
  );
});

test("provisioning step completion is repeatable and failures store classified safe metadata", async () => {
  const calls = [];
  const db = executor(async (sql, params) => { calls.push({ sql, params }); return [{ affectedRows: 1 }, []]; });
  const provisioning = createControlPlaneRepositories(db).provisioning;
  const first = await provisioning.completeStep({ operationId: "op", stepKey: "schema" });
  const repeated = await provisioning.completeStep({ operationId: "op", stepKey: "schema" });
  const failed = await provisioning.failStep({
    operationId: "op", stepKey: "route", error: Object.assign(new Error("mysql://user:secret@host/db"), { code: "ER_CONNECT" }),
  });
  assert.deepEqual(first, repeated);
  assert.equal(failed.errorType, "Error");
  const failureCall = calls.at(-1);
  assert.deepEqual(failureCall.params.slice(-2), ["Error", "Error:ER_CONNECT"]);
  assert.equal(failureCall.params.some((value) => String(value).includes("secret@host")), false);
});
