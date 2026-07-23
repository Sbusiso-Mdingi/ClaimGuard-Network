import mysql from "mysql2/promise";

import { buildConnectionOptions } from "./client.js";
import { requireOperationalDataPlaneContext } from "./data-plane-context.js";

export class DataPlaneMetadataMismatchError extends Error {
  constructor(message, code = "DATA_PLANE_METADATA_MISMATCH") {
    super(message);
    this.name = "DataPlaneMetadataMismatchError";
    this.code = code;
    this.status = 503;
  }
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
    throw new DataPlaneMetadataMismatchError(
      "Operational schema version is invalid.",
      "DATA_PLANE_SCHEMA_INVALID",
    );
  }
  return Number(rendered);
}

export function createLegacySharedAdapter({
  databaseUrl,
  expectedEnvironment = "legacy",
  supportedSchemaVersions = ["14"],
  expectedLogicalDatabaseIdentifier = "legacy-operational-shared",
  connectionLimit = 5,
  poolFactory = (options) => mysql.createPool(options),
} = {}) {
  if (typeof databaseUrl !== "string" || !databaseUrl.trim()) {
    throw new TypeError("The legacy_shared adapter requires MYSQL_URL explicitly.");
  }
  if (!Number.isInteger(connectionLimit) || connectionLimit < 1) {
    throw new TypeError("connectionLimit must be a positive integer.");
  }

  const canonicalSupportedSchemaVersions = normalizeSupportedSchemaVersions(
    supportedSchemaVersions,
  );
  const parsed = new URL(databaseUrl);
  const configuredDatabaseName = parsed.pathname.replace(/^\//, "");
  if (!configuredDatabaseName) {
    throw new TypeError("MYSQL_URL must include the operational database name.");
  }

  function verifyBaseline(metadata, contextSchemaVersion = null) {
    if (!metadata) {
      throw new DataPlaneMetadataMismatchError(
        "Operational data-plane metadata is missing.",
        "DATA_PLANE_METADATA_MISSING",
      );
    }
    if (metadata.database_mode !== "legacy_shared") {
      throw new DataPlaneMetadataMismatchError(
        "Operational route type verification failed.",
        "DATA_PLANE_ROUTE_TYPE_MISMATCH",
      );
    }

    const schemaVersion = String(metadata.schema_version ?? "").trim();
    if (!canonicalSupportedSchemaVersions.includes(schemaVersion)) {
      throw new DataPlaneMetadataMismatchError(
        "Operational schema version is unsupported.",
        "DATA_PLANE_SCHEMA_UNSUPPORTED",
      );
    }
    if (contextSchemaVersion !== null && schemaVersion !== String(contextSchemaVersion)) {
      throw new DataPlaneMetadataMismatchError(
        "Operational schema version does not match the active route.",
        "DATA_PLANE_SCHEMA_MISMATCH",
      );
    }
    if (metadata.environment_key !== expectedEnvironment) {
      throw new DataPlaneMetadataMismatchError(
        "Operational environment verification failed.",
        "DATA_PLANE_ENVIRONMENT_MISMATCH",
      );
    }
    if (metadata.logical_database_identifier !== expectedLogicalDatabaseIdentifier) {
      throw new DataPlaneMetadataMismatchError(
        "Logical database identity verification failed.",
        "DATA_PLANE_LOGICAL_IDENTITY_MISMATCH",
      );
    }

    const migrationVersion = Number(metadata.migration_version);
    if (migrationVersion !== expectedMigrationVersion(schemaVersion)) {
      throw new DataPlaneMetadataMismatchError(
        "Operational migration version verification failed.",
        "DATA_PLANE_MIGRATION_VERSION_MISMATCH",
      );
    }

    return Object.freeze({
      routeType: metadata.database_mode,
      logicalDatabaseIdentifier: metadata.logical_database_identifier,
      schemaVersion,
      migrationVersion,
    });
  }

  return Object.freeze({
    routeType: "legacy_shared",

    async create(context) {
      const verified = requireOperationalDataPlaneContext(context);
      if (verified.databaseName && verified.databaseName !== configuredDatabaseName) {
        throw new DataPlaneMetadataMismatchError(
          "The configured operational database does not match the active route.",
          "DATA_PLANE_DATABASE_MISMATCH",
        );
      }
      return poolFactory({
        ...buildConnectionOptions(databaseUrl.trim()),
        connectionLimit,
      });
    },

    async verify(pool, context) {
      const verified = requireOperationalDataPlaneContext(context);
      const [rows] = await pool.execute(
        `SELECT database_mode, logical_database_identifier, schema_version, environment_key, migration_version
         FROM data_plane_metadata WHERE metadata_key = 'primary' LIMIT 1`,
      );
      const result = verifyBaseline(rows?.[0], verified.schemaVersion);
      if (result.logicalDatabaseIdentifier !== verified.logicalDatabaseIdentifier) {
        throw new DataPlaneMetadataMismatchError(
          "Logical database identity verification failed.",
          "DATA_PLANE_LOGICAL_IDENTITY_MISMATCH",
        );
      }
      return result;
    },

    async checkBaseline() {
      const pool = poolFactory({
        ...buildConnectionOptions(databaseUrl.trim()),
        connectionLimit: 1,
      });
      try {
        const [rows] = await pool.execute(
          `SELECT database_mode, logical_database_identifier, schema_version, environment_key, migration_version
           FROM data_plane_metadata WHERE metadata_key = 'primary' LIMIT 1`,
        );
        const result = verifyBaseline(rows?.[0]);
        return Object.freeze({
          reachable: true,
          schemaCompatible: true,
          routeType: result.routeType,
          schemaVersion: result.schemaVersion,
          migrationVersion: result.migrationVersion,
        });
      } finally {
        await pool.end();
      }
    },

    async close(pool) {
      await pool.end();
    },
  });
}
