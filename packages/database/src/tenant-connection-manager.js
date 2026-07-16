import { dataPlanePoolKey, requireOperationalDataPlaneContext } from "./data-plane-context.js";

export class TenantPoolLimitError extends Error {
  constructor(message = "The tenant connection pool limit has been reached.") {
    super(message);
    this.name = "TenantPoolLimitError";
    this.code = "DATA_PLANE_POOL_LIMIT";
    this.status = 503;
  }
}

export class TenantPoolTimeoutError extends Error {
  constructor(stage) {
    super(`Tenant connection pool ${stage} timed out.`);
    this.name = "TenantPoolTimeoutError";
    this.code = stage === "creation" ? "DATA_PLANE_POOL_CREATION_TIMEOUT" : "DATA_PLANE_POOL_DRAIN_TIMEOUT";
    this.status = 503;
  }
}

export class TenantPoolStaleGenerationError extends Error {
  constructor() {
    super("The data-plane route generation is stale.");
    this.name = "TenantPoolStaleGenerationError";
    this.code = "DATA_PLANE_ROUTE_GENERATION_STALE";
    this.status = 503;
  }
}

function withTimeout(promise, timeoutMs, stage) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => { timer = setTimeout(() => reject(new TenantPoolTimeoutError(stage)), timeoutMs); }),
  ]).finally(() => clearTimeout(timer));
}

export function createTenantConnectionManager({
  adapters,
  maxPools = 32,
  idleTimeoutMs = 10 * 60 * 1000,
  creationTimeoutMs = 10_000,
  drainTimeoutMs = 10_000,
  now = () => Date.now(),
  logger = null,
} = {}) {
  if (!adapters || typeof adapters !== "object") throw new TypeError("TenantConnectionManager requires route adapters.");
  for (const [name, value] of Object.entries({ maxPools, idleTimeoutMs, creationTimeoutMs, drainTimeoutMs })) {
    if (!Number.isFinite(value) || value <= 0 || !Number.isInteger(value)) throw new TypeError(`${name} must be a positive integer.`);
  }
  const entries = new Map();
  const creating = new Map();
  const failures = new Map();
  const latestGenerationByOrganisation = new Map();

  function observeGeneration(context) {
    const latest = latestGenerationByOrganisation.get(context.organisationId);
    if (latest && (
      context.routeGeneration < latest.routeGeneration ||
      (context.routeGeneration === latest.routeGeneration && context.routeId !== latest.routeId)
    )) {
      throw new TenantPoolStaleGenerationError();
    }
    if (!latest || context.routeGeneration > latest.routeGeneration) {
      latestGenerationByOrganisation.set(context.organisationId, {
        routeId: context.routeId,
        routeGeneration: context.routeGeneration,
      });
    }
  }

  function safeLog(event, context, extra = {}) {
    logger?.("info", event, {
      organisationId: context?.organisationId || null,
      routeId: context?.routeId || null,
      routeType: context?.routeType || null,
      routeGeneration: context?.routeGeneration || null,
      correlationId: context?.correlationId || null,
      serviceIdentityId: context?.serviceIdentityId || null,
      ...extra,
    });
  }

  async function finalizeClose(entry, reason) {
    if (entry.closed) return;
    entry.retiring = true;
    entry.closed = true;
    entries.delete(entry.key);
    await withTimeout(Promise.resolve(entry.adapter.close(entry.pool)), drainTimeoutMs, "drain");
    entry.resolveDrained?.();
    safeLog("data_plane_pool_drained", entry.context, { reason });
  }

  async function retireEntry(entry, reason, { waitForDrain = false } = {}) {
    if (entry.closed) return;
    entry.retiring = true;
    entry.retirementReason = reason;
    if (entry.active === 0) return finalizeClose(entry, reason);
    if (!entry.drainPromise) entry.drainPromise = new Promise((resolve) => { entry.resolveDrained = resolve; });
    if (waitForDrain) return withTimeout(entry.drainPromise, drainTimeoutMs, "drain");
  }

  async function evictEligible() {
    const eligible = [...entries.values()]
      .filter((entry) => entry.active === 0 && !entry.retiring)
      .sort((left, right) => left.lastUsedAt - right.lastUsedAt);
    if (!eligible.length) return false;
    await retireEntry(eligible[0], "lru_eviction");
    safeLog("data_plane_pool_evicted", eligible[0].context, { reason: "lru" });
    return true;
  }

  async function retirePreviousGenerations(context, currentKey) {
    const previous = [...entries.values()].filter((entry) =>
      entry.context.organisationId === context.organisationId && entry.key !== currentKey,
    );
    await Promise.all(previous.map((entry) => retireEntry(entry, "route_generation_changed")));
  }

  async function createEntry(context, key) {
    if (entries.size + creating.size >= maxPools && !(await evictEligible())) throw new TenantPoolLimitError();
    const adapter = adapters[context.routeType];
    if (!adapter) throw new TypeError(`No adapter is configured for ${context.routeType}.`);
    safeLog("data_plane_pool_creation_started", context);
    let pool;
    let creationPromise;
    try {
      creationPromise = Promise.resolve(adapter.create(context));
      pool = await withTimeout(creationPromise, creationTimeoutMs, "creation");
      const metadata = await withTimeout(Promise.resolve(adapter.verify(pool, context)), creationTimeoutMs, "creation");
      observeGeneration(context);
      const entry = {
        key, context, pool, adapter, metadata, active: 0, retiring: false, closed: false,
        createdAt: now(), lastUsedAt: now(), lastSuccessfulConnectionAt: new Date(now()).toISOString(),
      };
      entries.set(key, entry);
      failures.delete(key);
      safeLog("data_plane_metadata_verified", context, { schemaVersion: metadata.schemaVersion });
      return entry;
    } catch (error) {
      failures.set(key, { category: error.code || error.name || "connection_failure", at: new Date(now()).toISOString() });
      if (pool) await Promise.resolve(adapter.close(pool)).catch(() => {});
      else creationPromise?.then((latePool) => adapter.close(latePool)).catch(() => {});
      safeLog("data_plane_pool_creation_failed", context, { failureCategory: error.code || error.name || "connection_failure" });
      throw error;
    }
  }

  async function acquire(inputContext) {
    const context = requireOperationalDataPlaneContext(inputContext);
    observeGeneration(context);
    const key = dataPlanePoolKey(context);
    await retirePreviousGenerations(context, key);
    let entry = entries.get(key);
    if (entry?.retiring || entry?.closed) entry = null;
    if (!entry) {
      if (!creating.has(key)) {
        const promise = createEntry(context, key).finally(() => creating.delete(key));
        creating.set(key, promise);
      }
      entry = await creating.get(key);
      safeLog("data_plane_pool_cache_miss", context);
    } else {
      safeLog("data_plane_pool_cache_hit", context);
    }
    if (entry.context.organisationId !== context.organisationId || entry.context.routeId !== context.routeId || entry.context.routeGeneration !== context.routeGeneration) {
      throw new Error("Tenant connection cache isolation invariant failed.");
    }
    entry.active += 1;
    entry.lastUsedAt = now();
    let released = false;
    return Object.freeze({
      pool: entry.pool,
      context: entry.context,
      metadata: entry.metadata,
      async release() {
        if (released) return;
        released = true;
        entry.active = Math.max(0, entry.active - 1);
        entry.lastUsedAt = now();
        if (entry.retiring && entry.active === 0) await finalizeClose(entry, entry.retirementReason || "retired_after_request");
      },
    });
  }

  async function invalidateOrganisation(organisationId, reason = "organisation_invalidated") {
    const matching = [...entries.values()].filter((entry) => entry.context.organisationId === organisationId);
    await Promise.all(matching.map((entry) => retireEntry(entry, reason, { waitForDrain: true })));
  }

  async function retireOrganisation(organisationId, reason = "organisation_retired") {
    const matching = [...entries.values()].filter((entry) => entry.context.organisationId === organisationId);
    await Promise.all(matching.map((entry) => retireEntry(entry, reason)));
  }

  async function invalidateRoute(routeId, reason = "route_invalidated") {
    const matching = [...entries.values()].filter((entry) => entry.context.routeId === routeId);
    await Promise.all(matching.map((entry) => retireEntry(entry, reason, { waitForDrain: true })));
  }

  async function evictIdle() {
    const cutoff = now() - idleTimeoutMs;
    const matching = [...entries.values()].filter((entry) => entry.active === 0 && entry.lastUsedAt <= cutoff);
    await Promise.all(matching.map((entry) => retireEntry(entry, "idle_eviction")));
    return matching.length;
  }

  function metrics() {
    return Object.freeze({
      cachedPools: entries.size,
      creatingPools: creating.size,
      maxPools,
      pools: Object.freeze([...entries.values()].map((entry) => Object.freeze({
        organisationId: entry.context.organisationId,
        routeId: entry.context.routeId,
        routeType: entry.context.routeType,
        routeGeneration: entry.context.routeGeneration,
        activeRequests: entry.active,
        retiring: entry.retiring,
        lastSuccessfulConnectionAt: entry.lastSuccessfulConnectionAt,
        lastFailureCategory: failures.get(entry.key)?.category || null,
      }))),
    });
  }

  return Object.freeze({ acquire, invalidateOrganisation, retireOrganisation, invalidateRoute, evictIdle, metrics });
}
