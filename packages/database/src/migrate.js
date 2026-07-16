import crypto from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const defaultMigrationPath = fileURLToPath(new URL("../migrations/0001_initial.sql", import.meta.url));
export const defaultMigrationPaths = Object.freeze([
  defaultMigrationPath,
  fileURLToPath(new URL("../migrations/0002_investigations.sql", import.meta.url)),
  fileURLToPath(new URL("../migrations/0003_shared_fraud_registry.sql", import.meta.url)),
  fileURLToPath(new URL("../migrations/0004_claim_processing_outbox.sql", import.meta.url)),
  fileURLToPath(new URL("../migrations/0005_atomic_fraud_workflows.sql", import.meta.url)),
  fileURLToPath(new URL("../migrations/0006_tenant_snapshot_reports.sql", import.meta.url)),
  fileURLToPath(new URL("../migrations/0007_simulation_runtime.sql", import.meta.url)),
  fileURLToPath(new URL("../migrations/0008_data_plane_metadata.sql", import.meta.url)),
  fileURLToPath(new URL("../migrations/0009_data_plane_metadata_singleton.sql", import.meta.url)),
]);

const MIGRATION_LOCK_NAME = "claimguard_operational_migrations";
const migrationHistorySql = `
  CREATE TABLE IF NOT EXISTS operational_migration_history (
    migration_id VARCHAR(255) PRIMARY KEY,
    checksum CHAR(64) NOT NULL,
    applied_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    execution_duration_ms INT UNSIGNED NOT NULL,
    application_version VARCHAR(128) NULL
  )
`;

export class OperationalMigrationChecksumMismatchError extends Error {
  constructor(migrationId) {
    super(`Applied operational migration ${migrationId} no longer matches its recorded checksum.`);
    this.name = "OperationalMigrationChecksumMismatchError";
    this.code = "OPERATIONAL_MIGRATION_CHECKSUM_MISMATCH";
    this.migrationId = migrationId;
  }
}

export class OperationalMigrationExecutionError extends Error {
  constructor(migrationId, statementIndex, cause) {
    super(`Operational migration ${migrationId} failed at statement ${statementIndex}.`);
    this.name = "OperationalMigrationExecutionError";
    this.code = "OPERATIONAL_MIGRATION_FAILED";
    this.migrationId = migrationId;
    this.statementIndex = statementIndex;
    this.cause = cause;
  }
}

function splitSqlStatements(sql) {
  return sql
    .split(/;\s*(?:\r?\n|$)/)
    .map((statement) => statement.trim())
    .filter(Boolean);
}

export function operationalMigrationChecksum(sql) {
  return crypto.createHash("sha256").update(sql.replace(/\r\n/g, "\n")).digest("hex");
}

async function loadMigrations(migrationPath = defaultMigrationPaths) {
  const migrationPaths = Array.isArray(migrationPath) ? migrationPath : [migrationPath];
  return Promise.all(migrationPaths.map(async (filePath) => {
    const sql = await readFile(filePath, "utf8");
    return {
      id: path.basename(filePath, path.extname(filePath)),
      filePath,
      checksum: operationalMigrationChecksum(sql),
      statements: splitSqlStatements(sql),
    };
  }));
}

async function withConnection(pool, operation) {
  if (typeof pool?.getConnection !== "function") return operation(pool);
  const connection = await pool.getConnection();
  try {
    return await operation(connection);
  } finally {
    connection.release();
  }
}

function isAdoptionIdempotencyError(error) {
  return [
    "ER_DUP_FIELDNAME",
    "ER_DUP_KEY",
    "ER_DUP_KEYNAME",
    "ER_FK_DUP_NAME",
    "ER_TABLE_EXISTS_ERROR",
  ].includes(error?.code);
}

export async function getOperationalMigrationStatus(pool, { migrationPath = defaultMigrationPaths } = {}) {
  const migrations = await loadMigrations(migrationPath);
  return withConnection(pool, async (connection) => {
    await connection.query(migrationHistorySql);
    const [rows] = await connection.query(
      "SELECT migration_id, checksum, applied_at, execution_duration_ms, application_version FROM operational_migration_history ORDER BY migration_id",
    );
    const appliedById = new Map((rows || []).map((row) => [row.migration_id, row]));
    for (const migration of migrations) {
      const applied = appliedById.get(migration.id);
      if (applied && applied.checksum !== migration.checksum) throw new OperationalMigrationChecksumMismatchError(migration.id);
    }
    return {
      applied: (rows || []).map((row) => ({
        id: row.migration_id,
        checksum: row.checksum,
        appliedAt: row.applied_at,
        executionDurationMs: Number(row.execution_duration_ms),
        applicationVersion: row.application_version || null,
      })),
      pending: migrations.filter((migration) => !appliedById.has(migration.id)).map((migration) => ({
        id: migration.id,
        checksum: migration.checksum,
        statementCount: migration.statements.length,
      })),
    };
  });
}

export async function applyMigrations(pool, migrationPath = defaultMigrationPaths, {
  applicationVersion = process.env.CLAIMGUARD_APP_VERSION || null,
} = {}) {
  const migrations = await loadMigrations(migrationPath);
  return withConnection(pool, async (connection) => {
    const [lockRows] = await connection.query("SELECT GET_LOCK(?, 30) AS acquired", [MIGRATION_LOCK_NAME]);
    if (Number(lockRows?.[0]?.acquired) !== 1) throw new Error("Could not acquire the operational migration lock.");
    try {
      await connection.query(migrationHistorySql);
      const [historyRows] = await connection.query("SELECT migration_id, checksum FROM operational_migration_history ORDER BY migration_id");
      const appliedById = new Map((historyRows || []).map((row) => [row.migration_id, row]));
      const applied = [];
      const skipped = [];
      let appliedStatements = 0;

      for (const migration of migrations) {
        const existing = appliedById.get(migration.id);
        if (existing) {
          if (existing.checksum !== migration.checksum) throw new OperationalMigrationChecksumMismatchError(migration.id);
          skipped.push(migration.id);
          continue;
        }
        const startedAt = Date.now();
        for (let index = 0; index < migration.statements.length; index += 1) {
          try {
            await connection.query(migration.statements[index]);
          } catch (error) {
            // This permits a one-time adoption of checksum history by databases
            // created with the previous raw-SQL runner. Once history is present,
            // every migration is skipped or checksum-validated.
            if (!isAdoptionIdempotencyError(error)) {
              throw new OperationalMigrationExecutionError(migration.id, index + 1, error);
            }
          }
          appliedStatements += 1;
        }
        const executionDurationMs = Math.max(0, Date.now() - startedAt);
        await connection.query(
          `INSERT INTO operational_migration_history
            (migration_id, checksum, execution_duration_ms, application_version)
           VALUES (?, ?, ?, ?)`,
          [migration.id, migration.checksum, executionDurationMs, applicationVersion],
        );
        applied.push({ id: migration.id, checksum: migration.checksum, executionDurationMs });
      }

      return {
        applied,
        skipped,
        pending: [],
        appliedStatements,
        migrationPath: migrations.length === 1 ? migrations[0].filePath : null,
        migrationPaths: migrations.map((migration) => migration.filePath),
        warning: "MySQL DDL can implicitly commit; a failed migration is visible because its history row is not recorded.",
      };
    } finally {
      await connection.query("SELECT RELEASE_LOCK(?) AS released", [MIGRATION_LOCK_NAME]).catch(() => undefined);
    }
  });
}

async function ensureDatabaseExists(databaseUrl) {
  const { buildConnectionOptions } = await import("./client.js");
  const connectionOptions = buildConnectionOptions(databaseUrl, { includeDatabase: false });
  const databaseName = new URL(databaseUrl).pathname.replace(/^\//, "");
  const adminPool = await import("mysql2/promise").then(({ default: mysql }) => mysql.createPool(connectionOptions));
  try {
    await adminPool.query(`CREATE DATABASE IF NOT EXISTS \`${databaseName}\``);
  } finally {
    await adminPool.end();
  }
}

const isDirectExecution = process.argv[1] === fileURLToPath(import.meta.url);

if (isDirectExecution) {
  (async () => {
    if (process.env.OPERATIONAL_ADMIN_MODE !== "legacy_shared") {
      throw new Error("Operational migrations require OPERATIONAL_ADMIN_MODE=legacy_shared.");
    }
    const databaseUrl = process.env.MYSQL_URL;
    if (!databaseUrl) throw new Error("MYSQL_URL must be set to run migrations");
    let pool;
    try {
      const { createMysqlConnection } = await import("./client.js");
      pool = createMysqlConnection(databaseUrl);
      console.log(JSON.stringify(await applyMigrations(pool), null, 2));
    } catch (error) {
      if (error && error.code === "ER_BAD_DB_ERROR") {
        await ensureDatabaseExists(databaseUrl);
        if (pool) await pool.end();
        const { createMysqlConnection } = await import("./client.js");
        pool = createMysqlConnection(databaseUrl);
        console.log(JSON.stringify(await applyMigrations(pool), null, 2));
      } else {
        throw error;
      }
    } finally {
      if (pool) await pool.end();
    }
  })().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
