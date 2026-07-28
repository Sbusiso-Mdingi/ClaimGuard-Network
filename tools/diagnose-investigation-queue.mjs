#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import { createRequire } from "node:module";

import {
  createControlPlanePool,
  createControlPlaneRepositories,
} from "../packages/control-plane-database/src/index.js";
import {
  createLegacySharedAdapter,
  createOperationalRepositories,
  createTenantConnectionManager,
} from "../packages/database/src/index.js";
import {
  createControlPlaneDataPlaneRouteResolver,
} from "../apps/api/src/data-plane-route-resolver.js";
import {
  createPrivateDatabaseAdapter,
} from "../apps/api/src/private-database-adapter.js";

const requireFromApi = createRequire(
  new URL("../apps/api/package.json", import.meta.url),
);
const { AzureCliCredential } = requireFromApi("@azure/identity");

const DEFAULTS = Object.freeze({
  resourceGroup: "ClaimGuard",
  vault: "claimguard-kv-ufs",
  controlPlaneSecret: "claimguard--api--control-plane-mysql-url",
  legacyOperationalSecret: "claimguard--api--mysql-url",
  schemaVersion: "14",
});

function fail(message) {
  throw new Error(message);
}

function parseOptions(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!flag?.startsWith("--") || value === undefined) {
      fail(`Invalid option sequence beginning at ${JSON.stringify(flag)}.`);
    }
    const name = flag.slice(2);
    if (options[name] !== undefined) fail(`Option ${flag} was supplied more than once.`);
    options[name] = value;
  }

  const allowed = new Set([
    "organisation-id",
    "expected-slug",
    "resource-group",
    "vault",
    "control-plane-secret",
    "legacy-operational-secret",
    "schema-version",
  ]);
  for (const name of Object.keys(options)) {
    if (!allowed.has(name)) fail(`Unsupported option --${name}.`);
  }

  const organisationId = options["organisation-id"];
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(organisationId || "")) {
    fail("--organisation-id must be a UUID.");
  }
  const expectedSlug = options["expected-slug"] || null;
  if (expectedSlug && !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(expectedSlug)) {
    fail("--expected-slug must be a canonical lowercase slug.");
  }

  return Object.freeze({
    organisationId,
    expectedSlug,
    resourceGroup: options["resource-group"] || DEFAULTS.resourceGroup,
    vault: options.vault || DEFAULTS.vault,
    controlPlaneSecret: options["control-plane-secret"] || DEFAULTS.controlPlaneSecret,
    legacyOperationalSecret: options["legacy-operational-secret"] || DEFAULTS.legacyOperationalSecret,
    schemaVersion: options["schema-version"] || DEFAULTS.schemaVersion,
  });
}

function az(args) {
  return execFileSync("az", [...args, "--only-show-errors"], {
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function secretValue(vault, name) {
  const value = az([
    "keyvault",
    "secret",
    "show",
    "--vault-name",
    vault,
    "--name",
    name,
    "--query",
    "value",
    "--output",
    "tsv",
  ]);
  if (!value) fail(`Key Vault secret ${name} is empty.`);
  return value;
}

async function main() {
  const options = parseOptions(process.argv.slice(2));
  const correlationId = crypto.randomUUID();
  const controlPlanePool = createControlPlanePool(
    secretValue(options.vault, options.controlPlaneSecret),
  );
  const controlPlaneRepositories = createControlPlaneRepositories(controlPlanePool);
  let connectionManager = null;
  let acquired = null;

  try {
    const organisation = await controlPlaneRepositories.organisations.getById(
      options.organisationId,
    );
    if (!organisation) fail("The requested organisation does not exist.");
    if (options.expectedSlug && organisation.canonicalSlug !== options.expectedSlug) {
      fail(
        `Organisation slug mismatch: expected ${options.expectedSlug}, `
        + `received ${organisation.canonicalSlug}.`,
      );
    }

    const routeResolver = createControlPlaneDataPlaneRouteResolver({
      repositories: controlPlaneRepositories,
      supportedSchemaVersions: [options.schemaVersion],
    });
    const context = await routeResolver.resolve({
      organisationId: options.organisationId,
      actorId: "investigation-queue-diagnostic",
      correlationId,
    });
    if (context.operationalTenantId !== options.organisationId) {
      fail(
        `Operational tenant mismatch: expected ${options.organisationId}, `
        + `received ${context.operationalTenantId}.`,
      );
    }

    connectionManager = createTenantConnectionManager({
      adapters: {
        legacy_shared: createLegacySharedAdapter({
          databaseUrl: secretValue(options.vault, options.legacyOperationalSecret),
          expectedEnvironment: "legacy",
          supportedSchemaVersions: [options.schemaVersion],
        }),
        private_database: createPrivateDatabaseAdapter({
          expectedEnvironment: "production",
          supportedSchemaVersions: [options.schemaVersion],
          credential: new AzureCliCredential(),
        }),
      },
      maxPools: 1,
      creationTimeoutMs: 30_000,
    });
    acquired = await connectionManager.acquire(context);
    const repositories = createOperationalRepositories(context, acquired.pool);
    const queue = await repositories.investigations.listInvestigations({
      page: 1,
      pageSize: 25,
      assignment: "all",
      actorId: "investigation-queue-diagnostic",
    });

    process.stdout.write(`${JSON.stringify({
      status: "INVESTIGATION_QUEUE_DIAGNOSTIC_PASSED",
      correlationId,
      organisation: {
        organisationId: organisation.organisationId,
        canonicalSlug: organisation.canonicalSlug,
        status: organisation.status,
        activationState: organisation.activationState,
      },
      route: {
        routeId: context.routeId,
        routeType: context.routeType,
        routeGeneration: context.routeGeneration,
        operationalTenantId: context.operationalTenantId,
        operationalTenantSlug: context.operationalTenantSlug,
        schemaVersion: context.schemaVersion,
        logicalDatabaseIdentifier: context.logicalDatabaseIdentifier,
      },
      databaseMetadata: acquired.metadata,
      queue: {
        rowCount: queue.investigations.length,
        pagination: queue.pagination,
        filters: queue.filters,
      },
    }, null, 2)}\n`);
  } finally {
    await acquired?.release();
    if (connectionManager) {
      await connectionManager.retireOrganisation(
        options.organisationId,
        "diagnostic_complete",
      );
    }
    await controlPlanePool.end();
  }
}

main().catch((error) => {
  process.stderr.write(`${JSON.stringify({
    status: "INVESTIGATION_QUEUE_DIAGNOSTIC_FAILED",
    error: {
      name: error?.name || "Error",
      code: error?.code || null,
      errno: error?.errno || null,
      message: error?.message || "Unknown error",
      sqlState: error?.sqlState || null,
      sqlMessage: error?.sqlMessage || null,
    },
  }, null, 2)}\n`);
  process.exitCode = 1;
});
