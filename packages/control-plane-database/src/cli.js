import { fileURLToPath } from "node:url";

import mysql from "mysql2/promise";

import { createControlPlanePool } from "./client.js";
import {
  assertDistinctDatabaseUrls,
  isControlPlaneShadowEnabled,
  requireControlPlaneDatabaseUrl,
  requireOperationalDatabaseUrl,
} from "./config.js";
import { createControlPlaneService } from "./control-plane-service.js";
import { provisionDemoAccounts } from "./demo-provisioning.js";
import { getShadowDiagnostics } from "./diagnostics.js";
import {
  applyUnambiguousLegacyMappings,
  compareLegacyTenantInventory,
  readLegacyTenantInventory,
} from "./legacy-inventory.js";
import { applyControlPlaneMigrations, getControlPlaneMigrationStatus } from "./migrate.js";
import { createControlPlaneRepositories } from "./repositories.js";

function parseArguments(argv) {
  const values = new Map();
  const flags = new Set();
  for (const argument of argv) {
    if (!argument.startsWith("--")) continue;
    const [key, value] = argument.slice(2).split("=", 2);
    if (value === undefined) flags.add(key);
    else values.set(key, value);
  }
  return { flags, values };
}

function json(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

async function runInventory({ flags, values }) {
  const controlUrl = requireControlPlaneDatabaseUrl();
  const operationalUrl = requireOperationalDatabaseUrl();
  assertDistinctDatabaseUrls(controlUrl, operationalUrl);
  const apply = flags.has("apply");
  if (apply && !isControlPlaneShadowEnabled()) {
    throw new Error("CONTROL_PLANE_SHADOW_ENABLED=true is required for inventory --apply.");
  }
  if (apply && !values.get("deployment-class")) {
    throw new Error("inventory --apply requires --deployment-class=local|demo|pilot|production.");
  }

  const controlPool = createControlPlanePool(controlUrl);
  const operationalPool = mysql.createPool((await import("./client.js")).buildControlPlaneConnectionOptions(operationalUrl));
  try {
    const repositories = createControlPlaneRepositories(controlPool);
    const [tenants, organisations, mappings] = await Promise.all([
      readLegacyTenantInventory(operationalPool),
      repositories.organisations.list(),
      repositories.legacyMappings.list(),
    ]);
    const report = compareLegacyTenantInventory({ tenants, organisations, mappings });
    if (!apply) {
      json({ mode: "dry-run", operationalRowsModified: 0, report });
      return;
    }
    const service = createControlPlaneService({ pool: controlPool, repositories });
    const results = await applyUnambiguousLegacyMappings({
      report,
      deploymentClass: values.get("deployment-class"),
      service,
      repositories,
    });
    json({ mode: "apply-shadow", operationalRowsModified: 0, results });
  } finally {
    await Promise.all([controlPool.end(), operationalPool.end()]);
  }
}

async function runDemoProvisioning({ values }) {
  if (String(process.env.DEPLOYMENT_CLASS || "").toLowerCase() !== "demo") {
    throw new Error("Demo provisioning requires DEPLOYMENT_CLASS=demo.");
  }
  if (values.get("confirm") !== "PROVISION_DEMO_ACCOUNTS") {
    throw new Error("Demo provisioning requires --confirm=PROVISION_DEMO_ACCOUNTS.");
  }
  const controlUrl = requireControlPlaneDatabaseUrl();
  const operationalUrl = requireOperationalDatabaseUrl();
  assertDistinctDatabaseUrls(controlUrl, operationalUrl);
  const controlPool = createControlPlanePool(controlUrl);
  const operationalPool = mysql.createPool((await import("./client.js")).buildControlPlaneConnectionOptions(operationalUrl));
  try {
    const repositories = createControlPlaneRepositories(controlPool);
    const service = createControlPlaneService({ pool: controlPool, repositories });
    const tenants = await readLegacyTenantInventory(operationalPool);
    const result = await provisionDemoAccounts({
      tenants, repositories, service, executor: controlPool,
      operationalDatabaseName: new URL(operationalUrl).pathname.replace(/^\//, ""),
    });
    json({
      warning: "These generated demo passwords are shown once. Store them only in the approved deployment secret mechanism.",
      ...result,
    });
  } finally {
    await Promise.all([controlPool.end(), operationalPool.end()]);
  }
}

export async function runControlPlaneCli(argv = process.argv.slice(2)) {
  const command = argv[0];
  const args = parseArguments(argv.slice(1));
  if (command === "inventory") return runInventory(args);
  if (command === "provision-demo") return runDemoProvisioning(args);

  const pool = createControlPlanePool(requireControlPlaneDatabaseUrl());
  try {
    if (command === "migrate") json(await applyControlPlaneMigrations(pool));
    else if (command === "status") json(await getControlPlaneMigrationStatus(pool));
    else if (command === "diagnose") json(await getShadowDiagnostics(pool));
    else throw new Error("Command must be one of: migrate, status, diagnose, inventory, provision-demo.");
  } finally {
    await pool.end();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  runControlPlaneCli().catch((error) => {
    process.stderr.write(`${JSON.stringify({ error: error.code || error.name || "Error", message: error.message })}\n`);
    process.exitCode = 1;
  });
}
