import { ControlPlaneConfigurationError } from "./errors.js";

export function isControlPlaneShadowEnabled(env = process.env) {
  return String(env.CONTROL_PLANE_SHADOW_ENABLED || "false").trim().toLowerCase() === "true";
}

export function requireControlPlaneDatabaseUrl(env = process.env) {
  const value = env.CONTROL_PLANE_MYSQL_URL?.trim();
  if (!value) {
    throw new ControlPlaneConfigurationError(
      "CONTROL_PLANE_MYSQL_URL is required for control-plane commands and is never inferred from MYSQL_URL.",
    );
  }
  return value;
}

export function requireOperationalDatabaseUrl(env = process.env) {
  const value = env.MYSQL_URL?.trim();
  if (!value) {
    throw new ControlPlaneConfigurationError("MYSQL_URL is required only as the read-only legacy inventory source.");
  }
  return value;
}

export function assertDistinctDatabaseUrls(controlPlaneUrl, operationalUrl) {
  const control = new URL(controlPlaneUrl);
  const operational = new URL(operationalUrl);
  const controlDatabase = control.pathname.replace(/^\//, "");
  const operationalDatabase = operational.pathname.replace(/^\//, "");

  if (
    control.hostname === operational.hostname &&
    Number(control.port || 3306) === Number(operational.port || 3306) &&
    controlDatabase === operationalDatabase
  ) {
    throw new ControlPlaneConfigurationError(
      "CONTROL_PLANE_MYSQL_URL must identify a database distinct from the operational MYSQL_URL database.",
    );
  }
}
