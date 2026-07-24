import { promoteCompatiblePrivateRoutes } from "./route-promotion.js";
import { runProvisioningBatch } from "./worker.js";

function positiveInteger(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

async function runBatch(maxOperations) {
  const result = await runProvisioningBatch({ maxOperations });
  const routePromotion = await promoteCompatiblePrivateRoutes();
  return { ...result, routePromotion };
}

async function main() {
  const command = process.argv[2] || "run-once";
  const maxOperations = positiveInteger(process.env.PROVISIONING_MAX_OPERATIONS || "1", 1);

  if (!["run-once", "drain"].includes(command)) {
    throw new Error("Command must be run-once or drain.");
  }

  if (command === "run-once") {
    const result = await runBatch(maxOperations);
    console.log(JSON.stringify({ event: "provisioning_worker_run_once_complete", ...result }));
    return;
  }

  for (;;) {
    const result = await runBatch(maxOperations);
    console.log(JSON.stringify({ event: "provisioning_worker_drain_iteration", ...result }));
    if (!result.processed) break;
  }
}

main().catch((error) => {
  console.error(JSON.stringify({
    timestamp: new Date().toISOString(),
    level: "error",
    service: "provisioning-worker",
    event: "provisioning_worker_command_failed",
    failureType: error?.name || "Error",
    failureCode: error?.code || "UNCLASSIFIED",
  }));
  process.exitCode = 1;
});
