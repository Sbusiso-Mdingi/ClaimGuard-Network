export const SIMULATION_CHECKPOINT_VERSION = 1;
export const DEFAULT_SIMULATION_ID = "global-healthcare-demo";
export const DEFAULT_SIMULATION_SCOPE_KEY = "global:healthcare-demo";

export const SIMULATION_MODES = Object.freeze(["off", "static", "live", "story"]);
export const SIMULATION_STATUSES = Object.freeze([
  "stopped",
  "starting",
  "running",
  "pausing",
  "paused",
  "stopping",
  "failed",
]);

export class SimulationConflictError extends Error {
  constructor(message) {
    super(message);
    this.name = "SimulationConflictError";
    this.code = "SIMULATION_LIFECYCLE_CONFLICT";
    this.status = 409;
  }
}

export class SimulationCheckpointError extends Error {
  constructor(message) {
    super(message);
    this.name = "SimulationCheckpointError";
    this.code = "SIMULATION_CHECKPOINT_INVALID";
    this.status = 422;
  }
}

export class SimulationLeaseLostError extends Error {
  constructor(message = "The simulator lease is no longer owned by this worker.") {
    super(message);
    this.name = "SimulationLeaseLostError";
    this.code = "SIMULATION_LEASE_LOST";
    this.status = 409;
  }
}

function requireText(value, field) {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!normalized) throw new TypeError(`${field} is required.`);
  return normalized;
}

function positiveInteger(value, fallback, maximum = Number.MAX_SAFE_INTEGER) {
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? Math.min(parsed, maximum) : fallback;
}

function parseJson(value) {
  if (value == null || typeof value === "object") return value;
  try {
    return JSON.parse(value);
  } catch {
    throw new SimulationCheckpointError("Persisted simulator JSON is malformed.");
  }
}

function mapInstance(row) {
  if (!row) return null;
  const checkpointVersion = Number(row.checkpoint_version);
  if (row.checkpoint != null && checkpointVersion !== SIMULATION_CHECKPOINT_VERSION) {
    throw new SimulationCheckpointError(`Unsupported simulator checkpoint version ${checkpointVersion}.`);
  }
  return {
    id: row.id,
    scopeKey: row.scope_key,
    scopeType: row.scope_type,
    tenantId: row.tenant_id,
    mode: row.mode,
    status: row.status,
    storyKey: row.story_key,
    seed: Number(row.seed),
    tickIntervalMs: Number(row.tick_interval_ms),
    simulatedAt: row.simulated_at,
    tickNumber: Number(row.tick_number),
    checkpointVersion,
    checkpoint: parseJson(row.checkpoint),
    config: parseJson(row.config) || {},
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    startedAt: row.started_at,
    pausedAt: row.paused_at,
    stoppedAt: row.stopped_at,
    lastSuccessfulTickAt: row.last_successful_tick_at,
    lastCorrelationId: row.last_correlation_id,
    lastControlCommand: row.last_control_command,
    lastControlActor: row.last_control_actor,
    lastControlCorrelationId: row.last_control_correlation_id,
    lastError: parseJson(row.last_error),
  };
}

function mapLease(row) {
  if (!row) return null;
  return {
    simulationInstanceId: row.simulation_instance_id,
    leasedBy: row.leased_by,
    fencingToken: Number(row.fencing_token),
    leasedAt: row.leased_at,
    leaseExpiresAt: row.lease_expires_at,
    heartbeatAt: row.heartbeat_at,
  };
}

async function withTransaction(pool, operation) {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const result = await operation(connection);
    await connection.commit();
    return result;
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

async function loadLockedInstance(connection, instanceId) {
  const [rows] = await connection.execute(
    "SELECT * FROM simulation_instances WHERE id = ? LIMIT 1 FOR UPDATE",
    [instanceId],
  );
  return mapInstance(rows?.[0]);
}

async function loadLockedLease(connection, instanceId) {
  const [rows] = await connection.execute(
    "SELECT * FROM simulation_leases WHERE simulation_instance_id = ? LIMIT 1 FOR UPDATE",
    [instanceId],
  );
  return mapLease(rows?.[0]);
}

async function requireLockedLease(connection, { instanceId, workerId, fencingToken }) {
  const lease = await loadLockedLease(connection, instanceId);
  if (!lease || lease.leasedBy !== workerId || lease.fencingToken !== Number(fencingToken)) {
    throw new SimulationLeaseLostError();
  }
  const [clockRows] = await connection.execute("SELECT UTC_TIMESTAMP(3) AS now");
  if (new Date(lease.leaseExpiresAt) <= new Date(clockRows?.[0]?.now || Date.now())) {
    throw new SimulationLeaseLostError();
  }
  return lease;
}

function assertCheckpoint(checkpoint, expectedTick) {
  if (!checkpoint || typeof checkpoint !== "object" || Array.isArray(checkpoint)) {
    throw new SimulationCheckpointError("Simulator checkpoint must be an object.");
  }
  if (checkpoint.version !== SIMULATION_CHECKPOINT_VERSION) {
    throw new SimulationCheckpointError(`Unsupported simulator checkpoint version ${checkpoint.version}.`);
  }
  if (Number(checkpoint.tickNumber) !== expectedTick) {
    throw new SimulationCheckpointError("Simulator checkpoint tick does not match the expected next tick.");
  }
}

export function createSimulationStateRepository(pool, { dataPlaneContext = null } = {}) {
  if (!pool || typeof pool.execute !== "function" || typeof pool.getConnection !== "function") {
    throw new TypeError("A MySQL pool with execute and getConnection is required.");
  }
  if (dataPlaneContext && dataPlaneContext.routeType !== "legacy_shared") throw new TypeError("Simulator state requires an operational DataPlaneContext.");

  return {
    async ensureDefaultInstance({ createdBy = "system", mode = "off", seed = 42, tickIntervalMs = 8000, storyKey = null, config = {} } = {}) {
      if (!SIMULATION_MODES.includes(mode)) throw new TypeError("Unsupported simulation mode.");
      await pool.execute(
        `INSERT INTO simulation_instances (
          id, scope_key, scope_type, mode, status, story_key, seed,
          tick_interval_ms, checkpoint_version, config, created_by
        ) VALUES (?, ?, 'global', ?, 'stopped', ?, ?, ?, ?, ?, ?)
        ON DUPLICATE KEY UPDATE id = id`,
        [
          DEFAULT_SIMULATION_ID,
          DEFAULT_SIMULATION_SCOPE_KEY,
          mode,
          storyKey,
          Number(seed) || 42,
          positiveInteger(tickIntervalMs, 8000, 300000),
          SIMULATION_CHECKPOINT_VERSION,
          JSON.stringify(config || {}),
          requireText(createdBy, "createdBy"),
        ],
      );
      return this.getStatus(DEFAULT_SIMULATION_ID);
    },

    async getStatus(instanceId = DEFAULT_SIMULATION_ID) {
      const [instanceRows] = await pool.execute(
        "SELECT * FROM simulation_instances WHERE id = ? LIMIT 1",
        [instanceId],
      );
      const instance = mapInstance(instanceRows?.[0]);
      if (!instance) return null;
      const [leaseRows] = await pool.execute(
        `SELECT * FROM simulation_leases
         WHERE simulation_instance_id = ? AND lease_expires_at > UTC_TIMESTAMP(3)
         LIMIT 1`,
        [instanceId],
      );
      return { ...instance, lease: mapLease(leaseRows?.[0]) };
    },

    async command({ instanceId = DEFAULT_SIMULATION_ID, action, actorId, correlationId, mode, storyKey } = {}) {
      const canonicalAction = requireText(action, "action").toLowerCase();
      const canonicalActor = requireText(actorId, "actorId");
      const canonicalCorrelationId = requireText(correlationId, "correlationId");
      return withTransaction(pool, async (connection) => {
        const instance = await loadLockedInstance(connection, instanceId);
        if (!instance) throw new SimulationConflictError("The simulation instance does not exist.");
        let nextStatus = instance.status;
        let nextMode = instance.mode;

        if (canonicalAction === "start") {
          if (["starting", "running"].includes(instance.status)) return instance;
          if (!["stopped", "paused", "failed"].includes(instance.status) || instance.mode === "off") {
            throw new SimulationConflictError("Simulation cannot start from its current lifecycle state or OFF mode.");
          }
          nextStatus = "starting";
        } else if (canonicalAction === "pause") {
          if (["pausing", "paused"].includes(instance.status)) return instance;
          if (!["starting", "running"].includes(instance.status)) {
            throw new SimulationConflictError("Only a starting or running simulation can be paused.");
          }
          nextStatus = "pausing";
        } else if (canonicalAction === "resume") {
          if (["starting", "running"].includes(instance.status)) return instance;
          if (instance.status !== "paused" || instance.mode === "off") {
            throw new SimulationConflictError("Only a paused non-OFF simulation can resume.");
          }
          nextStatus = "starting";
        } else if (canonicalAction === "stop") {
          if (instance.status === "stopped") return instance;
          nextStatus = "stopped";
          await connection.execute(
            `UPDATE simulation_leases SET
               leased_by = ?, fencing_token = fencing_token + 1,
               heartbeat_at = UTC_TIMESTAMP(3), lease_expires_at = UTC_TIMESTAMP(3)
             WHERE simulation_instance_id = ?`,
            [`control:${canonicalActor}`, instanceId],
          );
        } else if (canonicalAction === "mode") {
          if (!SIMULATION_MODES.includes(mode)) throw new SimulationConflictError("Unsupported simulation mode.");
          if (!["stopped", "paused", "failed"].includes(instance.status)) {
            throw new SimulationConflictError("Simulation mode can change only while stopped, paused, or failed.");
          }
          if (
            mode === "story" &&
            Number(instance.tickNumber) > 0 &&
            storyKey !== undefined &&
            storyKey !== instance.storyKey
          ) {
            throw new SimulationConflictError("Story selection cannot change after progress exists without an explicit checkpoint reset.");
          }
          nextMode = mode;
          nextStatus = mode === "off" ? "stopped" : instance.status;
        } else {
          throw new SimulationConflictError("Unsupported simulation command.");
        }

        await connection.execute(
          `UPDATE simulation_instances SET
             status = ?, mode = ?, story_key = ?,
             started_at = CASE WHEN ? = 'starting' THEN COALESCE(started_at, UTC_TIMESTAMP(3)) ELSE started_at END,
             paused_at = CASE WHEN ? = 'paused' THEN UTC_TIMESTAMP(3) ELSE paused_at END,
             stopped_at = CASE WHEN ? = 'stopped' THEN UTC_TIMESTAMP(3) ELSE stopped_at END,
             last_error = CASE WHEN ? IN ('starting', 'stopped') THEN NULL ELSE last_error END,
             last_control_command = ?, last_control_actor = ?, last_control_correlation_id = ?,
             updated_at = UTC_TIMESTAMP(3)
           WHERE id = ?`,
          [
            nextStatus,
            nextMode,
            storyKey === undefined ? instance.storyKey : storyKey,
            nextStatus,
            nextStatus,
            nextStatus,
            nextStatus,
            canonicalAction,
            canonicalActor,
            canonicalCorrelationId,
            instanceId,
          ],
        );
        const updated = await loadLockedInstance(connection, instanceId);
        return { ...updated, commandedBy: canonicalActor };
      });
    },

    async acquireLease({ instanceId = DEFAULT_SIMULATION_ID, workerId, leaseSeconds = 60 } = {}) {
      const canonicalWorkerId = requireText(workerId, "workerId");
      const duration = positiveInteger(leaseSeconds, 60, 3600);
      return withTransaction(pool, async (connection) => {
        const instance = await loadLockedInstance(connection, instanceId);
        if (!instance || !["starting", "running"].includes(instance.status) || instance.mode === "off") return null;
        const lease = await loadLockedLease(connection, instanceId);
        const [clockRows] = await connection.execute("SELECT UTC_TIMESTAMP(3) AS now");
        const now = new Date(clockRows?.[0]?.now || Date.now());
        if (lease && new Date(lease.leaseExpiresAt) > now && lease.leasedBy !== canonicalWorkerId) return null;
        const fencingToken = Number(lease?.fencingToken || 0) + 1;
        await connection.execute(
          `INSERT INTO simulation_leases (
             simulation_instance_id, leased_by, fencing_token, leased_at, lease_expires_at, heartbeat_at
           ) VALUES (?, ?, ?, UTC_TIMESTAMP(3), DATE_ADD(UTC_TIMESTAMP(3), INTERVAL ? SECOND), UTC_TIMESTAMP(3))
           ON DUPLICATE KEY UPDATE
             leased_by = VALUES(leased_by), fencing_token = VALUES(fencing_token),
             leased_at = VALUES(leased_at), lease_expires_at = VALUES(lease_expires_at),
             heartbeat_at = VALUES(heartbeat_at)`,
          [instanceId, canonicalWorkerId, fencingToken, duration],
        );
        if (instance.status === "starting") {
          await connection.execute(
            "UPDATE simulation_instances SET status = 'running', updated_at = UTC_TIMESTAMP(3) WHERE id = ? AND status = 'starting'",
            [instanceId],
          );
        }
        return { instance: { ...instance, status: "running" }, lease: { simulationInstanceId: instanceId, leasedBy: canonicalWorkerId, fencingToken } };
      });
    },

    async assertLease({ instanceId = DEFAULT_SIMULATION_ID, workerId, fencingToken } = {}) {
      const [rows] = await pool.execute(
        `SELECT fencing_token FROM simulation_leases
         WHERE simulation_instance_id = ? AND leased_by = ? AND fencing_token = ?
           AND lease_expires_at > UTC_TIMESTAMP(3) LIMIT 1`,
        [instanceId, requireText(workerId, "workerId"), Number(fencingToken)],
      );
      if (!rows?.[0]) throw new SimulationLeaseLostError();
      return true;
    },

    async renewLease({ instanceId = DEFAULT_SIMULATION_ID, workerId, fencingToken, leaseSeconds = 60 } = {}) {
      const [result] = await pool.execute(
        `UPDATE simulation_leases SET
           heartbeat_at = UTC_TIMESTAMP(3),
           lease_expires_at = DATE_ADD(UTC_TIMESTAMP(3), INTERVAL ? SECOND)
         WHERE simulation_instance_id = ? AND leased_by = ? AND fencing_token = ?
           AND lease_expires_at > UTC_TIMESTAMP(3)`,
        [positiveInteger(leaseSeconds, 60, 3600), instanceId, requireText(workerId, "workerId"), Number(fencingToken)],
      );
      if (Number(result?.affectedRows || 0) !== 1) throw new SimulationLeaseLostError();
      return true;
    },

    async releaseLease({ instanceId = DEFAULT_SIMULATION_ID, workerId, fencingToken } = {}) {
      const [result] = await pool.execute(
        `UPDATE simulation_leases SET
           heartbeat_at = UTC_TIMESTAMP(3), lease_expires_at = UTC_TIMESTAMP(3)
         WHERE simulation_instance_id = ? AND leased_by = ? AND fencing_token = ?`,
        [instanceId, requireText(workerId, "workerId"), Number(fencingToken)],
      );
      return Number(result?.affectedRows || 0) === 1;
    },

    async recordTickStarted({ instanceId = DEFAULT_SIMULATION_ID, workerId, fencingToken, tickNumber, correlationId } = {}) {
      await withTransaction(pool, async (connection) => {
        await loadLockedInstance(connection, instanceId);
        await requireLockedLease(connection, { instanceId, workerId, fencingToken });
        await connection.execute(
          `INSERT INTO simulation_tick_history (
             simulation_instance_id, tick_number, correlation_id, fencing_token,
             status, started_at, checkpoint_version
           ) VALUES (?, ?, ?, ?, 'running', UTC_TIMESTAMP(3), ?)
           ON DUPLICATE KEY UPDATE
             correlation_id = VALUES(correlation_id), fencing_token = VALUES(fencing_token),
             status = 'running', started_at = UTC_TIMESTAMP(3), completed_at = NULL,
             duration_ms = NULL, outcome_summary = NULL, error_type = NULL`,
          [instanceId, Number(tickNumber), requireText(correlationId, "correlationId"), Number(fencingToken), SIMULATION_CHECKPOINT_VERSION],
        );
      });
    },

    async saveSuccessfulTick({ instanceId = DEFAULT_SIMULATION_ID, workerId, fencingToken, checkpoint, correlationId, outcome = {}, durationMs = 0, pauseAfterTick = false } = {}) {
      return withTransaction(pool, async (connection) => {
        const instance = await loadLockedInstance(connection, instanceId);
        await requireLockedLease(connection, { instanceId, workerId, fencingToken });
        const nextTick = Number(instance.tickNumber) + 1;
        assertCheckpoint(checkpoint, nextTick);
        const shouldPause = pauseAfterTick || instance.status === "pausing" || instance.mode === "static";
        const nextStatus = shouldPause ? "paused" : "running";
        await connection.execute(
          `UPDATE simulation_instances SET
             status = ?, tick_number = ?, simulated_at = ?, checkpoint_version = ?, checkpoint = ?,
             last_successful_tick_at = UTC_TIMESTAMP(3), last_correlation_id = ?, last_error = NULL,
             paused_at = CASE WHEN ? = 'paused' THEN UTC_TIMESTAMP(3) ELSE paused_at END,
             updated_at = UTC_TIMESTAMP(3)
           WHERE id = ?`,
          [nextStatus, nextTick, checkpoint.simulatedTime, SIMULATION_CHECKPOINT_VERSION, JSON.stringify(checkpoint), correlationId, nextStatus, instanceId],
        );
        await connection.execute(
          `UPDATE simulation_tick_history SET
             status = 'completed', completed_at = UTC_TIMESTAMP(3), duration_ms = ?,
             outcome_summary = ?, error_type = NULL, checkpoint_version = ?
           WHERE simulation_instance_id = ? AND tick_number = ? AND correlation_id = ?`,
          [Math.max(0, Math.round(durationMs)), JSON.stringify(outcome || {}), SIMULATION_CHECKPOINT_VERSION, instanceId, nextTick, correlationId],
        );
        if (shouldPause) {
          await connection.execute(
            `UPDATE simulation_leases SET
               heartbeat_at = UTC_TIMESTAMP(3), lease_expires_at = UTC_TIMESTAMP(3)
             WHERE simulation_instance_id = ? AND leased_by = ? AND fencing_token = ?`,
            [instanceId, workerId, Number(fencingToken)],
          );
        }
        return { ...instance, status: nextStatus, tickNumber: nextTick, checkpoint };
      });
    },

    async recordTickFailure({ instanceId = DEFAULT_SIMULATION_ID, workerId, fencingToken, tickNumber, correlationId, errorType, durationMs = 0 } = {}) {
      await withTransaction(pool, async (connection) => {
        await loadLockedInstance(connection, instanceId);
        await requireLockedLease(connection, { instanceId, workerId, fencingToken });
        const canonicalErrorType = requireText(errorType, "errorType");
        await connection.execute(
          `UPDATE simulation_tick_history SET status = 'failed', completed_at = UTC_TIMESTAMP(3),
             duration_ms = ?, error_type = ?
           WHERE simulation_instance_id = ? AND tick_number = ? AND correlation_id = ?`,
          [Math.max(0, Math.round(durationMs)), canonicalErrorType, instanceId, Number(tickNumber), correlationId],
        );
        await connection.execute(
          `UPDATE simulation_instances SET status = 'failed', last_error = ?, updated_at = UTC_TIMESTAMP(3)
           WHERE id = ?`,
          [JSON.stringify({ type: canonicalErrorType, tickNumber: Number(tickNumber), at: new Date().toISOString() }), instanceId],
        );
        await connection.execute(
          `UPDATE simulation_leases SET
             heartbeat_at = UTC_TIMESTAMP(3), lease_expires_at = UTC_TIMESTAMP(3)
           WHERE simulation_instance_id = ? AND leased_by = ? AND fencing_token = ?`,
          [instanceId, workerId, Number(fencingToken)],
        );
      });
    },

    async getBackpressure() {
      const [[outboxRows], [investigationRows]] = await Promise.all([
        pool.execute("SELECT COUNT(*) AS count FROM claim_processing_outbox WHERE status IN ('pending', 'retry', 'processing')"),
        pool.execute("SELECT COUNT(*) AS count FROM investigations WHERE status <> 'CLOSED'"),
      ]);
      return {
        reportOutboxBacklog: Number(outboxRows?.[0]?.count || 0),
        activeInvestigations: Number(investigationRows?.[0]?.count || 0),
      };
    },

    async recordBackpressure({ instanceId = DEFAULT_SIMULATION_ID, workerId, fencingToken, reason, details = {} } = {}) {
      await withTransaction(pool, async (connection) => {
        await loadLockedInstance(connection, instanceId);
        await requireLockedLease(connection, { instanceId, workerId, fencingToken });
        await connection.execute(
          `UPDATE simulation_instances SET last_error = ?, updated_at = UTC_TIMESTAMP(3)
           WHERE id = ?`,
          [
            JSON.stringify({
              type: "backpressure",
              reason: requireText(reason, "reason"),
              details,
              at: new Date().toISOString(),
            }),
            instanceId,
          ],
        );
      });
    },
  };
}
