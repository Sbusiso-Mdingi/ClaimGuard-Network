import crypto from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { MigrationChecksumMismatchError, MigrationExecutionError } from "./errors.js";

export const migrationsDirectory = fileURLToPath(new URL("../migrations/", import.meta.url));
const MIGRATION_LOCK_NAME = "claimguard_control_plane_migrations";

const migrationHistorySql = `
  CREATE TABLE IF NOT EXISTS control_plane_migration_history (
    migration_id VARCHAR(255) PRIMARY KEY,
    checksum CHAR(64) NOT NULL,
    applied_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    execution_duration_ms INT UNSIGNED NOT NULL,
    application_version VARCHAR(128) NULL
  )
`;

export function splitSqlStatements(sql) {
  return sql
    .split(/;\s*(?:\r?\n|$)/)
    .map((statement) => statement.trim())
    .filter(Boolean);
}

export function migrationChecksum(sql) {
  return crypto.createHash("sha256").update(sql.replace(/\r\n/g, "\n")).digest("hex");
}

export async function loadControlPlaneMigrations(directory = migrationsDirectory) {
  const fileNames = (await readdir(directory))
    .filter((fileName) => /^\d{4}_[a-z0-9_]+\.sql$/.test(fileName))
    .sort();
  const migrations = [];
  for (const fileName of fileNames) {
    const filePath = path.join(directory, fileName);
    const sql = await readFile(filePath, "utf8");
    migrations.push({
      id: fileName.replace(/\.sql$/, ""),
      fileName,
      filePath,
      sql,
      checksum: migrationChecksum(sql),
      statements: splitSqlStatements(sql),
    });
  }
  return migrations;
}

async function withConnection(pool, operation) {
  if (typeof pool?.getConnection !== "function") {
    throw new TypeError("A mysql2 pool with getConnection support is required.");
  }
  const connection = await pool.getConnection();
  try {
    return await operation(connection);
  } finally {
    connection.release();
  }
}

async function acquireMigrationLock(connection) {
  const [rows] = await connection.query("SELECT GET_LOCK(?, 30) AS acquired", [MIGRATION_LOCK_NAME]);
  if (Number(rows?.[0]?.acquired) !== 1) {
    throw new Error("Could not acquire the control-plane migration lock.");
  }
}

async function releaseMigrationLock(connection) {
  await connection.query("SELECT RELEASE_LOCK(?) AS released", [MIGRATION_LOCK_NAME]).catch(() => undefined);
}

export async function getControlPlaneMigrationStatus(pool, { directory = migrationsDirectory } = {}) {
  const migrations = await loadControlPlaneMigrations(directory);
  return withConnection(pool, async (connection) => {
    await connection.query(migrationHistorySql);
    const [rows] = await connection.query(
      "SELECT migration_id, checksum, applied_at, execution_duration_ms, application_version FROM control_plane_migration_history ORDER BY migration_id",
    );
    const appliedById = new Map((rows || []).map((row) => [row.migration_id, row]));
    for (const migration of migrations) {
      const applied = appliedById.get(migration.id);
      if (applied && applied.checksum !== migration.checksum) {
        throw new MigrationChecksumMismatchError(migration.id);
      }
    }
    return {
      applied: (rows || []).map((row) => ({
        id: row.migration_id,
        checksum: row.checksum,
        appliedAt: row.applied_at,
        executionDurationMs: Number(row.execution_duration_ms),
        applicationVersion: row.application_version || null,
      })),
      pending: migrations.filter((migration) => !appliedById.has(migration.id)).map(({ id, checksum, statements }) => ({
        id,
        checksum,
        statementCount: statements.length,
      })),
    };
  });
}

export async function applyControlPlaneMigrations(pool, {
  directory = migrationsDirectory,
  applicationVersion = process.env.CLAIMGUARD_APP_VERSION || null,
} = {}) {
  const migrations = await loadControlPlaneMigrations(directory);
  return withConnection(pool, async (connection) => {
    await acquireMigrationLock(connection);
    try {
      await connection.query(migrationHistorySql);
      const [historyRows] = await connection.query(
        "SELECT migration_id, checksum FROM control_plane_migration_history ORDER BY migration_id",
      );
      const appliedById = new Map((historyRows || []).map((row) => [row.migration_id, row]));
      const applied = [];
      const skipped = [];

      for (const migration of migrations) {
        const existing = appliedById.get(migration.id);
        if (existing) {
          if (existing.checksum !== migration.checksum) throw new MigrationChecksumMismatchError(migration.id);
          skipped.push(migration.id);
          continue;
        }

        const startedAt = Date.now();
        if (typeof connection.beginTransaction === "function") await connection.beginTransaction();
        try {
          for (let index = 0; index < migration.statements.length; index += 1) {
            try {
              await connection.query(migration.statements[index]);
            } catch (error) {
              throw new MigrationExecutionError(migration.id, index + 1, error);
            }
          }
          const durationMs = Math.max(0, Date.now() - startedAt);
          await connection.query(
            `INSERT INTO control_plane_migration_history
              (migration_id, checksum, execution_duration_ms, application_version)
             VALUES (?, ?, ?, ?)`,
            [migration.id, migration.checksum, durationMs, applicationVersion],
          );
          if (typeof connection.commit === "function") await connection.commit();
          applied.push({ id: migration.id, checksum: migration.checksum, executionDurationMs: durationMs });
        } catch (error) {
          if (typeof connection.rollback === "function") await connection.rollback();
          throw error;
        }
      }

      return {
        applied,
        skipped,
        pending: [],
        warning: "MySQL DDL can implicitly commit; a failed migration is visible because its history row is not recorded.",
      };
    } finally {
      await releaseMigrationLock(connection);
    }
  });
}
