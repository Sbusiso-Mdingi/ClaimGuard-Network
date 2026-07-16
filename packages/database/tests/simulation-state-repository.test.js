import assert from "node:assert/strict";
import test from "node:test";

import {
  createSimulationStateRepository,
  SimulationLeaseLostError,
} from "../src/index.js";

function createLeasePool() {
  let now = new Date("2026-07-16T00:00:00.000Z");
  const instance = {
    id: "global-healthcare-demo",
    scope_key: "global:healthcare-demo",
    scope_type: "global",
    tenant_id: null,
    mode: "live",
    status: "starting",
    story_key: null,
    seed: 42,
    tick_interval_ms: 8000,
    simulated_at: null,
    tick_number: 0,
    checkpoint_version: 1,
    checkpoint: null,
    config: "{}",
    created_by: "test",
    created_at: now,
    updated_at: now,
    started_at: null,
    paused_at: null,
    stopped_at: null,
    last_successful_tick_at: null,
    last_correlation_id: null,
    last_error: null,
  };
  let lease = null;

  async function execute(sql, params = []) {
    const normalized = String(sql).replace(/\s+/g, " ").trim();
    if (normalized.startsWith("SELECT * FROM simulation_instances")) return [[{ ...instance }], []];
    if (normalized.startsWith("SELECT * FROM simulation_leases")) {
      const activeOnly = normalized.includes("lease_expires_at >");
      const rows = lease && (!activeOnly || lease.lease_expires_at > now) ? [{ ...lease }] : [];
      return [rows, []];
    }
    if (normalized.startsWith("SELECT UTC_TIMESTAMP")) return [[{ now }], []];
    if (normalized.startsWith("INSERT INTO simulation_leases")) {
      const [simulationInstanceId, leasedBy, fencingToken, seconds] = params;
      lease = {
        simulation_instance_id: simulationInstanceId,
        leased_by: leasedBy,
        fencing_token: fencingToken,
        leased_at: now,
        heartbeat_at: now,
        lease_expires_at: new Date(now.getTime() + Number(seconds) * 1000),
      };
      return [{ affectedRows: 1 }, []];
    }
    if (normalized.startsWith("UPDATE simulation_instances SET status = 'running'")) {
      instance.status = "running";
      return [{ affectedRows: 1 }, []];
    }
    if (normalized.startsWith("SELECT fencing_token FROM simulation_leases")) {
      const [instanceId, workerId, token] = params;
      const matches = lease && lease.simulation_instance_id === instanceId && lease.leased_by === workerId && lease.fencing_token === token && lease.lease_expires_at > now;
      return [matches ? [{ fencing_token: token }] : [], []];
    }
    if (normalized.startsWith("UPDATE simulation_leases SET") && normalized.includes("DATE_ADD")) {
      const [seconds, instanceId, workerId, token] = params;
      const matches = lease && lease.simulation_instance_id === instanceId && lease.leased_by === workerId && lease.fencing_token === token && lease.lease_expires_at > now;
      if (matches) {
        lease.heartbeat_at = now;
        lease.lease_expires_at = new Date(now.getTime() + Number(seconds) * 1000);
      }
      return [{ affectedRows: matches ? 1 : 0 }, []];
    }
    if (normalized.startsWith("UPDATE simulation_leases SET") && normalized.includes("lease_expires_at = UTC_TIMESTAMP")) {
      const [instanceId, workerId, token] = params;
      const matches = lease && lease.simulation_instance_id === instanceId && lease.leased_by === workerId && lease.fencing_token === token;
      if (matches) {
        lease.heartbeat_at = now;
        lease.lease_expires_at = now;
      }
      return [{ affectedRows: matches ? 1 : 0 }, []];
    }
    throw new Error(`Unexpected SQL in simulator repository test: ${normalized}`);
  }

  const connection = {
    execute,
    async beginTransaction() {},
    async commit() {},
    async rollback() {},
    release() {},
  };
  return {
    execute,
    async getConnection() { return connection; },
    advance(milliseconds) { now = new Date(now.getTime() + milliseconds); },
  };
}

test("database-backed lease excludes a second worker, renews, releases, and fences stale owners", async () => {
  const pool = createLeasePool();
  const repository = createSimulationStateRepository(pool);
  const first = await repository.acquireLease({ workerId: "worker-a", leaseSeconds: 60 });
  assert.equal(first.lease.fencingToken, 1);
  assert.equal(await repository.acquireLease({ workerId: "worker-b", leaseSeconds: 60 }), null);
  assert.equal(await repository.renewLease({ workerId: "worker-a", fencingToken: 1, leaseSeconds: 120 }), true);
  assert.equal(await repository.releaseLease({ workerId: "worker-a", fencingToken: 1 }), true);
  const second = await repository.acquireLease({ workerId: "worker-b", leaseSeconds: 60 });
  assert.equal(second.lease.fencingToken, 2);
  await assert.rejects(
    () => repository.assertLease({ workerId: "worker-a", fencingToken: 1 }),
    SimulationLeaseLostError,
  );
});

test("expired database lease is recovered with a higher fencing generation", async () => {
  const pool = createLeasePool();
  const repository = createSimulationStateRepository(pool);
  const first = await repository.acquireLease({ workerId: "worker-a", leaseSeconds: 30 });
  pool.advance(31000);
  const recovered = await repository.acquireLease({ workerId: "worker-b", leaseSeconds: 30 });
  assert.equal(recovered.lease.fencingToken, first.lease.fencingToken + 1);
});

test("a routed simulator repository cannot read or lease another tenant's instance", async () => {
  const alpha = {
    id: "tenant-alpha", tenant_id: "tenant-alpha", scope_key: "tenant:tenant-alpha", scope_type: "tenant",
    mode: "static", status: "starting", seed: 42, tick_interval_ms: 8000, tick_number: 0,
    checkpoint_version: 1, checkpoint: null, config: "{}",
  };
  const pool = {
    async execute(sql, params = []) {
      const statement = String(sql).replace(/\s+/g, " ");
      if (statement.includes("FROM simulation_instances")) {
        const requestedTenant = params[1];
        return [requestedTenant === alpha.tenant_id ? [alpha] : [], []];
      }
      throw new Error(`Unexpected SQL: ${statement}`);
    },
    async getConnection() {
      return { execute: this.execute.bind(this), beginTransaction: async () => {}, commit: async () => {}, rollback: async () => {}, release() {} };
    },
  };
  const betaRepository = createSimulationStateRepository(pool, {
    dataPlaneContext: { routeType: "legacy_shared", operationalTenantId: "tenant-beta" },
  });
  assert.equal(await betaRepository.getStatus("tenant-alpha"), null);
  assert.equal(await betaRepository.acquireLease({ instanceId: "tenant-alpha", workerId: "beta-worker" }), null);
  await assert.rejects(
    () => betaRepository.assertLease({ instanceId: "tenant-alpha", workerId: "beta-worker", fencingToken: 1 }),
    /unavailable in the active tenant/,
  );
});
