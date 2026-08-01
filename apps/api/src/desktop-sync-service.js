import crypto from "node:crypto";

const DESKTOP_SYNC_SCHEMA_VERSION = 1;
const MAXIMUM_PAGE_SIZE = 500;

export class DesktopSyncError extends Error {
  constructor(message, code, status, details = {}) {
    super(message);
    this.name = "DesktopSyncError";
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

function safeLimit(value) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Math.max(1, Math.min(MAXIMUM_PAGE_SIZE, Number.isInteger(parsed) ? parsed : MAXIMUM_PAGE_SIZE));
}

function base64urlJson(value) {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function parseJsonSegment(value) {
  try {
    return JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
  } catch {
    throw new DesktopSyncError("The synchronization cursor is invalid.", "DESKTOP_CURSOR_INVALID", 400, { recovery: "bootstrap" });
  }
}

function createCursorCodec(secret) {
  const key = String(secret || "");
  if (Buffer.byteLength(key, "utf8") < 32) throw new TypeError("A desktop cursor secret of at least 32 bytes is required.");
  return Object.freeze({
    encode(payload) {
      const body = base64urlJson(payload);
      const signature = crypto.createHmac("sha256", key).update(body, "ascii").digest("base64url");
      return `${body}.${signature}`;
    },
    decode(cursor) {
      const [body, signature, extra] = String(cursor || "").split(".");
      if (!body || !signature || extra) {
        throw new DesktopSyncError("The synchronization cursor is invalid.", "DESKTOP_CURSOR_INVALID", 400, { recovery: "bootstrap" });
      }
      const expected = crypto.createHmac("sha256", key).update(body, "ascii").digest();
      let actual;
      try { actual = Buffer.from(signature, "base64url"); } catch { actual = Buffer.alloc(0); }
      if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) {
        throw new DesktopSyncError("The synchronization cursor is invalid.", "DESKTOP_CURSOR_INVALID", 400, { recovery: "bootstrap" });
      }
      return parseJsonSegment(body);
    },
  });
}

function validateSchemaVersion(value) {
  const version = Number.parseInt(String(value ?? DESKTOP_SYNC_SCHEMA_VERSION), 10);
  if (version !== DESKTOP_SYNC_SCHEMA_VERSION) {
    throw new DesktopSyncError(
      "This desktop cache schema is not supported by the server.",
      "DESKTOP_SCHEMA_UNSUPPORTED",
      409,
      { supportedSchemaVersions: [DESKTOP_SYNC_SCHEMA_VERSION] },
    );
  }
  return version;
}

function advanceWatermarks(previous, changes) {
  const next = structuredClone(previous || {});
  for (const change of changes) {
    const resourceKey = change.resource === "claim" ? "claims"
      : change.resource === "investigation" ? "investigations"
        : null;
    if (!resourceKey) continue;
    next[resourceKey] = { updatedAt: new Date(change.updatedAt).toISOString(), id: change.id };
  }
  return next;
}

export function createDesktopSyncService({
  cursorSecret,
  now = () => new Date(),
  cursorLifetimeDays = 30,
  retentionDays = 90,
} = {}) {
  const codec = createCursorCodec(cursorSecret);

  function cursorPayload({ organisationId, tenantId, scopeStart, watermarks }) {
    const issuedAt = now();
    return {
      version: DESKTOP_SYNC_SCHEMA_VERSION,
      organisationId,
      tenantId,
      scopeStart,
      watermarks,
      issuedAt: issuedAt.toISOString(),
      expiresAt: new Date(issuedAt.getTime() + cursorLifetimeDays * 86_400_000).toISOString(),
    };
  }

  async function page({ repository, device, authContext, dataPlaneContext, cursor = null, limit, schemaVersion, bootstrap }) {
    validateSchemaVersion(schemaVersion);
    if (!repository?.listChanges || !repository?.currentProjections) {
      throw new DesktopSyncError("Desktop synchronization is unavailable.", "DESKTOP_SYNC_UNAVAILABLE", 503);
    }
    const organisationId = device?.organisationId;
    const tenantId = dataPlaneContext?.operationalTenantId;
    if (!organisationId || !tenantId || authContext?.organisation_id !== organisationId || dataPlaneContext.organisationId !== organisationId) {
      throw new DesktopSyncError(
        "This account is not authorised for the organisation licensed on this device.",
        "DESKTOP_ORGANISATION_MISMATCH",
        403,
      );
    }
    let state;
    if (bootstrap) {
      const timestamp = now();
      state = cursorPayload({
        organisationId,
        tenantId,
        scopeStart: new Date(timestamp.getTime() - retentionDays * 86_400_000).toISOString(),
        watermarks: {},
      });
    } else {
      state = codec.decode(cursor);
      if (state.version !== DESKTOP_SYNC_SCHEMA_VERSION) validateSchemaVersion(state.version);
      if (new Date(state.expiresAt).getTime() <= now().getTime()) {
        throw new DesktopSyncError(
          "The synchronization cursor has expired; a bounded bootstrap is required.",
          "DESKTOP_CURSOR_EXPIRED",
          410,
          { recovery: "bootstrap" },
        );
      }
      if (state.organisationId !== organisationId || state.tenantId !== tenantId) {
        throw new DesktopSyncError(
          "The synchronization cursor is not valid for this licensed organisation.",
          "DESKTOP_CURSOR_SCOPE_MISMATCH",
          403,
          { recovery: "reset" },
        );
      }
    }
    const pageLimit = safeLimit(limit);
    const result = await repository.listChanges({
      scopeStart: state.scopeStart,
      watermarks: state.watermarks,
      limit: pageLimit,
    });
    const watermarks = advanceWatermarks(state.watermarks, result.changes);
    const nextState = cursorPayload({
      organisationId,
      tenantId,
      scopeStart: state.scopeStart,
      watermarks,
    });
    const projections = await repository.currentProjections();
    return {
      available: true,
      schemaVersion: DESKTOP_SYNC_SCHEMA_VERSION,
      scope: {
        organisationId,
        retentionDays,
        claimsFrom: state.scopeStart,
        activeInvestigationsRegardlessOfAge: true,
      },
      changes: result.changes,
      projections,
      page: {
        limit: pageLimit,
        count: result.changes.length,
        hasMore: Boolean(result.hasMore),
      },
      cursor: codec.encode(nextState),
      freshness: {
        claimsSeconds: 15,
        dashboardSeconds: 60,
        referenceDataSeconds: 3600,
        generatedAt: now().toISOString(),
      },
      referenceMetadata: {
        version: "desktop-reference-v1",
        cacheContainsMinimumNecessaryFields: true,
      },
    };
  }

  return Object.freeze({
    bootstrap(input) {
      return page({ ...input, bootstrap: true });
    },
    changes(input) {
      return page({ ...input, bootstrap: false });
    },
  });
}

export { DESKTOP_SYNC_SCHEMA_VERSION, MAXIMUM_PAGE_SIZE };
