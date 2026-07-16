import { createDatabase, createSimulationStateRepository } from "@claimguard/database";
import {
  createLiveDemoBootstrapFromDatabase,
  createLiveDemoSimulator,
} from "../../api/src/simulation/live-demo-simulator.js";
import { createSimulatorWorker, simulatorWorkerConfigFromEnvironment } from "./worker.js";

function requireEnvironment(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

async function main() {
  const command = process.argv[2] || "tick";
  const database = createDatabase(requireEnvironment("MYSQL_URL"));
  const repository = createSimulationStateRepository(database.pool);
  const config = simulatorWorkerConfigFromEnvironment(process.env);
  const apiBaseUrl = requireEnvironment("SIMULATOR_API_BASE_URL").replace(/\/$/, "");

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
        const configuredTenantIds = String(process.env.SIMULATOR_TENANTS || "").split(",").map((value) => value.trim()).filter(Boolean);
        const bootstrap = createLiveDemoBootstrapFromDatabase({
          pool: database.pool,
          configuredTenantIds,
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
          apiClient: {
            async request({ path, method = "GET", headers = {}, body = null }) {
              await assertMutationAllowed();
              const remaining = Math.max(1, deadline - Date.now());
              const response = await fetch(`${apiBaseUrl}${path}`, {
                method,
                headers: { ...headers, "content-type": "application/json", "x-request-id": `${instance.id}:tick:${instance.tickNumber + 1}` },
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
    await database.pool.end();
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
