import mysql from "mysql2/promise";

import { buildConnectionOptions, requireOperationalDataPlaneContext } from "@claimguard/database";

function parseSecretId(secretId) {
  const url = new URL(secretId);
  const segments = url.pathname.split("/").filter(Boolean);
  if (segments.length < 2 || segments[0] !== "secrets") {
    throw new Error("Invalid Key Vault secret reference.");
  }
  return {
    vaultBaseUrl: `${url.protocol}//${url.host}`,
    secretName: segments[1],
    version: segments[2] || undefined,
  };
}

async function resolveSecret(secretId, clients, credential, SecretClient) {
  const parsed = parseSecretId(secretId);
  const clientKey = parsed.vaultBaseUrl.toLowerCase();
  if (!clients.has(clientKey)) {
    clients.set(clientKey, new SecretClient(parsed.vaultBaseUrl, credential));
  }
  const client = clients.get(clientKey);
  const secret = await client.getSecret(parsed.secretName, { version: parsed.version });
  if (!secret?.value) throw new Error("Resolved secret has no value.");
  return secret.value;
}

function splitSecretReferences(secretReference) {
  return String(secretReference || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

function normalizeSupportedSchemaVersions(values) {
  const versions = [...new Set(
    (Array.isArray(values) ? values : [values])
      .map((value) => String(value ?? "").trim())
      .filter(Boolean),
  )];
  if (!versions.length || versions.some((value) => !/^[1-9]\d*$/.test(value))) {
    throw new TypeError("supportedSchemaVersions must contain canonical positive integers.");
  }
  return versions;
}

function expectedMigrationVersion(schemaVersion) {
  const rendered = String(schemaVersion ?? "").trim();
  if (!/^[1-9]\d*$/.test(rendered)) {
    throw new Error("Private schema version is invalid.");
  }
  return Number(rendered);
}

export function createPrivateDatabaseAdapter({
  supportedSchemaVersions = ["14"],
  expectedEnvironment = "production",
  connectionLimit = 5,
  poolFactory = (options) => mysql.createPool(options),
  credential = null,
} = {}) {
  const secretClients = new Map();
  const resolvedConnectionUrls = new Map();
  const canonicalSupportedSchemaVersions = normalizeSupportedSchemaVersions(
    supportedSchemaVersions,
  );

  async function connectionUrlFor(context) {
    const key = `${context.organisationId}:${context.routeId}:${context.routeGeneration}`;
    if (resolvedConnectionUrls.has(key)) return resolvedConnectionUrls.get(key);

    const refs = splitSecretReferences(context.secretReference);
    if (refs.length !== 4) {
      throw new Error(
        "Private route secret reference must include exactly username, password, host, and database secret URLs.",
      );
    }
    const [resolvedCredential, { SecretClient }] = await Promise.all([
      credential
        ? Promise.resolve(credential)
        : import("@azure/identity").then(
          ({ DefaultAzureCredential }) => new DefaultAzureCredential(),
        ),
      import("@azure/keyvault-secrets"),
    ]);
    const [username, password, host, databaseName] = await Promise.all([
      resolveSecret(refs[0], secretClients, resolvedCredential, SecretClient),
      resolveSecret(refs[1], secretClients, resolvedCredential, SecretClient),
      resolveSecret(refs[2], secretClients, resolvedCredential, SecretClient),
      resolveSecret(refs[3], secretClients, resolvedCredential, SecretClient),
    ]);

    const encodedUser = encodeURIComponent(username);
    const encodedPassword = encodeURIComponent(password);
    const connectionUrl = `mysql://${encodedUser}:${encodedPassword}@${host}:3306/${databaseName}?ssl-mode=require`;
    resolvedConnectionUrls.set(key, connectionUrl);
    return connectionUrl;
  }

  function verifyMetadata(metadata, context) {
    if (!metadata) throw new Error("Private data-plane metadata is missing.");
    if (metadata.database_mode !== "private_database") {
      throw new Error("Private route type verification failed.");
    }

    const schemaVersion = String(metadata.schema_version ?? "").trim();
    if (!canonicalSupportedSchemaVersions.includes(schemaVersion)) {
      throw new Error("Private schema version is unsupported.");
    }
    if (schemaVersion !== String(context.schemaVersion)) {
      throw new Error("Private schema version does not match active route.");
    }
    if (metadata.environment_key !== expectedEnvironment) {
      throw new Error("Private environment verification failed.");
    }
    if (metadata.logical_database_identifier !== context.logicalDatabaseIdentifier) {
      throw new Error("Private logical database identifier mismatch.");
    }

    const migrationVersion = Number(metadata.migration_version);
    if (migrationVersion !== expectedMigrationVersion(schemaVersion)) {
      throw new Error("Private migration version verification failed.");
    }

    return Object.freeze({
      routeType: metadata.database_mode,
      logicalDatabaseIdentifier: metadata.logical_database_identifier,
      schemaVersion,
      migrationVersion,
    });
  }

  return Object.freeze({
    routeType: "private_database",

    async create(contextInput) {
      const context = requireOperationalDataPlaneContext(contextInput);
      if (context.routeType !== "private_database") {
        throw new Error("Private adapter can only be used for private_database routes.");
      }
      const url = await connectionUrlFor(context);
      return poolFactory({ ...buildConnectionOptions(url), connectionLimit });
    },

    async verify(pool, contextInput) {
      const context = requireOperationalDataPlaneContext(contextInput);
      const [rows] = await pool.execute(
        `SELECT database_mode, logical_database_identifier, schema_version, environment_key, migration_version
         FROM data_plane_metadata WHERE metadata_key = 'primary' LIMIT 1`,
      );
      return verifyMetadata(rows?.[0], context);
    },

    async close(pool) {
      await pool.end();
    },
  });
}
