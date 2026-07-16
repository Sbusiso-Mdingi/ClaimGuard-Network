import { drizzle } from "drizzle-orm/mysql2";
import mysql from "mysql2/promise";

import { ledgerEntriesTable } from "./index.js";

export function buildConnectionOptions(databaseUrl, options = {}) {
  const parsedUrl = new URL(databaseUrl);
  const connectionOptions = {
    host: parsedUrl.hostname,
    port: Number(parsedUrl.port || 3306),
    user: decodeURIComponent(parsedUrl.username),
    password: decodeURIComponent(parsedUrl.password),
  };

  if (options.includeDatabase !== false) {
    connectionOptions.database = parsedUrl.pathname.replace(/^\//, "");
  }

  const sslMode = parsedUrl.searchParams.get("ssl-mode");
  const ssl = parsedUrl.searchParams.get("ssl");

  if (
    parsedUrl.hostname.endsWith(".mysql.database.azure.com") ||
    sslMode === "require" ||
    ssl === "require" ||
    ssl === "true"
  ) {
    connectionOptions.ssl = {
      rejectUnauthorized: true,
    };
  }

  return connectionOptions;
}

export function createMysqlConnection(databaseUrl) {
  if (typeof databaseUrl !== "string" || !databaseUrl.trim()) {
    throw new Error("databaseUrl must be provided");
  }

  return mysql.createPool(buildConnectionOptions(databaseUrl.trim()));
}

export function createDatabase(databaseUrl, options = {}) {
  const pool = createMysqlConnection(databaseUrl);
  const mode = options.mode || "default";

  return {
    pool,
    db: createDatabaseFromPool(pool, { mode }),
  };
}

export function createDatabaseFromPool(pool, { mode = "default" } = {}) {
  if (!pool) throw new TypeError("A verified operational pool is required.");
  return drizzle(pool, { mode, schema: { ledgerEntriesTable } });
}
