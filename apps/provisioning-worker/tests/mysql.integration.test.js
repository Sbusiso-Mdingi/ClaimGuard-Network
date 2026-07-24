import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";

import mysql from "mysql2/promise";
import {
  applyControlPlaneMigrations,
  createControlPlanePool,
  createControlPlaneRepositories,
  createControlPlaneService,
} from "@claimguard/control-plane-database";

import {
  CANONICAL_OPERATIONAL_SCHEMA_VERSION,
  runProvisioningBatch,
} from "../src/worker.js";


const controlUrl =
  process.env
    .PHASE11E_CONTROL_PLANE_MYSQL_URL
  || "";

const adminUrl =
  process.env
    .PHASE11E_MYSQL_SERVER_ADMIN_URL
  || "";

const integration =
  controlUrl && adminUrl
    ? test
    : test.skip;


const approvedEnvironment =
  Object.freeze({
    AZURE_APPROVED_SUBSCRIPTION_ID:
      "00000000-0000-0000-0000-000000000011",

    AZURE_APPROVED_RESOURCE_GROUP:
      "ClaimGuard-Test",

    AZURE_APPROVED_MYSQL_SERVER:
      "claimguard-test",

    AZURE_APPROVED_KEYVAULT:
      "claimguard-test-kv",

    AZURE_APPROVED_STORAGE_ACCOUNT:
      "claimguardtestreports",

    AZURE_APPROVED_REPORT_CONTAINER:
      "reports",

    AZURE_APPROVED_REGION:
      "southafricanorth",

    AZURE_APPROVED_ENVIRONMENT_KEY:
      "test",

    PRIVATE_TENANT_SCHEMA_VERSION:
      CANONICAL_OPERATIONAL_SCHEMA_VERSION,

    PROVISIONING_ALLOW_ENV_SECRET_FALLBACK:
      "true",

    PROVISIONING_MAX_OPERATIONS:
      "1",
  });


function databaseName(
  canonicalSlug,
) {
  const safeSlug =
    canonicalSlug
      .replace(
        /[^a-zA-Z0-9]+/g,
        "_",
      )
      .replace(
        /^_+|_+$/g,
        "",
      )
      .toLowerCase()
      .slice(
        0,
        40,
      );

  return (
    "claimguard_tenant_"
    + safeSlug
  );
}


function credentialUsername(
  organisationId,
) {
  const safeId =
    organisationId
      .replace(
        /[^a-zA-Z0-9]/g,
        "",
      )
      .toLowerCase()
      .slice(
        0,
        20,
      );

  return (
    "cg_runtime_"
    + safeId
  );
}


function fallbackSecretName(
  organisationId,
  suffix,
) {
  const secret =
    (
      "claimguard--tenant--"
      + organisationId
        .toLowerCase()
      + "--"
      + suffix
    );

  return (
    "CLAIMGUARD_PROVISIONING_SECRET_"
    + secret
      .toUpperCase()
      .replace(
        /[^A-Z0-9]/g,
        "_",
      )
  );
}


function snapshotEnvironment(
  keys,
) {
  return new Map(
    keys.map(
      (key) => [
        key,
        process.env[key],
      ],
    ),
  );
}


function restoreEnvironment(
  snapshot,
) {
  for (
    const [
      key,
      value,
    ]
    of snapshot
  ) {
    if (
      value === undefined
    ) {
      delete process.env[key];
    } else {
      process.env[key] =
        value;
    }
  }
}


async function createOrganisation(
  service,
  repositories,
  {
    slug,
    withAdministrator,
  },
) {
  const actor = {
    type:
      "system",

    id:
      null,

    source:
      "phase11e-integration",
  };

  const organisation =
    await service
      .createDraftOrganisation(
        {
          displayName:
            `${slug} Medical Scheme`,

          canonicalSlug:
            slug,

          organisationType:
            "medical_scheme",

          deploymentClass:
            "demo",
        },
        actor,
      );

  if (
    withAdministrator
  ) {
    const user =
      await repositories
        .identity
        .createUser({
          displayName:
            `${slug} Administrator`,

          canonicalContact:
            `${slug}@example.invalid`,

          status:
            "invited",
        });

    const membership =
      await service
        .createMembership(
          {
            userId:
              user.userId,

            organisationId:
              organisation
                .organisationId,

            status:
              "active",
          },
          actor,
        );

    await service
      .assignMembershipRole(
        {
          membershipId:
            membership
              .membershipId,

          roleKey:
            "scheme_administrator",
        },
        actor,
      );
  }

  const operation =
    await service
      .requestProvisioningOperation(
        {
          organisationId:
            organisation
              .organisationId,

          requestedBy:
            "phase11e-integration",
        },
        actor,
      );

  return {
    organisation,
    operation,
  };
}


async function addAdministrator(
  service,
  repositories,
  organisation,
  slug,
) {
  const actor = {
    type:
      "system",

    id:
      null,

    source:
      "phase11e-integration",
  };

  const user =
    await repositories
      .identity
      .createUser({
        displayName:
          `${slug} Retry Administrator`,

        canonicalContact:
          `${slug}-retry@example.invalid`,

        status:
          "invited",
      });

  const membership =
    await service
      .createMembership(
        {
          userId:
            user.userId,

          organisationId:
            organisation
              .organisationId,

          status:
            "active",
        },
        actor,
      );

  await service
    .assignMembershipRole(
      {
        membershipId:
          membership
            .membershipId,

        roleKey:
          "scheme_administrator",
      },
      actor,
    );
}


integration(
  "real MySQL onboarding applies schema 14, isolates tenants, retries safely, and leaves routes inactive",
  async () => {
    const environmentKeys = [
      ...Object.keys(
        approvedEnvironment,
      ),
      "CONTROL_PLANE_MYSQL_URL",
      "MYSQL_SERVER_ADMIN_URL",
      "PROVISIONING_KEYVAULT_URI",
    ];

    const previousEnvironment =
      snapshotEnvironment(
        environmentKeys,
      );

    Object.assign(
      process.env,
      approvedEnvironment,
      {
        CONTROL_PLANE_MYSQL_URL:
          controlUrl,

        MYSQL_SERVER_ADMIN_URL:
          adminUrl,
      },
    );

    delete process.env
      .PROVISIONING_KEYVAULT_URI;

    const runSuffix =
      crypto
        .randomUUID()
        .replaceAll(
          "-",
          "",
        )
        .slice(
          0,
          8,
        );

    const firstSlug =
      `phase11e-first-${runSuffix}`;

    const secondSlug =
      `phase11e-retry-${runSuffix}`;

    const legacySlug =
      `phase11e-legacy-${runSuffix}`;

    const isolationDatabase =
      `claimguard_isolation_${runSuffix}`;

    const controlPool =
      createControlPlanePool(
        controlUrl,
      );

    const adminPool =
      mysql.createPool(
        adminUrl,
      );

    const repositories =
      createControlPlaneRepositories(
        controlPool,
      );

    const service =
      createControlPlaneService({
        pool:
          controlPool,

        repositories,
      });

    const legacyOrganisationId =
      crypto.randomUUID();

    let first;
    let second;

    let generatedDatabases = [];
    let generatedUsers = [];

    try {
      try {
        await applyControlPlaneMigrations(
          controlPool,
          {
            applicationVersion:
              "phase11e-integration",
          },
        );
      } catch (
        error
      ) {
        throw new Error(
          (
            "Control-plane migration "
            + "setup failed: "
            + (
              error.code
              || error.name
            )
          ),
          {
            cause:
              error,
          },
        );
      }

      /*
       * Create a real database outside every tenant's
       * grant scope. The generated runtime principal
       * must not be able to read it.
       */
      await adminPool.query(
        `
          CREATE DATABASE IF NOT EXISTS
            \`${isolationDatabase}\`
        `,
      );

      await adminPool.query(
        `
          CREATE TABLE IF NOT EXISTS
            \`${isolationDatabase}\`
            .data_plane_metadata (
              marker
                VARCHAR(64)
                NOT NULL
            )
        `,
      );

      first =
        await createOrganisation(
          service,
          repositories,
          {
            slug:
              firstSlug,

            withAdministrator:
              true,
          },
        );

      second =
        await createOrganisation(
          service,
          repositories,
          {
            slug:
              secondSlug,

            withAdministrator:
              false,
          },
        );

      generatedDatabases = [
        databaseName(
          first
            .organisation
            .canonicalSlug,
        ),
        databaseName(
          second
            .organisation
            .canonicalSlug,
        ),
      ];

      generatedUsers = [
        credentialUsername(
          first
            .organisation
            .organisationId,
        ),
        credentialUsername(
          second
            .organisation
            .organisationId,
        ),
      ];

      /*
       * Preserve an existing legacy route and verify
       * that private provisioning never mutates or
       * replaces it.
       */
      await controlPool.execute(
        `
          INSERT INTO organisations (
            organisation_id,
            display_name,
            canonical_slug,
            organisation_type,
            deployment_class,
            status,
            activation_state
          )
          VALUES (
            ?,
            'Legacy Regression Scheme',
            ?,
            'medical_scheme',
            'demo',
            'active',
            'activated'
          )
        `,
        [
          legacyOrganisationId,
          legacySlug,
        ],
      );

      await controlPool.execute(
        `
          INSERT INTO data_plane_routes (
            route_id,
            organisation_id,
            route_type,
            logical_database_identifier,
            database_name,
            secret_reference,
            region,
            route_generation,
            schema_version,
            provisioning_status,
            health_status,
            active_at,
            active_route_slot
          )
          VALUES (
            ?,
            ?,
            'legacy_shared',
            'legacy-operational-shared',
            'legacy',
            'secret://runtime/MYSQL_URL',
            'southafricanorth',
            1,
            '8',
            'active',
            'healthy',
            UTC_TIMESTAMP(3),
            ?
          )
        `,
        [
          crypto.randomUUID(),
          legacyOrganisationId,
          legacyOrganisationId,
        ],
      );

      /*
       * The first organisation has an administrator,
       * so its operation must complete in one lease.
       */
      const firstRun =
        await runProvisioningBatch({
          maxOperations:
            1,
        });

      assert.equal(
        firstRun.processed,
        1,
      );

      const firstOperation =
        await repositories
          .provisioning
          .getOperation(
            first
              .operation
              .operationId,
          );

      assert.equal(
        firstOperation.status,
        "completed",
      );

      assert.equal(
        firstOperation
          .leaseToken,
        null,
      );

      const firstOrganisation =
        await repositories
          .organisations
          .getById(
            first
              .organisation
              .organisationId,
          );

      assert.equal(
        firstOrganisation.status,
        "ready_for_activation",
      );

      /*
       * The provisioned private database must expose
       * canonical schema and migration version 14.
       */
      const [
        firstMetadata,
      ] =
        await adminPool.execute(
          `
            SELECT
              database_mode,
              logical_database_identifier,
              schema_version,
              environment_key,
              migration_version
            FROM
              \`${generatedDatabases[0]}\`
              .data_plane_metadata
            WHERE metadata_key =
              'primary'
          `,
        );

      assert.equal(
        firstMetadata.length,
        1,
      );

      assert.deepEqual(
        {
          databaseMode:
            firstMetadata[0]
              .database_mode,

          logicalDatabaseIdentifier:
            firstMetadata[0]
              .logical_database_identifier,

          schemaVersion:
            String(
              firstMetadata[0]
                .schema_version,
            ),

          environmentKey:
            firstMetadata[0]
              .environment_key,

          migrationVersion:
            Number(
              firstMetadata[0]
                .migration_version,
            ),
        },
        {
          databaseMode:
            "private_database",

          logicalDatabaseIdentifier:
            (
              "private:"
              + first
                .organisation
                .organisationId
            ),

          schemaVersion:
            CANONICAL_OPERATIONAL_SCHEMA_VERSION,

          environmentKey:
            "test",

          migrationVersion:
            Number(
              CANONICAL_OPERATIONAL_SCHEMA_VERSION,
            ),
        },
      );

      const [
        migrationRows,
      ] =
        await adminPool.execute(
          `
            SELECT
              COUNT(*) AS count
            FROM
              \`${generatedDatabases[0]}\`
              .operational_migration_history
          `,
        );

      assert.equal(
        Number(
          migrationRows[0]
            .count,
        ),
        14,
      );

      /*
       * Confirm that provisioning applied the actual
       * prospective schema rather than only changing
       * the metadata marker.
       */
      const [
        prospectiveColumns,
      ] =
        await adminPool.execute(
          `
            SELECT
              table_name AS tableName,
              column_name AS columnName,
              is_nullable AS isNullable
            FROM information_schema.columns
            WHERE table_schema = ?
              AND (
                (
                  table_name =
                    'claims'
                  AND column_name =
                    'current_claim_version'
                )
                OR
                (
                  table_name =
                    'claim_detection_results'
                  AND column_name IN (
                    'tenant_id',
                    'claim_id',
                    'claim_version',
                    'detection_strategy_id',
                    'source_job_id',
                    'result_payload',
                    'result_hash'
                  )
                )
              )
            ORDER BY
              table_name,
              ordinal_position
          `,
          [
            generatedDatabases[0],
          ],
        );

      const prospectiveColumnNames =
        new Set(
          prospectiveColumns.map(
            ({
              tableName,
              columnName,
            }) =>
              `${tableName}.${columnName}`,
          ),
        );

      for (
        const expectedColumn
        of [
          "claims.current_claim_version",
          "claim_detection_results.tenant_id",
          "claim_detection_results.claim_id",
          "claim_detection_results.claim_version",
          "claim_detection_results.detection_strategy_id",
          "claim_detection_results.source_job_id",
          "claim_detection_results.result_payload",
          "claim_detection_results.result_hash",
        ]
      ) {
        assert.equal(
          prospectiveColumnNames.has(
            expectedColumn,
          ),
          true,
          (
            "Missing provisioned schema-14 column "
            + expectedColumn
            + "."
          ),
        );
      }

      const currentVersionColumn =
        prospectiveColumns.find(
          ({
            tableName,
            columnName,
          }) =>
            (
              tableName === "claims"
              && columnName
                === "current_claim_version"
            ),
        );

      assert.ok(
        currentVersionColumn,
      );

      assert.equal(
        currentVersionColumn
          .isNullable,
        "NO",
      );

      /*
       * The private route is registered as ready but
       * remains inactive until explicit activation.
       */
      const [
        privateRoutes,
      ] =
        await controlPool.execute(
          `
            SELECT
              route_type,
              logical_database_identifier,
              schema_version,
              provisioning_status,
              active_route_slot
            FROM data_plane_routes
            WHERE organisation_id = ?
              AND route_type =
                'private_database'
          `,
          [
            first
              .organisation
              .organisationId,
          ],
        );

      assert.equal(
        privateRoutes.length,
        1,
      );

      assert.deepEqual(
        {
          routeType:
            privateRoutes[0]
              .route_type,

          logicalDatabaseIdentifier:
            privateRoutes[0]
              .logical_database_identifier,

          schemaVersion:
            String(
              privateRoutes[0]
                .schema_version,
            ),

          provisioningStatus:
            privateRoutes[0]
              .provisioning_status,

          activeRouteSlot:
            privateRoutes[0]
              .active_route_slot,
        },
        {
          routeType:
            "private_database",

          logicalDatabaseIdentifier:
            (
              "private:"
              + first
                .organisation
                .organisationId
            ),

          schemaVersion:
            CANONICAL_OPERATIONAL_SCHEMA_VERSION,

          provisioningStatus:
            "ready",

          activeRouteSlot:
            null,
        },
      );

      /*
       * Verify deterministic secret names and connect
       * as the generated runtime principal.
       */
      const usernameSecret =
        process.env[
          fallbackSecretName(
            first
              .organisation
              .organisationId,
            "mysql-username",
          )
        ];

      const passwordSecret =
        process.env[
          fallbackSecretName(
            first
              .organisation
              .organisationId,
            "mysql-password",
          )
        ];

      assert.equal(
        usernameSecret,
        generatedUsers[0],
      );

      assert.ok(
        passwordSecret,
      );

      const tenantUrl =
        new URL(
          adminUrl,
        );

      tenantUrl.pathname =
        `/${generatedDatabases[0]}`;

      tenantUrl.username =
        usernameSecret;

      tenantUrl.password =
        passwordSecret;

      const tenantConnection =
        await mysql
          .createConnection(
            tenantUrl.toString(),
          );

      try {
        await assert.rejects(
          () =>
            tenantConnection.query(
              `
                SELECT *
                FROM
                  \`${isolationDatabase}\`
                  .data_plane_metadata
              `,
            ),
          (
            error,
          ) =>
            [
              "ER_DBACCESS_DENIED_ERROR",
              "ER_TABLEACCESS_DENIED_ERROR",
              "ER_ACCESS_DENIED_ERROR",
            ].includes(
              error.code,
            ),
        );
      } finally {
        await tenantConnection.end();
      }

      /*
       * The second organisation intentionally has no
       * administrator, so provisioning fails safely.
       */
      const secondRun =
        await runProvisioningBatch({
          maxOperations:
            1,
        });

      assert.equal(
        secondRun.processed,
        1,
      );

      assert.equal(
        (
          await repositories
            .provisioning
            .getOperation(
              second
                .operation
                .operationId,
            )
        ).status,
        "failed",
      );

      const retryPasswordBefore =
        process.env[
          fallbackSecretName(
            second
              .organisation
              .organisationId,
            "mysql-password",
          )
        ];

      assert.ok(
        retryPasswordBefore,
      );

      await addAdministrator(
        service,
        repositories,
        second.organisation,
        secondSlug,
      );

      const retried =
        await service
          .retryProvisioningOperation(
            second
              .operation
              .operationId,
            {
              type:
                "system",

              id:
                null,
            },
          );

      assert.equal(
        retried.status,
        "pending",
      );

      const retryRun =
        await runProvisioningBatch({
          maxOperations:
            1,
        });

      assert.equal(
        retryRun.processed,
        1,
      );

      assert.equal(
        (
          await repositories
            .provisioning
            .getOperation(
              second
                .operation
                .operationId,
            )
        ).status,
        "completed",
      );

      assert.equal(
        process.env[
          fallbackSecretName(
            second
              .organisation
              .organisationId,
            "mysql-password",
          )
        ],
        retryPasswordBefore,
      );

      /*
       * Private provisioning must not retire or
       * rewrite an existing active legacy route.
       */
      const [
        legacyRoutes,
      ] =
        await controlPool.execute(
          `
            SELECT
              route_type,
              provisioning_status,
              active_route_slot
            FROM data_plane_routes
            WHERE organisation_id = ?
          `,
          [
            legacyOrganisationId,
          ],
        );

      assert.equal(
        legacyRoutes.length,
        1,
      );

      assert.equal(
        legacyRoutes[0]
          .route_type,
        "legacy_shared",
      );

      assert.equal(
        legacyRoutes[0]
          .provisioning_status,
        "active",
      );

      assert.equal(
        legacyRoutes[0]
          .active_route_slot,
        legacyOrganisationId,
      );
    } finally {
      for (
        const username
        of generatedUsers
      ) {
        await adminPool.query(
          `
            DROP USER IF EXISTS
              '${username}'@'%'
          `,
        );
      }

      for (
        const name
        of generatedDatabases
      ) {
        await adminPool.query(
          `
            DROP DATABASE IF EXISTS
              \`${name}\`
          `,
        );
      }

      await adminPool.query(
        `
          DROP DATABASE IF EXISTS
            \`${isolationDatabase}\`
        `,
      );

      await Promise.allSettled([
        adminPool.end(),
        controlPool.end(),
      ]);

      restoreEnvironment(
        previousEnvironment,
      );
    }
  },
);
