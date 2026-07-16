import assert from "node:assert/strict";
import test from "node:test";

import { createSimulatorWorker } from "../src/worker.js";

class MemoryRepository {
  constructor({ mode = "live", status = "running", checkpoint = null, pressure = {} } = {}) {
    this.instance = {
      id: "global-healthcare-demo",
      scopeKey: "global:healthcare-demo",
      mode,
      status,
      seed: 42,
      tickIntervalMs: 1,
      tickNumber: checkpoint?.tickNumber || 0,
      checkpoint,
      config: {},
    };
    this.lease = null;
    this.token = 0;
    this.history = [];
    this.pressure = { reportOutboxBacklog: 0, activeInvestigations: 0, ...pressure };
    this.clock = 0;
  }

  async acquireLease({ workerId }) {
    if (this.lease && this.lease.expiresAt <= this.clock) this.lease = null;
    if (!["starting", "running"].includes(this.instance.status) || this.instance.mode === "off" || this.lease) return null;
    this.token += 1;
    this.lease = { leasedBy: workerId, fencingToken: this.token, expiresAt: this.clock + 100 };
    this.instance.status = "running";
    return { instance: structuredClone(this.instance), lease: { ...this.lease } };
  }

  async assertLease({ workerId, fencingToken }) {
    if (this.lease?.leasedBy !== workerId || this.lease?.fencingToken !== fencingToken) {
      const error = new Error("lease lost");
      error.name = "SimulationLeaseLostError";
      throw error;
    }
  }

  async renewLease(args) { await this.assertLease(args); this.lease.expiresAt = this.clock + 100; return true; }
  async releaseLease({ workerId, fencingToken }) {
    if (this.lease?.leasedBy === workerId && this.lease?.fencingToken === fencingToken) {
      this.lease = null;
      return true;
    }
    return false;
  }
  async getBackpressure() { return this.pressure; }
  async recordBackpressure({ reason }) { this.backpressure = reason; }
  async recordTickStarted(entry) { await this.assertLease(entry); this.history.push({ ...entry, status: "running" }); }
  async saveSuccessfulTick({ workerId, fencingToken, checkpoint, correlationId, pauseAfterTick }) {
    await this.assertLease({ workerId, fencingToken });
    if (checkpoint.tickNumber !== this.instance.tickNumber + 1) throw new Error("wrong tick");
    this.instance.tickNumber = checkpoint.tickNumber;
    this.instance.checkpoint = structuredClone(checkpoint);
    this.instance.status = pauseAfterTick || this.instance.status === "pausing" ? "paused" : "running";
    const history = this.history.find((entry) => entry.correlationId === correlationId);
    if (history) history.status = "completed";
    return structuredClone(this.instance);
  }
  async recordTickFailure({ workerId, fencingToken }) {
    await this.assertLease({ workerId, fencingToken });
    this.instance.status = "failed";
    this.lease = null;
  }
  async getStatus() { return structuredClone(this.instance); }
}

function workerFor(repository, simulatorFactory, workerId = "worker-a") {
  return createSimulatorWorker({
    repository,
    simulatorFactory,
    readiness: async () => true,
    config: {
      instanceId: "global-healthcare-demo",
      workerId,
      leaseSeconds: 120,
      pollMs: 1,
      maximumTickDurationMs: 1000,
      maxClaimsPerTick: 3,
      maxOutboxBacklog: 10,
      maxActiveInvestigations: 10,
    },
    logger() {},
    sleep: async () => {},
  });
}

function simulatorFrom(instance, { gate = null, fail = false } = {}) {
  return {
    async start() {},
    stop() {},
    async runTick() {
      if (gate) await gate();
      if (fail) throw new Error("tick failed");
      return { tick: instance.tickNumber + 1, claims: 1, investigations: 0, confirmations: 0, reversals: 0 };
    },
    getCheckpoint() {
      return {
        version: 1,
        tickNumber: instance.tickNumber + 1,
        claimSequence: Number(instance.checkpoint?.claimSequence || 0) + 1,
        randomState: 99,
        simulatedTime: "2026-01-01T12:00:00.000Z",
      };
    },
  };
}

test("only one worker holds the scope lease and slow ticks never overlap", async () => {
  const repository = new MemoryRepository();
  let release;
  const gate = () => new Promise((resolve) => { release = resolve; });
  let active = 0;
  let maximumActive = 0;
  const first = workerFor(repository, async ({ instance }) => {
    const simulator = simulatorFrom(instance, { gate });
    const original = simulator.runTick;
    simulator.runTick = async () => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      try { return await original(); } finally { active -= 1; }
    };
    return simulator;
  }, "worker-a");
  const second = workerFor(repository, async ({ instance }) => simulatorFrom(instance), "worker-b");
  const firstRun = first.runOneTick();
  await new Promise((resolve) => setImmediate(resolve));
  const secondResult = await second.runOneTick();
  assert.equal(secondResult.executed, false);
  release();
  assert.equal((await firstRun).executed, true);
  assert.equal(maximumActive, 1);
});

test("checkpoint advances once and restart resumes IDs from the persisted counter", async () => {
  const repository = new MemoryRepository();
  const first = workerFor(repository, async ({ instance }) => simulatorFrom(instance));
  await first.runOneTick();
  assert.equal(repository.instance.tickNumber, 1);
  assert.equal(repository.instance.checkpoint.claimSequence, 1);
  const restarted = workerFor(repository, async ({ instance }) => simulatorFrom(instance), "worker-restarted");
  await restarted.runOneTick();
  assert.equal(repository.instance.tickNumber, 2);
  assert.equal(repository.instance.checkpoint.claimSequence, 2);
});

test("failed tick and backpressure do not advance checkpoint", async () => {
  const failureRepository = new MemoryRepository();
  const failing = workerFor(failureRepository, async ({ instance }) => simulatorFrom(instance, { fail: true }));
  await assert.rejects(() => failing.runOneTick(), /tick failed/);
  assert.equal(failureRepository.instance.tickNumber, 0);
  assert.equal(failureRepository.instance.status, "failed");

  const pressureRepository = new MemoryRepository({ pressure: { reportOutboxBacklog: 10 } });
  let constructed = false;
  const pressured = workerFor(pressureRepository, async () => { constructed = true; });
  const result = await pressured.runOneTick();
  assert.equal(result.reason, "report_outbox_backlog");
  assert.equal(constructed, false);
  assert.equal(pressureRepository.instance.tickNumber, 0);
});

test("stopped and OFF instances perform no actions while static mode pauses after one tick", async () => {
  for (const options of [{ status: "stopped" }, { mode: "off" }]) {
    const repository = new MemoryRepository(options);
    let actions = 0;
    const worker = workerFor(repository, async ({ instance }) => { actions += 1; return simulatorFrom(instance); });
    assert.equal((await worker.runOneTick()).executed, false);
    assert.equal(actions, 0);
  }
  const staticRepository = new MemoryRepository({ mode: "static" });
  const staticWorker = workerFor(staticRepository, async ({ instance }) => simulatorFrom(instance));
  await staticWorker.runOneTick();
  assert.equal(staticRepository.instance.tickNumber, 1);
  assert.equal(staticRepository.instance.status, "paused");
});

test("stale fencing token cannot commit a checkpoint", async () => {
  const repository = new MemoryRepository();
  const acquired = await repository.acquireLease({ workerId: "old-worker" });
  repository.lease = null;
  await repository.acquireLease({ workerId: "new-worker" });
  await assert.rejects(
    () => repository.saveSuccessfulTick({
      workerId: "old-worker",
      fencingToken: acquired.lease.fencingToken,
      checkpoint: { version: 1, tickNumber: 1 },
    }),
    /lease lost/,
  );
});

test("lease renewal, release, and expiry recovery preserve fenced ownership", async () => {
  const repository = new MemoryRepository();
  const first = await repository.acquireLease({ workerId: "worker-a" });
  assert.equal((await repository.acquireLease({ workerId: "worker-b" })), null);
  repository.clock = 50;
  await repository.renewLease({ workerId: "worker-a", fencingToken: first.lease.fencingToken });
  repository.clock = 120;
  assert.equal((await repository.acquireLease({ workerId: "worker-b" })), null);
  assert.equal(await repository.releaseLease({ workerId: "worker-a", fencingToken: first.lease.fencingToken }), true);
  const afterRelease = await repository.acquireLease({ workerId: "worker-b" });
  assert.equal(afterRelease.lease.fencingToken > first.lease.fencingToken, true);
  repository.clock = 1000;
  const recovered = await repository.acquireLease({ workerId: "worker-c" });
  assert.equal(recovered.lease.fencingToken > afterRelease.lease.fencingToken, true);
});

test("pause requested during a tick commits that tick and prevents the next one", async () => {
  const repository = new MemoryRepository();
  const worker = workerFor(repository, async ({ instance }) => {
    const simulator = simulatorFrom(instance);
    const original = simulator.runTick;
    simulator.runTick = async () => {
      repository.instance.status = "pausing";
      return original();
    };
    return simulator;
  });
  assert.equal((await worker.runOneTick()).executed, true);
  assert.equal(repository.instance.status, "paused");
  assert.equal((await worker.runOneTick()).executed, false);
  assert.equal(repository.instance.tickNumber, 1);
});

test("retry after an uncertain API mutation reuses the stable tick action identity", async () => {
  const repository = new MemoryRepository();
  const acceptedActionIds = new Set();
  let firstAttempt = true;
  const factory = async ({ instance }) => ({
    async start() {},
    stop() {},
    async runTick() {
      const actionId = `${instance.id}:tick:${instance.tickNumber + 1}:claim:1`;
      acceptedActionIds.add(actionId);
      if (firstAttempt) {
        firstAttempt = false;
        throw new Error("response lost after mutation");
      }
      return { tick: 1, claims: 1, investigations: 0, confirmations: 0, reversals: 0 };
    },
    getCheckpoint() {
      return { version: 1, tickNumber: instance.tickNumber + 1, claimSequence: 1, randomState: 7, simulatedTime: "2026-01-01T12:00:00.000Z" };
    },
  });
  await assert.rejects(() => workerFor(repository, factory).runOneTick(), /response lost/);
  repository.instance.status = "running";
  await workerFor(repository, factory, "worker-recovery").runOneTick();
  assert.equal(acceptedActionIds.size, 1);
  assert.equal(repository.instance.tickNumber, 1);
});
