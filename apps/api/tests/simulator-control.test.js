import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { createBackendApp } from "../src/backend.js";

function status(overrides = {}) {
  return {
    id: "global-healthcare-demo",
    scopeKey: "global:healthcare-demo",
    scopeType: "global",
    tenantId: null,
    mode: "live",
    status: "stopped",
    storyKey: null,
    seed: 42,
    tickIntervalMs: 8000,
    simulatedAt: null,
    tickNumber: 0,
    checkpointVersion: 1,
    updatedAt: "2026-07-16T00:00:00.000Z",
    lastSuccessfulTickAt: null,
    lastError: null,
    lease: null,
    ...overrides,
  };
}

function repository() {
  let current = status();
  return {
    commands: [],
    async getStatus() { return current; },
    async command(command) {
      this.commands.push(command);
      if (command.action === "start") current = { ...current, status: "starting" };
      if (command.action === "pause") {
        if (current.status === "stopped") {
          const error = new Error("Only a running simulation can pause.");
          error.status = 409;
          error.code = "SIMULATION_LIFECYCLE_CONFLICT";
          throw error;
        }
        current = { ...current, status: "pausing" };
      }
      if (command.action === "resume") current = { ...current, status: "starting" };
      if (command.action === "stop") current = { ...current, status: "stopped" };
      if (command.action === "mode") current = { ...current, mode: command.mode };
      return current;
    },
  };
}

const analystHeaders = {
  "x-claimguard-user": "analyst-alpha",
  "x-claimguard-role": "fraud_analyst",
  "x-claimguard-user-tenant": "tenant_alpha",
  "x-claimguard-tenant": "tenant_alpha",
};
const adminHeaders = {
  "x-claimguard-user": "platform-admin",
  "x-claimguard-role": "platform_administrator",
  "x-claimguard-user-tenant": "tenant_default",
  "x-claimguard-tenant": "tenant_default",
};

test("status is readable but simulator mutations require platform control permission", async () => {
  const stateRepository = repository();
  const app = createBackendApp({ simulationStateRepository: stateRepository });
  const read = await app.request("http://localhost/simulator/status", { headers: analystHeaders });
  assert.equal(read.status, 200);
  assert.equal((await read.json()).simulator.status, "stopped");
  const denied = await app.request("http://localhost/simulator/start", { method: "POST", headers: analystHeaders });
  assert.equal(denied.status, 403);
  assert.equal(stateRepository.commands.length, 0);
});

test("start and repeated start are idempotent desired-state commands and never execute a tick", async () => {
  const stateRepository = repository();
  const app = createBackendApp({ simulationStateRepository: stateRepository });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const response = await app.request("http://localhost/simulator/start", { method: "POST", headers: adminHeaders });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).simulator.status, "starting");
  }
  assert.equal(stateRepository.commands.length, 2);
  assert.equal(Object.hasOwn(stateRepository, "runTick"), false);
});

test("invalid lifecycle transition returns typed 409 and mode is separate from status", async () => {
  const stateRepository = repository();
  const app = createBackendApp({ simulationStateRepository: stateRepository });
  const invalid = await app.request("http://localhost/simulator/pause", { method: "POST", headers: adminHeaders });
  assert.equal(invalid.status, 409);
  assert.equal((await invalid.json()).code, "SIMULATION_LIFECYCLE_CONFLICT");
  const mode = await app.request("http://localhost/simulator/mode", {
    method: "POST",
    headers: { ...adminHeaders, "content-type": "application/json" },
    body: JSON.stringify({ mode: "story", storyKey: "identity_theft" }),
  });
  const payload = await mode.json();
  assert.equal(payload.simulator.mode, "story");
  assert.equal(payload.simulator.status, "stopped");
});

test("constructing multiple API apps creates no simulator activity", () => {
  const stateRepository = repository();
  createBackendApp({ simulationStateRepository: stateRepository });
  createBackendApp({ simulationStateRepository: stateRepository });
  assert.equal(stateRepository.commands.length, 0);
});

test("API server startup contains control-state wiring but no simulator scheduler", async () => {
  const source = await readFile(new URL("../src/backend-server.js", import.meta.url), "utf8");
  assert.equal(source.includes("createLiveDemoSimulator"), false);
  assert.equal(source.includes("liveDemoSimulator.start"), false);
  assert.equal(source.includes("setInterval"), false);
  assert.equal(source.includes("createSimulationStateRepository"), true);
});
