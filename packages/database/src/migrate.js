import { fileURLToPath } from "node:url";

import {
  applyMigrations as applyCoreMigrations,
  defaultMigrationPath as coreDefaultMigrationPath,
  defaultMigrationPaths as coreDefaultMigrationPaths,
  getOperationalMigrationStatus as getCoreOperationalMigrationStatus,
} from "./migrate-core.js";

export * from "./migrate-core.js";

export const defaultMigrationPath =
  coreDefaultMigrationPath;

export const defaultMigrationPaths = Object.freeze([
  ...coreDefaultMigrationPaths,
  fileURLToPath(
    new URL(
      "../migrations/0016_domain_safety_foundation.sql",
      import.meta.url,
    ),
  ),
  fileURLToPath(
    new URL(
      "../migrations/0017_case_state_machine.sql",
      import.meta.url,
    ),
  ),
]);

export async function getOperationalMigrationStatus(
  pool,
  {
    migrationPath = defaultMigrationPaths,
  } = {},
) {
  return getCoreOperationalMigrationStatus(
    pool,
    { migrationPath },
  );
}

export async function applyMigrations(
  pool,
  migrationPath = defaultMigrationPaths,
  options = {},
) {
  return applyCoreMigrations(
    pool,
    migrationPath,
    options,
  );
}
