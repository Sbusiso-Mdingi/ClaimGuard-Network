import {
  createDataPlaneContext,
} from "@claimguard/database";


const DEFAULT_SUPPORTED_SCHEMA_VERSIONS =
  Object.freeze([
    "14",
  ]);


export class DataPlaneRouteError
  extends Error {
  constructor(
    message,
    code,
    status = 503,
  ) {
    super(
      message,
    );

    this.name =
      "DataPlaneRouteError";

    this.code =
      code;

    this.status =
      status;
  }
}


function routeFailure(
  message,
  code,
) {
  return new DataPlaneRouteError(
    message,
    code,
  );
}


function normalizeSupportedSchemaVersions(
  values,
) {
  if (
    !Array.isArray(
      values,
    )
  ) {
    throw new TypeError(
      "supportedSchemaVersions must be an array.",
    );
  }

  const normalized =
    [
      ...new Set(
        values
          .map(
            (value) =>
              String(
                value
                ?? "",
              ).trim(),
          )
          .filter(
            Boolean,
          ),
      ),
    ];

  if (
    normalized.length === 0
  ) {
    throw new TypeError(
      "At least one supported data-plane schema version is required.",
    );
  }

  return new Set(
    normalized,
  );
}


export function createControlPlaneDataPlaneRouteResolver({
  repositories,

  supportedSchemaVersions =
    DEFAULT_SUPPORTED_SCHEMA_VERSIONS,
} = {}) {
  if (
    !repositories?.organisations
    || !repositories?.routes
    || !repositories?.legacyMappings
  ) {
    throw new TypeError(
      "The data-plane route resolver requires control-plane repositories.",
    );
  }

  const supportedSchemaVersionSet =
    normalizeSupportedSchemaVersions(
      supportedSchemaVersions,
    );

  return Object.freeze({
    async resolve({
      organisationId,
      actorId = null,
      serviceIdentityId = null,
      correlationId = null,
    } = {}) {
      if (
        !organisationId
      ) {
        throw routeFailure(
          "Authenticated organisation is required for operational routing.",
          "DATA_PLANE_ORGANISATION_REQUIRED",
        );
      }

      const organisation =
        await repositories
          .organisations
          .getById(
            organisationId,
          );

      if (
        !organisation
        || organisation.status
          !== "active"
        || organisation.activationState
          !== "activated"
      ) {
        throw routeFailure(
          "The organisation data plane is unavailable.",
          "DATA_PLANE_ORGANISATION_INACTIVE",
        );
      }

      const routes =
        await repositories
          .routes
          .listInternalActiveForOrganisation(
            organisation
              .organisationId,
          );

      if (
        routes.length !== 1
      ) {
        throw routeFailure(
          "Exactly one active data-plane route is required.",
          routes.length
            ? "DATA_PLANE_MULTIPLE_ACTIVE_ROUTES"
            : "DATA_PLANE_ROUTE_MISSING",
        );
      }

      const route =
        routes[0];

      if (
        route.retired_at
        || route.provisioning_status
          !== "active"
        || [
          "suspended",
          "unreachable",
        ].includes(
          route.health_status,
        )
      ) {
        throw routeFailure(
          "The active data-plane route is unavailable.",
          "DATA_PLANE_ROUTE_INACTIVE",
        );
      }

      if (
        ![
          "legacy_shared",
          "private_database",
          "platform_none",
        ].includes(
          route.route_type,
        )
      ) {
        throw routeFailure(
          "The active data-plane route type is unsupported.",
          "DATA_PLANE_ROUTE_UNSUPPORTED",
        );
      }

      const routeGeneration =
        Number(
          route.route_generation,
        );

      if (
        !Number.isSafeInteger(
          routeGeneration,
        )
        || routeGeneration < 1
      ) {
        throw routeFailure(
          "The active route generation is invalid.",
          "DATA_PLANE_ROUTE_GENERATION_INVALID",
        );
      }

      if (
        organisation
          .organisationType
          === "platform"
        && route.route_type
          !== "platform_none"
      ) {
        throw routeFailure(
          "Platform organisations cannot use private operational routes.",
          "DATA_PLANE_PLATFORM_ROUTE_INVALID",
        );
      }

      if (
        organisation
          .organisationType
          !== "platform"
        && route.route_type
          === "platform_none"
      ) {
        throw routeFailure(
          "Medical-scheme organisations require an operational route.",
          "DATA_PLANE_ROUTE_TYPE_MISMATCH",
        );
      }

      const isOperationalRoute =
        route.route_type
        !== "platform_none";

      const schemaVersion =
        isOperationalRoute
          ? String(
            route.schema_version
            ?? "",
          ).trim()
          : null;

      if (
        isOperationalRoute
        && !supportedSchemaVersionSet
          .has(
            schemaVersion,
          )
      ) {
        throw routeFailure(
          "The active route schema version is unsupported.",
          "DATA_PLANE_SCHEMA_UNSUPPORTED",
        );
      }

      let mapping =
        null;

      if (
        route.route_type
        === "legacy_shared"
      ) {
        mapping =
          await repositories
            .legacyMappings
            .getByOrganisationId(
              organisation
                .organisationId,
            );

        if (
          !mapping
          || mapping.migrationStatus
            !== "verified"
          || !mapping.verifiedAt
          || mapping.routeId
            !== route.route_id
        ) {
          throw routeFailure(
            "A verified legacy tenant mapping is required.",
            "DATA_PLANE_MAPPING_REQUIRED",
          );
        }
      } else if (
        route.route_type
        === "private_database"
      ) {
        mapping = {
          legacyTenantId:
            organisation
              .organisationId,

          legacyTenantSlug:
            organisation
              .canonicalSlug,
        };
      }

      const operationalTenantId =
        route.route_type
          === "private_database"
          ? organisation
            .organisationId
          : mapping
            ?.legacyTenantId
            || null;

      const operationalTenantSlug =
        route.route_type
          === "private_database"
          ? organisation
            .canonicalSlug
            || null
          : mapping
            ?.legacyTenantSlug
            || null;

      return createDataPlaneContext({
        organisationId:
          organisation
            .organisationId,

        organisationType:
          organisation
            .organisationType,

        organisationStatus:
          organisation.status,

        operationalTenantId,
        operationalTenantSlug,

        routeId:
          route.route_id,

        routeType:
          route.route_type,

        routeGeneration,

        logicalDatabaseIdentifier:
          route
            .logical_database_identifier,

        databaseName:
          route.database_name
          || null,

        secretReference:
          route.secret_reference
          || null,

        schemaVersion,

        deploymentClass:
          organisation
            .deploymentClass,

        region:
          route.region
          || null,

        correlationId,
        actorId,
        serviceIdentityId,
      });
    },
  });
}
