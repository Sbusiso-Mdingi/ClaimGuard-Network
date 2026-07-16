const ROUTE_TYPES = new Set(["legacy_shared", "platform_none"]);
const ORGANISATION_TYPES = new Set(["medical_scheme", "platform"]);

export class DataPlaneContextValidationError extends Error {
  constructor(message, code = "DATA_PLANE_CONTEXT_INVALID") {
    super(message);
    this.name = "DataPlaneContextValidationError";
    this.code = code;
    this.status = 503;
  }
}

function required(value, name) {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!normalized) throw new DataPlaneContextValidationError(`${name} is required.`);
  return normalized;
}

function optional(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export function createDataPlaneContext(input = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new DataPlaneContextValidationError("DataPlaneContext input is required.");
  const organisationId = required(input.organisationId, "organisationId");
  const organisationType = required(input.organisationType, "organisationType");
  const routeId = required(input.routeId, "routeId");
  const routeType = required(input.routeType, "routeType");
  const routeGeneration = Number(input.routeGeneration);
  if (!ORGANISATION_TYPES.has(organisationType)) throw new DataPlaneContextValidationError("Unsupported organisation type.");
  if (!ROUTE_TYPES.has(routeType)) throw new DataPlaneContextValidationError("Unsupported active route type.", "DATA_PLANE_ROUTE_UNSUPPORTED");
  if (!Number.isSafeInteger(routeGeneration) || routeGeneration < 1) throw new DataPlaneContextValidationError("routeGeneration must be a positive integer.");
  if (input.organisationStatus !== "active") throw new DataPlaneContextValidationError("Organisation is not active.", "DATA_PLANE_ORGANISATION_INACTIVE");

  const operationalTenantId = optional(input.operationalTenantId);
  const operationalTenantSlug = optional(input.operationalTenantSlug);
  if (routeType === "legacy_shared" && (!operationalTenantId || !operationalTenantSlug)) {
    throw new DataPlaneContextValidationError("A verified legacy tenant mapping is required.", "DATA_PLANE_MAPPING_REQUIRED");
  }
  if (routeType === "platform_none" && (organisationType !== "platform" || operationalTenantId || input.databaseName)) {
    throw new DataPlaneContextValidationError("Platform routes cannot contain private operational routing metadata.", "DATA_PLANE_PLATFORM_ROUTE_INVALID");
  }

  return Object.freeze({
    organisationId,
    organisationType,
    organisationStatus: input.organisationStatus,
    operationalTenantId,
    operationalTenantSlug,
    routeId,
    routeType,
    routeGeneration,
    logicalDatabaseIdentifier: required(input.logicalDatabaseIdentifier, "logicalDatabaseIdentifier"),
    databaseName: optional(input.databaseName),
    schemaVersion: routeType === "platform_none" ? null : required(input.schemaVersion, "schemaVersion"),
    deploymentClass: required(input.deploymentClass, "deploymentClass"),
    region: optional(input.region),
    correlationId: optional(input.correlationId),
    actorId: optional(input.actorId),
    serviceIdentityId: optional(input.serviceIdentityId),
  });
}

export function dataPlanePoolKey(context) {
  const verified = createDataPlaneContext(context);
  return `${verified.organisationId}:${verified.routeId}:${verified.routeGeneration}`;
}

export function requireOperationalDataPlaneContext(context) {
  const verified = createDataPlaneContext(context);
  if (verified.routeType !== "legacy_shared" || !verified.operationalTenantId) {
    throw new DataPlaneContextValidationError("This organisation has no private operational data plane.", "DATA_PLANE_NOT_AVAILABLE");
  }
  return verified;
}
