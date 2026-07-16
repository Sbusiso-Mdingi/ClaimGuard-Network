import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { buildConnectionOptions, createMysqlConnection } from "./client.js";

export const defaultMigrationPath = fileURLToPath(new URL("../migrations/0001_initial.sql", import.meta.url));
export const defaultMigrationPaths = Object.freeze([
  defaultMigrationPath,
  fileURLToPath(new URL("../migrations/0002_investigations.sql", import.meta.url)),
  fileURLToPath(new URL("../migrations/0003_shared_fraud_registry.sql", import.meta.url)),
  fileURLToPath(new URL("../migrations/0004_claim_processing_outbox.sql", import.meta.url)),
  fileURLToPath(new URL("../migrations/0005_atomic_fraud_workflows.sql", import.meta.url)),
]);

function splitSqlStatements(sql) {
  return sql
    .split(/;\s*(?:\r?\n|$)/)
    .map((statement) => statement.trim())
    .filter(Boolean);
}

export async function applyMigrations(pool, migrationPath = defaultMigrationPaths) {
  const migrationPaths = Array.isArray(migrationPath) ? migrationPath : [migrationPath];
  let appliedStatements = 0;

  for (const currentMigrationPath of migrationPaths) {
    const sql = await readFile(currentMigrationPath, "utf8");
    const statements = splitSqlStatements(sql);

    for (const statement of statements) {
      try {
        await pool.query(statement);
      } catch (error) {
        if (
          error.code === "ER_DUP_FIELDNAME" ||
          error.code === "ER_DUP_KEY" ||
          error.code === "ER_DUP_KEYNAME" ||
          error.code === "ER_FK_DUP_NAME" ||
          error.code === "ER_TABLE_EXISTS_ERROR"
        ) {
          // Ignore idempotency errors for raw SQL migrations
          continue;
        }
        throw error;
      }
    }

    appliedStatements += statements.length;
  }

  return {
    appliedStatements,
    migrationPath: migrationPaths.length === 1 ? migrationPaths[0] : null,
    migrationPaths,
  };
}

async function ensureDatabaseExists(databaseUrl) {
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
    const databaseUrl = process.env.MYSQL_URL;
    if (!databaseUrl) {
      throw new Error("MYSQL_URL must be set to run migrations");
    }

    let pool;

    try {
      pool = createMysqlConnection(databaseUrl);
      const result = await applyMigrations(pool);
      console.log(`Applied ${result.appliedStatements} migration statements from ${result.migrationPath}`);
    } catch (error) {
      if (error && error.code === "ER_BAD_DB_ERROR") {
        await ensureDatabaseExists(databaseUrl);
        if (pool) {
          await pool.end();
        }

        pool = createMysqlConnection(databaseUrl);
        const result = await applyMigrations(pool);
        console.log(`Applied ${result.appliedStatements} migration statements from ${result.migrationPath}`);
      } else {
        throw error;
      }
    } finally {
      if (pool) {
        await pool.end();
      }
    }
  })().catch(err => {
    console.error(err);
    process.exit(1);
  });
}
