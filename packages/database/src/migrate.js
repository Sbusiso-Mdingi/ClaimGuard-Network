import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { buildConnectionOptions } from "./client.js";

export const defaultMigrationPath = fileURLToPath(new URL("../migrations/0001_initial.sql", import.meta.url));

function splitSqlStatements(sql) {
  return sql
    .split(/;\s*(?:\r?\n|$)/)
    .map((statement) => statement.trim())
    .filter(Boolean);
}

export async function applyMigrations(pool, migrationPath = defaultMigrationPath) {
  const sql = await readFile(migrationPath, "utf8");
  const statements = splitSqlStatements(sql);

  for (const statement of statements) {
    await pool.query(statement);
  }

  return { appliedStatements: statements.length, migrationPath };
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
  const databaseUrl = process.env.MYSQL_URL;
  if (!databaseUrl) {
    throw new Error("MYSQL_URL must be set to run migrations");
  }

  const { createMysqlConnection } = await import("./client.js");
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
}