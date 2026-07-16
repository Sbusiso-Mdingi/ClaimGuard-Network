import crypto from "node:crypto";

import {
  DEFAULT_SIMULATION_ID,
  SimulationLeaseLostError,
} from "@claimguard/database";

function positiveInteger(value, fallback, maximum = Number.MAX_SAFE_INTEGER) {
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? Math.min(parsed, maximum) : fallback;
}

export function simulatorWorkerConfigFromEnvironment(env = process.env) {
  const maximumTickDurationMs = positiveInteger(env.SIMULATOR_MAX_TICK_MS, 60000, 300000);
  const leaseSeconds = Math.max(
    positiveInteger(env.SIMULATOR_LEASE_SECONDS, 120, 3600),
    Math.ceil(maximumTickDurationMs / 1000) + 30,
  );
  return {
    instanceId: env.SIMULATOR_INSTANCE_ID || DEFAULT_SIMULATION_ID,
    workerId: env.SIMULATOR_WORKER_ID || `${process.env.HOSTNAME || "simulator"}-${process.pid}-${crypto.randomUUID().slice(0, 8)}`,
    leaseSeconds,
    pollMs: positiveInteger(env.SIMULATOR_POLL_MS, 5000, 300000),
    maximumTickDurationMs,
    maxClaimsPerTick: positiveInteger(env.SIMULATOR_MAX_CLAIMS_PER_TICK, 3, 3),
    maxOutboxBacklog: positiveInteger(env.SIMULATOR_MAX_OUTBOX_BACKLOG, 100, 100000),
    maxActiveInvestigations: positiveInteger(env.SIMULATOR_MAX_ACTIVE_INVESTIGATIONS, 800, 100000),
  };
}

function defaultLogger(level, event, details = {}) {
  const payload = {
    timestamp: new Date().toISOString(),
    level,
    service: "simulator-worker",
    event,
    ...details,
  };
  const rendered = JSON.stringify(payload);
  if (level === "error") console.error(rendered);
  else console.log(rendered);
}

export function createSimulatorWorker({ repository, simulatorFactory, readiness, config, logger = defaultLogger, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) } = {}) {
  if (!repository || typeof repository.acquireLease !== "function") throw new TypeError("A simulator state repository is required.");
  if (typeof simulatorFactory !== "function") throw new TypeError("simulatorFactory is required.");
  const resolved = { ...simulatorWorkerConfigFromEnvironment({}), ...(config || {}) };

  async function runOneTick() {
    const acquired = await repository.acquireLease({
      instanceId: resolved.instanceId,
      workerId: resolved.workerId,
      leaseSeconds: resolved.leaseSeconds,
    });
    if (!acquired) return { executed: false, reason: "not_runnable_or_leased" };

    const { instance, lease } = acquired;
    const context = {
      simulationInstanceId: instance.id,
      scope: instance.scopeKey,
      mode: instance.mode,
      lifecycleState: instance.status,
      workerId: resolved.workerId,
      fencingToken: lease.fencingToken,
      tickNumber: Number(instance.tickNumber) + 1,
    };
    const leaseAcquiredAt = Date.now();
    logger("info", "simulation_lease_acquired", context);

    try {
      if (typeof readiness === "function" && !(await readiness())) {
        await repository.recordBackpressure({
          instanceId: instance.id,
          workerId: resolved.workerId,
          fencingToken: lease.fencingToken,
          reason: "api_not_ready",
        });
        logger("warning", "simulation_backpressure", { ...context, reason: "api_not_ready" });
        return { executed: false, reason: "api_not_ready" };
      }

      const pressure = await repository.getBackpressure();
      if (
        pressure.reportOutboxBacklog >= resolved.maxOutboxBacklog ||
        pressure.activeInvestigations >= resolved.maxActiveInvestigations
      ) {
        const reason = pressure.reportOutboxBacklog >= resolved.maxOutboxBacklog
          ? "report_outbox_backlog"
          : "active_investigation_cap";
        await repository.recordBackpressure({
          instanceId: instance.id,
          workerId: resolved.workerId,
          fencingToken: lease.fencingToken,
          reason,
          details: pressure,
        });
        logger("warning", "simulation_backpressure", { ...context, reason, ...pressure });
        return { executed: false, reason, pressure };
      }

      const correlationId = `${instance.id}:tick:${context.tickNumber}`;
      await repository.recordTickStarted({
        instanceId: instance.id,
        workerId: resolved.workerId,
        fencingToken: lease.fencingToken,
        tickNumber: context.tickNumber,
        correlationId,
      });
      await repository.renewLease({
        instanceId: instance.id,
        workerId: resolved.workerId,
        fencingToken: lease.fencingToken,
        leaseSeconds: resolved.leaseSeconds,
      });
      logger("info", "simulation_lease_renewed", context);

      const deadline = Date.now() + resolved.maximumTickDurationMs;
      const assertMutationAllowed = async () => {
        if (Date.now() >= deadline) throw new Error("Simulator tick exceeded its configured maximum duration.");
        return repository.assertLease({
          instanceId: instance.id,
          workerId: resolved.workerId,
          fencingToken: lease.fencingToken,
        });
      };
      const simulator = await simulatorFactory({ instance, assertMutationAllowed, deadline, maxClaimsPerTick: resolved.maxClaimsPerTick });
      const startedAt = Date.now();
      await simulator.start();
      const outcome = await simulator.runTick();
      const checkpoint = simulator.getCheckpoint();
      simulator.stop();
      await assertMutationAllowed();
      const durationMs = Date.now() - startedAt;
      const saved = await repository.saveSuccessfulTick({
        instanceId: instance.id,
        workerId: resolved.workerId,
        fencingToken: lease.fencingToken,
        checkpoint,
        correlationId,
        outcome: {
          claims: outcome.claims,
          investigations: outcome.investigations,
          confirmations: outcome.confirmations,
          reversals: outcome.reversals,
          backpressure: false,
        },
        durationMs,
        pauseAfterTick: instance.mode === "static",
      });
      logger("info", "simulation_checkpoint_saved", {
        ...context,
        correlationId,
        tickDurationMs: durationMs,
        lifecycleState: saved.status,
        actionsAttempted: outcome,
      });
      return { executed: true, checkpoint, outcome, status: saved.status, correlationId };
    } catch (error) {
      const errorType = error?.name || "SimulationTickError";
      if (!(error instanceof SimulationLeaseLostError)) {
        try {
          await repository.recordTickFailure({
            instanceId: instance.id,
            workerId: resolved.workerId,
            fencingToken: lease.fencingToken,
            tickNumber: context.tickNumber,
            correlationId: `${instance.id}:tick:${context.tickNumber}`,
            errorType,
            durationMs: Date.now() - leaseAcquiredAt,
          });
        } catch (recordError) {
          if (!(recordError instanceof SimulationLeaseLostError)) throw recordError;
        }
      }
      if (error instanceof SimulationLeaseLostError) {
        logger("warning", "simulation_lease_lost", context);
      }
      logger("error", "simulation_tick_failed", { ...context, failureType: errorType });
      throw error;
    } finally {
      const released = await repository.releaseLease({
        instanceId: instance.id,
        workerId: resolved.workerId,
        fencingToken: lease.fencingToken,
      }).catch(() => false);
      logger("info", "simulation_lease_released", { ...context, released });
    }
  }

  async function runContinuous() {
    for (;;) {
      const result = await runOneTick().catch(() => ({ executed: false, reason: "tick_failed" }));
      const status = await repository.getStatus(resolved.instanceId);
      if (["paused", "stopped", "failed"].includes(status?.status) || status?.mode === "off") return result;
      await sleep(status?.tickIntervalMs || resolved.pollMs);
    }
  }

  async function runUntilPaused() {
    let lastResult = null;
    for (;;) {
      lastResult = await runOneTick();
      const status = await repository.getStatus(resolved.instanceId);
      if (!status || ["paused", "stopped", "failed"].includes(status.status) || !lastResult.executed) return lastResult;
    }
  }

  return { runOneTick, runContinuous, runUntilPaused };
}
