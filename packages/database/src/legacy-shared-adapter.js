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

export function createLegacySharedAdapter({
  databaseUrl,
  expectedEnvironment = "legacy",
  supportedSchemaVersions = ["8"],
  expectedLogicalDatabaseIdentifier = "legacy-operational-shared",
  expectedMigrationVersion = 8,
  connectionLimit = 5,
  poolFactory = (options) => mysql.createPool(options),
} = {}) {
  if (typeof databaseUrl !== "string" || !databaseUrl.trim()) throw new TypeError("The legacy_shared adapter requires MYSQL_URL explicitly.");
  if (!Number.isInteger(connectionLimit) || connectionLimit < 1) throw new TypeError("connectionLimit must be a positive integer.");
  const parsed = new URL(databaseUrl);
  const configuredDatabaseName = parsed.pathname.replace(/^\//, "");
  if (!configuredDatabaseName) throw new TypeError("MYSQL_URL must include the operational database name.");

  function verifyBaseline(metadata) {
    if (!metadata) throw new DataPlaneMetadataMismatchError("Operational data-plane metadata is missing.", "DATA_PLANE_METADATA_MISSING");
    if (metadata.database_mode !== "legacy_shared") throw new DataPlaneMetadataMismatchError("Operational route type verification failed.", "DATA_PLANE_ROUTE_TYPE_MISMATCH");
    if (!supportedSchemaVersions.includes(String(metadata.schema_version))) throw new DataPlaneMetadataMismatchError("Operational schema version is unsupported.", "DATA_PLANE_SCHEMA_UNSUPPORTED");
    if (metadata.environment_key !== expectedEnvironment) throw new DataPlaneMetadataMismatchError("Operational environment verification failed.", "DATA_PLANE_ENVIRONMENT_MISMATCH");
    if (metadata.logical_database_identifier !== expectedLogicalDatabaseIdentifier) throw new DataPlaneMetadataMismatchError("Logical database identity verification failed.", "DATA_PLANE_LOGICAL_IDENTITY_MISMATCH");
    if (Number(metadata.migration_version) !== expectedMigrationVersion) throw new DataPlaneMetadataMismatchError("Operational migration version verification failed.", "DATA_PLANE_MIGRATION_VERSION_MISMATCH");
  }

  return Object.freeze({
    routeType: "legacy_shared",
    async create(context) {
      const verified = requireOperationalDataPlaneContext(context);
      if (verified.databaseName && verified.databaseName !== configuredDatabaseName) {
        throw new DataPlaneMetadataMismatchError("The configured operational database does not match the active route.", "DATA_PLANE_DATABASE_MISMATCH");
      }
      return poolFactory({ ...buildConnectionOptions(databaseUrl.trim()), connectionLimit });
    },
    async verify(pool, context) {
      const verified = requireOperationalDataPlaneContext(context);
      const [rows] = await pool.execute(
        `SELECT database_mode, logical_database_identifier, schema_version, environment_key, migration_version
         FROM data_plane_metadata WHERE metadata_key = 'primary' LIMIT 1`,
      );
      const metadata = rows?.[0];
      verifyBaseline(metadata);
      if (!supportedSchemaVersions.includes(String(metadata.schema_version)) || String(metadata.schema_version) !== verified.schemaVersion) {
        throw new DataPlaneMetadataMismatchError("Operational schema version is unsupported.", "DATA_PLANE_SCHEMA_UNSUPPORTED");
      }
      if (metadata.logical_database_identifier !== verified.logicalDatabaseIdentifier) {
        throw new DataPlaneMetadataMismatchError("Logical database identity verification failed.", "DATA_PLANE_LOGICAL_IDENTITY_MISMATCH");
      }
      return Object.freeze({
        routeType: metadata.database_mode,
        logicalDatabaseIdentifier: metadata.logical_database_identifier,
        schemaVersion: String(metadata.schema_version),
        migrationVersion: Number(metadata.migration_version),
      });
    },
    async checkBaseline() {
      const pool = poolFactory({ ...buildConnectionOptions(databaseUrl.trim()), connectionLimit: 1 });
      try {
        const [rows] = await pool.execute(
          `SELECT database_mode, logical_database_identifier, schema_version, environment_key, migration_version
           FROM data_plane_metadata WHERE metadata_key = 'primary' LIMIT 1`,
        );
        verifyBaseline(rows?.[0]);
        return Object.freeze({ reachable: true, schemaCompatible: true, routeType: "legacy_shared" });
      } finally {
        await pool.end();
      }
    },
    async close(pool) { await pool.end(); },
  });
}
