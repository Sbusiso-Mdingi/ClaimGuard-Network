import {
  createLegacySharedAdapter,
  createOperationalRepositories,
  createTenantConnectionManager,
} from "@claimguard/database";
import { createControlPlanePool, createControlPlaneRepositories } from "@claimguard/control-plane-database";
import {
  createLiveDemoBootstrapFromDatabase,
  createLiveDemoSimulator,
} from "../../api/src/simulation/live-demo-simulator.js";
import { createControlPlaneDataPlaneRouteResolver } from "../../api/src/data-plane-route-resolver.js";
import { createSimulatorWorker, simulatorWorkerConfigFromEnvironment } from "./worker.js";

function requireEnvironment(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

async function main() {
  const command = process.argv[2] || "tick";
  const controlPool = createControlPlanePool(requireEnvironment("CONTROL_PLANE_MYSQL_URL"));
  const controlRepositories = createControlPlaneRepositories(controlPool);
  const routeResolver = createControlPlaneDataPlaneRouteResolver({ repositories: controlRepositories });
  const stateOrganisationId = requireEnvironment("SIMULATOR_STATE_ORGANISATION_ID");
  const dataPlaneContext = await routeResolver.resolve({
    organisationId: stateOrganisationId,
    serviceIdentityId: "simulator-worker",
    correlationId: `${command}:${Date.now()}`,
  });
  const connectionManager = createTenantConnectionManager({
    adapters: { legacy_shared: createLegacySharedAdapter({
      databaseUrl: requireEnvironment("MYSQL_URL"),
      expectedEnvironment: process.env.DATA_PLANE_ENVIRONMENT || "legacy",
      connectionLimit: Number(process.env.DATA_PLANE_POOL_CONNECTION_LIMIT || 5),
    }) },
    maxPools: Number(process.env.DATA_PLANE_MAX_POOLS || 8),
    logger(level, event, details) {
      console.log(JSON.stringify({ timestamp: new Date().toISOString(), level, service: "simulator-worker", event, ...details }));
    },
  });
  const dataPlaneLease = await connectionManager.acquire(dataPlaneContext);
  const repository = createOperationalRepositories(dataPlaneContext, dataPlaneLease.pool).simulatorState;
  const config = simulatorWorkerConfigFromEnvironment(process.env);
  const apiBaseUrl = requireEnvironment("SIMULATOR_API_BASE_URL").replace(/\/$/, "");
  const authorityMode = String(process.env.AUTHENTICATION_MODE || "session").toLowerCase();
  const organisationScope = { [dataPlaneContext.operationalTenantId]: stateOrganisationId };

  try {
    if (command === "status") {
      console.log(JSON.stringify(await repository.getStatus(config.instanceId), null, 2));
      return;
    }

    const worker = createSimulatorWorker({
      repository,
      config,
      readiness: async () => {
        const response = await fetch(`${apiBaseUrl}/ready`, { headers: { accept: "application/json" } });
        return response.ok;
      },
      simulatorFactory: async ({ instance, assertMutationAllowed, deadline, maxClaimsPerTick }) => {
        const requestedTenantIds = String(process.env.SIMULATOR_TENANTS || dataPlaneContext.operationalTenantId).split(",").map((value) => value.trim()).filter(Boolean);
        if (requestedTenantIds.length !== 1 || requestedTenantIds[0] !== dataPlaneContext.operationalTenantId) {
          throw new Error("Simulator tenant scope must equal the verified state organisation tenant.");
        }
        const bootstrap = createLiveDemoBootstrapFromDatabase({
          pool: dataPlaneLease.pool,
          configuredTenantIds: requestedTenantIds,
          seed: instance.seed,
        });
        return createLiveDemoSimulator({
          enabled: true,
          mode: instance.mode,
          staticMode: instance.mode === "static",
          seed: instance.seed,
          tickIntervalMs: instance.tickIntervalMs,
          maxRecentClaims: Number(instance.config?.maxRecentClaims || 500),
          maxActiveInvestigations: config.maxActiveInvestigations,
          storyMode: instance.storyKey || "",
          fraudRate: Number(instance.config?.fraudRate || 0.04),
          initialCheckpoint: instance.checkpoint,
          maxClaimsPerTick,
          bootstrap,
          authorityMode,
          apiClient: {
            async request({ path, method = "GET", headers = {}, body = null }) {
              await assertMutationAllowed();
              const remaining = Math.max(1, deadline - Date.now());
              const response = await fetch(`${apiBaseUrl}${path}`, {
                method,
                headers: {
                  ...headers,
                  ...(authorityMode === "session" && process.env.INTERNAL_SERVICE_TOKEN
                    ? {
                        authorization: `Bearer ${process.env.INTERNAL_SERVICE_TOKEN}`,
                        "x-cg-service-organisation": organisationScope[headers["x-cg-service-tenant"]] || "",
                      }
                    : {}),
                  "content-type": "application/json",
                  "x-request-id": `${instance.id}:tick:${instance.tickNumber + 1}`,
                },
                body: body ? JSON.stringify(body) : undefined,
                signal: AbortSignal.timeout(remaining),
              });
              const json = await response.json().catch(() => null);
              return { status: response.status, json };
            },
          },
        });
      },
    });

    if (command === "tick") await worker.runOneTick();
    else if (command === "drain") await worker.runUntilPaused();
    else if (command === "continuous") await worker.runContinuous();
    else throw new Error("Command must be one of: tick, drain, continuous, status.");
  } finally {
    await dataPlaneLease.release();
    await connectionManager.invalidateOrganisation(stateOrganisationId, "worker_shutdown");
    await controlPool.end();
  }
}

main().catch((error) => {
  console.error(JSON.stringify({
    timestamp: new Date().toISOString(),
    level: "error",
    service: "simulator-worker",
    event: "worker_command_failed",
    failureType: error?.name || "Error",
  }));
  process.exitCode = 1;
});
