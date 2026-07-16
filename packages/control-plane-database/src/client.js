import mysql from "mysql2/promise";

import { ControlPlaneConfigurationError } from "./errors.js";

export function buildControlPlaneConnectionOptions(databaseUrl) {
  if (typeof databaseUrl !== "string" || !databaseUrl.trim()) {
    throw new ControlPlaneConfigurationError("A control-plane database URL is required.");
  }

  const parsed = new URL(databaseUrl.trim());
  if (!parsed.protocol.startsWith("mysql")) {
    throw new ControlPlaneConfigurationError("CONTROL_PLANE_MYSQL_URL must use a MySQL URL scheme.");
  }

  const database = parsed.pathname.replace(/^\//, "");
  if (!database) {
    throw new ControlPlaneConfigurationError("CONTROL_PLANE_MYSQL_URL must include a database name.");
  }

  const options = {
    host: parsed.hostname,
    port: Number(parsed.port || 3306),
    user: decodeURIComponent(parsed.username),
    password: decodeURIComponent(parsed.password),
    database,
    connectionLimit: 5,
    namedPlaceholders: false,
  };

  const sslRequired = parsed.hostname.endsWith(".mysql.database.azure.com") || ["require", "true"].includes(parsed.searchParams.get("ssl-mode") || parsed.searchParams.get("ssl"));
  if (sslRequired) options.ssl = { rejectUnauthorized: true };
  return options;
}

export function createControlPlanePool(databaseUrl) {
  return mysql.createPool(buildControlPlaneConnectionOptions(databaseUrl));
}
