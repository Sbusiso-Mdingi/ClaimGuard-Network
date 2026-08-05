import crypto from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  OperationalMigrationExecutionError,
  applyMigrations as applyCoreMigrations,
  defaultMigrationPath as coreDefaultMigrationPath,
  defaultMigrationPaths as coreDefaultMigrationPaths,
  getOperationalMigrationStatus as getCoreOperationalMigrationStatus,
} from "./migrate-core.js";
import {
  CANONICAL_OPERATIONAL_MIGRATION_VERSION,
  CANONICAL_OPERATIONAL_SCHEMA_VERSION,
} from "./operational-schema.js";
import { splitOperationalMigrationStatements } from "./mysql-migration-parser.js";

export * from "./migrate-core.js";
export { splitOperationalMigrationStatements } from "./mysql-migration-parser.js";

export const defaultMigrationPath = coreDefaultMigrationPath;

const extensionMigrationPaths = Object.freeze([
  fileURLToPath(new URL("../migrations/0016_domain_safety_foundation.sql", import.meta.url)),
  fileURLToPath(new URL("../migrations/0017_case_state_machine.sql", import.meta.url)),
]);

export const defaultMigrationPaths = Object.freeze([
  ...coreDefaultMigrationPaths,
  ...extensionMigrationPaths,
]);

const MIGRATION_LOCK_NAME = "claimguard_operational_migrations";
const extensionIds = new Set(extensionMigrationPaths.map((value) => path.basename(value, ".sql")));
const adoptionCodes = new Set([
  "ER_CHECK_CONSTRAINT_DUP_NAME",
  "ER_DUP_ENTRY",
  "ER_DUP_FIELDNAME",
  "ER_DUP_KEY",
  "ER_DUP_KEYNAME",
  "ER_FK_DUP_NAME",
  "ER_TABLE_EXISTS_ERROR",
  "ER_TRG_ALREADY_EXISTS",
]);

function checksum(value) {
  return crypto.createHash("sha256").update(String(value).replace(/\r\n/g, "\n")).digest("hex");
}

function canonicalPaths(value) {
  return (Array.isArray(value) ? value : [value]).map((entry) => path.resolve(entry));
}

function partitionPaths(value) {
  const core = [];
  const extension = [];
  for (const filePath of canonicalPaths(value)) {
    (extensionIds.has(path.basename(filePath, path.extname(filePath))) ? extension : core).push(filePath);
  }
  return { core, extension };
}

async function withConnection(pool, operation) {
  const connection = typeof pool?.getConnection === "function" ? await pool.getConnection() : pool;
  if (!connection || typeof connection.query !== "function") {
    throw new TypeError("A MySQL-compatible migration pool is required.");
  }
  try {
    return await operation(connection);
  } finally {
    if (connection !== pool) connection.release();
  }
}

async function loadExtensionMigrations(paths) {
  return Promise.all(paths.map(async (filePath) => {
    const source = await readFile(filePath, "utf8");
    const statements = splitOperationalMigrationStatements(source);
    return {
      id: path.basename(filePath, path.extname(filePath)),
      filePath,
      checksum: checksum(source),
      statements,
      statementChecksums: statements.map(checksum),
    };
  }));
}

async function extensionHistory(connection) {
  const [migrationRows] = await connection.query(
    "SELECT migration_id, checksum FROM operational_migration_history",
  );
  const [statementRows] = await connection.query(
    `SELECT migration_id, statement_index, statement_checksum, adopted
       FROM operational_migration_statement_history`,
  );
  return {
    migrations: new Map((migrationRows || []).map((row) => [row.migration_id, row])),
    statements: new Map((statementRows || []).map((row) => [
      `${row.migration_id}:${Number(row.statement_index)}`,
      row,
    ])),
  };
}

function validateRecordedMigration(migration, recorded) {
  if (recorded && recorded.checksum !== migration.checksum) {
    const error = new Error(`Applied operational migration ${migration.id} no longer matches its checksum.`);
    error.code = "OPERATIONAL_MIGRATION_CHECKSUM_MISMATCH";
    error.migrationId = migration.id;
    throw error;
  }
}

function validateRecordedStatement(migration, index, recorded) {
  if (recorded && recorded.statement_checksum !== migration.statementChecksums[index - 1]) {
    const error = new Error(`Operational migration ${migration.id} statement ${index} checksum changed.`);
    error.code = "OPERATIONAL_MIGRATION_STATEMENT_CHECKSUM_MISMATCH";
    error.migrationId = migration.id;
    error.statementIndex = index;
    throw error;
  }
}

async function verifyCanonicalMetadata(connection) {
  const [rows] = await connection.query(
    `SELECT schema_version, migration_version
       FROM data_plane_metadata
      WHERE metadata_key = 'primary'
      LIMIT 2`,
  );
  if ((rows || []).length !== 1
      || String(rows[0].schema_version) !== CANONICAL_OPERATIONAL_SCHEMA_VERSION
      || Number(rows[0].migration_version) < CANONICAL_OPERATIONAL_MIGRATION_VERSION) {
    const error = new Error("Operational metadata was not advanced monotonically to schema 17.");
    error.code = "OPERATIONAL_MIGRATION_METADATA_MISMATCH";
    throw error;
  }
}

async function applyExtensionMigrations(pool, paths, { applicationVersion = null } = {}) {
  if (paths.length === 0) return { applied: [], skipped: [], appliedStatements: 0, adoptedStatements: 0, resumedStatements: 0 };
  const migrations = await loadExtensionMigrations(paths);
  return withConnection(pool, async (connection) => {
    const [lockRows] = await connection.query("SELECT GET_LOCK(?, 30) AS acquired", [MIGRATION_LOCK_NAME]);
    if (Number(lockRows?.[0]?.acquired) !== 1) throw new Error("Could not acquire the operational migration lock.");
    try {
      const history = await extensionHistory(connection);
      const result = { applied: [], skipped: [], appliedStatements: 0, adoptedStatements: 0, resumedStatements: 0 };
      for (const migration of migrations) {
        const recordedMigration = history.migrations.get(migration.id);
        validateRecordedMigration(migration, recordedMigration);
        if (recordedMigration) {
          result.skipped.push(migration.id);
          continue;
        }
        const startedAt = Date.now();
        let appliedStatements = 0;
        let adoptedStatements = 0;
        let resumedStatements = 0;
        for (let index = 1; index <= migration.statements.length; index += 1) {
          const recorded = history.statements.get(`${migration.id}:${index}`);
          if (recorded) {
            validateRecordedStatement(migration, index, recorded);
            result.resumedStatements += 1;
            resumedStatements += 1;
            continue;
          }
          let adopted = false;
          try {
            await connection.query(migration.statements[index - 1]);
          } catch (cause) {
            if (!adoptionCodes.has(cause?.code)) {
              const error = new OperationalMigrationExecutionError(migration.id, index, cause);
              error.executableStatement = migration.statements[index - 1];
              error.mysqlCode = cause?.code || null;
              error.sqlState = cause?.sqlState || null;
              error.sqlMessage = cause?.sqlMessage || cause?.message || null;
              throw error;
            }
            adopted = true;
          }
          await connection.query(
            `INSERT INTO operational_migration_statement_history
               (migration_id, statement_index, statement_checksum, adopted)
             VALUES (?, ?, ?, ?)`,
            [migration.id, index, migration.statementChecksums[index - 1], adopted ? 1 : 0],
          );
          result.appliedStatements += 1;
          appliedStatements += 1;
          if (adopted) {
            result.adoptedStatements += 1;
            adoptedStatements += 1;
          }
        }
        if (migration.id === "0017_case_state_machine") await verifyCanonicalMetadata(connection);
        await connection.query(
          `INSERT INTO operational_migration_history
             (migration_id, checksum, execution_duration_ms, application_version)
           VALUES (?, ?, ?, ?)`,
          [migration.id, migration.checksum, Math.max(0, Date.now() - startedAt), applicationVersion],
        );
        result.applied.push({
          id: migration.id,
          checksum: migration.checksum,
          statementCount: migration.statements.length,
          appliedStatements,
          adoptedStatements,
          resumedStatements,
        });
      }
      await verifyCanonicalMetadata(connection);
      return result;
    } finally {
      await connection.query("SELECT RELEASE_LOCK(?) AS released", [MIGRATION_LOCK_NAME]).catch(() => undefined);
    }
  });
}

export async function getOperationalMigrationStatus(pool, { migrationPath = defaultMigrationPaths } = {}) {
  const { core, extension } = partitionPaths(migrationPath);
  const coreStatus = await getCoreOperationalMigrationStatus(pool, { migrationPath: core });
  if (extension.length === 0) return coreStatus;
  const migrations = await loadExtensionMigrations(extension);
  return withConnection(pool, async (connection) => {
    const history = await extensionHistory(connection);
    const pending = [];
    for (const migration of migrations) {
      const recordedMigration = history.migrations.get(migration.id);
      validateRecordedMigration(migration, recordedMigration);
      if (!recordedMigration) {
        let completedStatementCount = 0;
        for (let index = 1; index <= migration.statements.length; index += 1) {
          const recorded = history.statements.get(`${migration.id}:${index}`);
          validateRecordedStatement(migration, index, recorded);
          if (recorded) completedStatementCount += 1;
        }
        pending.push({
          id: migration.id,
          checksum: migration.checksum,
          statementCount: migration.statements.length,
          completedStatementCount,
          remainingStatementCount: migration.statements.length - completedStatementCount,
        });
      }
    }
    return {
      applied: [...coreStatus.applied, ...migrations.filter((item) => history.migrations.has(item.id)).map((item) => ({ id: item.id, checksum: item.checksum }))],
      pending: [...coreStatus.pending, ...pending],
      inProgress: [...coreStatus.inProgress, ...pending.filter((item) => item.completedStatementCount > 0)],
    };
  });
}

export async function applyMigrations(pool, migrationPath = defaultMigrationPaths, options = {}) {
  const { core, extension } = partitionPaths(migrationPath);
  const coreResult = core.length > 0
    ? await applyCoreMigrations(pool, core, options)
    : { applied: [], skipped: [], appliedStatements: 0, adoptedStatements: 0, resumedStatements: 0 };
  const extensionResult = await applyExtensionMigrations(pool, extension, options);
  return {
    ...coreResult,
    applied: [...coreResult.applied, ...extensionResult.applied],
    skipped: [...coreResult.skipped, ...extensionResult.skipped],
    appliedStatements: coreResult.appliedStatements + extensionResult.appliedStatements,
    adoptedStatements: coreResult.adoptedStatements + extensionResult.adoptedStatements,
    resumedStatements: coreResult.resumedStatements + extensionResult.resumedStatements,
    migrationPath: null,
    migrationPaths: canonicalPaths(migrationPath),
  };
}
