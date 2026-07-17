import { createDataPlaneContext } from "@claimguard/database";

export class DataPlaneRouteError extends Error {
  constructor(message, code, status = 503) {
    super(message);
    this.name = "DataPlaneRouteError";
    this.code = code;
    this.status = status;
  }
}

const routeFailure = (message, code) => new DataPlaneRouteError(message, code);

export function createControlPlaneDataPlaneRouteResolver({
  repositories,
  supportedSchemaVersions = ["8"],
} = {}) {
  if (!repositories?.organisations || !repositories?.routes || !repositories?.legacyMappings) {
    throw new TypeError("The data-plane route resolver requires control-plane repositories.");
  }

  return Object.freeze({
    async resolve({ organisationId, actorId = null, serviceIdentityId = null, correlationId = null } = {}) {
      if (!organisationId) throw routeFailure("Authenticated organisation is required for operational routing.", "DATA_PLANE_ORGANISATION_REQUIRED");
      const organisation = await repositories.organisations.getById(organisationId);
      if (!organisation || organisation.status !== "active" || organisation.activationState !== "activated") {
        throw routeFailure("The organisation data plane is unavailable.", "DATA_PLANE_ORGANISATION_INACTIVE");
      }
      const routes = await repositories.routes.listInternalActiveForOrganisation(organisation.organisationId);
      if (routes.length !== 1) {
        throw routeFailure("Exactly one active data-plane route is required.", routes.length ? "DATA_PLANE_MULTIPLE_ACTIVE_ROUTES" : "DATA_PLANE_ROUTE_MISSING");
      }
      const route = routes[0];
      if (route.retired_at || route.provisioning_status !== "active" || ["suspended", "unreachable"].includes(route.health_status)) {
        throw routeFailure("The active data-plane route is unavailable.", "DATA_PLANE_ROUTE_INACTIVE");
      }
      if (!["legacy_shared", "private_database", "platform_none"].includes(route.route_type)) {
        throw routeFailure("The active data-plane route type is unsupported.", "DATA_PLANE_ROUTE_UNSUPPORTED");
      }
      if (!Number.isSafeInteger(Number(route.route_generation)) || Number(route.route_generation) < 1) {
        throw routeFailure("The active route generation is invalid.", "DATA_PLANE_ROUTE_GENERATION_INVALID");
      }
      if (organisation.organisationType === "platform" && route.route_type !== "platform_none") {
        throw routeFailure("Platform organisations cannot use private operational routes.", "DATA_PLANE_PLATFORM_ROUTE_INVALID");
      }
      if (organisation.organisationType !== "platform" && route.route_type === "platform_none") {
        throw routeFailure("Medical-scheme organisations require an operational route.", "DATA_PLANE_ROUTE_TYPE_MISMATCH");
      }

      let mapping = null;
      if (route.route_type === "legacy_shared") {
        if (!supportedSchemaVersions.includes(String(route.schema_version || ""))) {
          throw routeFailure("The active route schema version is unsupported.", "DATA_PLANE_SCHEMA_UNSUPPORTED");
        }
        mapping = await repositories.legacyMappings.getByOrganisationId(organisation.organisationId);
        if (!mapping || mapping.migrationStatus !== "verified" || !mapping.verifiedAt || mapping.routeId !== route.route_id) {
          throw routeFailure("A verified legacy tenant mapping is required.", "DATA_PLANE_MAPPING_REQUIRED");
        }
      } else if (route.route_type === "private_database") {
        mapping = {
          legacyTenantId: organisation.organisationId,
          legacyTenantSlug: organisation.canonicalSlug,
        };
      }

        const operationalTenantId = route.route_type === "private_database"
          ? organisation.organisationId
          : mapping?.legacyTenantId || null;
        const operationalTenantSlug = route.route_type === "private_database"
          ? organisation.canonicalSlug || null
          : mapping?.legacyTenantSlug || null;

      return createDataPlaneContext({
        organisationId: organisation.organisationId,
        organisationType: organisation.organisationType,
        organisationStatus: organisation.status,
          operationalTenantId,
          operationalTenantSlug,
        routeId: route.route_id,
        routeType: route.route_type,
        routeGeneration: Number(route.route_generation),
        logicalDatabaseIdentifier: route.logical_database_identifier,
        databaseName: route.database_name || null,
        secretReference: route.secret_reference || null,
        schemaVersion: route.schema_version || null,
        deploymentClass: organisation.deploymentClass,
        region: route.region || null,
        correlationId,
        actorId,
        serviceIdentityId,
      });
    },
  });
}
