import assert from "node:assert/strict";
import test from "node:test";
import {
  randomUUID,
} from "node:crypto";

import {
  applyMigrations,
  CLAIM_PROCESSING_DATASET_SCOPE,
  CLAIM_PROCESSING_JOB_TYPE,
  CLAIM_PROCESSING_PAYLOAD_SCHEMA_VERSION,
  createLegacySharedAdapter,
  createMysqlConnection,
  createTenantConnectionManager,
  dataPlanePoolKey,
  getOperationalMigrationStatus,
} from "@claimguard/database";

import {
  applyControlPlaneMigrations,
  createControlPlaneAuthenticationService,
  createControlPlanePool,
  createControlPlaneRepositories,
  createControlPlaneService,
  getControlPlaneMigrationStatus,
  provisionDemoAccounts,
  readLegacyTenantInventory,
} from "@claimguard/control-plane-database";

import {
  resolveAuthenticationConfiguration,
} from "../src/authentication-config.js";

import {
  createBackendApp,
} from "../src/backend.js";

import {
  createControlPlaneDataPlaneRouteResolver,
} from "../src/data-plane-route-resolver.js";

import {
  createCanonicalDetectionReport,
} from "./helpers/detection-report.js";


const controlUrl =
  process.env
    .PHASE11D_CONTROL_PLANE_MYSQL_URL
  || "";

const operationalUrl =
  process.env.PHASE11D_MYSQL_URL
  || "";

const enabled =
  Boolean(
    controlUrl
    && operationalUrl,
  );

const TEST_TENANTS = [
  "tenant_alpha",
  "tenant_beta",
];

const ALPHA_NEW_CLAIM_ID =
  `ALPHA-CLAIM-NEW-${randomUUID()}`;


function cookieFrom(
  response,
) {
  return (
    response.headers
      .get("set-cookie")
      ?.split(";", 1)[0]
    || ""
  );
}


function modelClaimFields(
  serviceDate,
) {
  return {
    received_date:
      serviceDate,

    quantity: 1,

    benefit_option:
      "COMPREHENSIVE",

    network_type:
      "IN_NETWORK",

    line_type:
      "PROFESSIONAL",

    tariff_discipline:
      "MEDICAL",

    diagnosis_code:
      "Z00.0",

    rendering_practitioner_id:
      null,

    rendering_practitioner_category:
      "NONE",

    rendering_known_to_billing_provider:
      false,
  };
}


function claimSubmission({
  claimId =
    ALPHA_NEW_CLAIM_ID,

  amount = 303,

  serviceDate =
    "2026-07-02",
} = {}) {
  return {
    claim_id:
      claimId,

    scheme_id:
      "ALPHA01",

    member_id:
      "ALPHA-MEMBER-1",

    provider_id:
      "ALPHA-PROVIDER-1",

    service_date:
      serviceDate,

    billing_code:
      "GP03",

    amount,

    ...modelClaimFields(
      serviceDate,
    ),
  };
}


function baselineClaim({
  claimId,
  schemeId,
  memberId,
  providerId,
  serviceDate,
  billingCode,
  amount,
  tenantId,
}) {
  return {
    claim_id:
      claimId,

    scheme_id:
      schemeId,

    member_id:
      memberId,

    provider_id:
      providerId,

    service_date:
      serviceDate,

    received_date:
      serviceDate,

    billing_code:
      billingCode,

    amount,

    quantity: 1,

    benefit_option:
      "COMPREHENSIVE",

    network_type:
      "IN_NETWORK",

    line_type:
      "PROFESSIONAL",

    tariff_discipline:
      "MEDICAL",

    diagnosis_code:
      "Z00.0",

    rendering_practitioner_id:
      null,

    rendering_practitioner_category:
      "NONE",

    rendering_known_to_billing_provider:
      false,

    tenant_id:
      tenantId,
  };
}


function parseJsonColumn(
  value,
) {
  if (Buffer.isBuffer(value)) {
    return JSON.parse(
      value.toString("utf8"),
    );
  }

  if (
    typeof value
    === "string"
  ) {
    return JSON.parse(
      value,
    );
  }

  return value;
}


async function insertBaselineClaim(
  pool,
  claim,
) {
  await pool.execute(
    `
      INSERT INTO claims (
        claim_id,
        current_claim_version,
        scheme_id,
        member_id,
        provider_id,
        service_date,
        received_date,
        billing_code,
        amount,
        quantity,
        benefit_option,
        network_type,
        line_type,
        tariff_discipline,
        diagnosis_code,
        rendering_practitioner_id,
        rendering_practitioner_category,
        rendering_known_to_billing_provider,
        tenant_id
      )
      VALUES (
        ?,
        1,
        ?,
        ?,
        ?,
        ?,
        ?,
        ?,
        ?,
        ?,
        ?,
        ?,
        ?,
        ?,
        ?,
        ?,
        ?,
        ?,
        ?
      )
      ON DUPLICATE KEY UPDATE
        current_claim_version =
          VALUES(current_claim_version),
        scheme_id =
          VALUES(scheme_id),
        member_id =
          VALUES(member_id),
        provider_id =
          VALUES(provider_id),
        service_date =
          VALUES(service_date),
        received_date =
          VALUES(received_date),
        billing_code =
          VALUES(billing_code),
        amount =
          VALUES(amount),
        quantity =
          VALUES(quantity),
        benefit_option =
          VALUES(benefit_option),
        network_type =
          VALUES(network_type),
        line_type =
          VALUES(line_type),
        tariff_discipline =
          VALUES(tariff_discipline),
        diagnosis_code =
          VALUES(diagnosis_code),
        rendering_practitioner_id =
          VALUES(rendering_practitioner_id),
        rendering_practitioner_category =
          VALUES(
            rendering_practitioner_category
          ),
        rendering_known_to_billing_provider =
          VALUES(
            rendering_known_to_billing_provider
          ),
        tenant_id =
          VALUES(tenant_id)
    `,
    [
      claim.claim_id,
      claim.scheme_id,
      claim.member_id,
      claim.provider_id,
      claim.service_date,
      claim.received_date,
      claim.billing_code,
      claim.amount,
      claim.quantity,
      claim.benefit_option,
      claim.network_type,
      claim.line_type,
      claim.tariff_discipline,
      claim.diagnosis_code,
      claim.rendering_practitioner_id,
      claim
        .rendering_practitioner_category,
      claim
        .rendering_known_to_billing_provider,
      claim.tenant_id,
    ],
  );

  const payload = {
    claim_id:
      claim.claim_id,

    scheme_id:
      claim.scheme_id,

    member_id:
      claim.member_id,

    provider_id:
      claim.provider_id,

    service_date:
      claim.service_date,

    received_date:
      claim.received_date,

    billing_code:
      claim.billing_code,

    amount:
      claim.amount,

    quantity:
      claim.quantity,

    benefit_option:
      claim.benefit_option,

    network_type:
      claim.network_type,

    line_type:
      claim.line_type,

    tariff_discipline:
      claim.tariff_discipline,

    diagnosis_code:
      claim.diagnosis_code,

    rendering_practitioner_id:
      claim
        .rendering_practitioner_id,

    rendering_practitioner_category:
      claim
        .rendering_practitioner_category,

    rendering_known_to_billing_provider:
      claim
        .rendering_known_to_billing_provider,
  };

  await pool.execute(
    `
      INSERT IGNORE INTO claim_versions (
        tenant_id,
        claim_id,
        claim_version,
        scheme_id,
        member_id,
        provider_id,
        service_date,
        received_date,
        billing_code,
        amount,
        claim_payload,
        payload_hash,
        version_reason
      )
      VALUES (
        ?,
        ?,
        1,
        ?,
        ?,
        ?,
        ?,
        ?,
        ?,
        ?,
        ?,
        NULL,
        'legacy_baseline'
      )
    `,
    [
      claim.tenant_id,
      claim.claim_id,
      claim.scheme_id,
      claim.member_id,
      claim.provider_id,
      claim.service_date,
      claim.received_date,
      claim.billing_code,
      claim.amount,
      JSON.stringify(
        payload,
      ),
    ],
  );
}


async function seedOperationalFixtures(
  pool,
) {
  /*
   * Remove only prospective jobs left behind by an
   * interrupted execution. Historical claim versions
   * are not deleted.
   */
  await pool.execute(
    `
      DELETE FROM claim_processing_outbox
      WHERE tenant_id IN (
        'tenant_alpha',
        'tenant_beta'
      )
        AND job_type =
          'claim_detection'
    `,
  );

  await pool.execute(
    `
      INSERT INTO tenants (
        tenant_id,
        tenant_slug,
        tenant_name,
        status
      )
      VALUES
        (
          'tenant_alpha',
          'alpha',
          'Tenant Alpha',
          'active'
        ),
        (
          'tenant_beta',
          'beta',
          'Tenant Beta',
          'active'
        )
      ON DUPLICATE KEY UPDATE
        tenant_slug =
          VALUES(tenant_slug),
        tenant_name =
          VALUES(tenant_name),
        status =
          VALUES(status)
    `,
  );

  await pool.execute(
    `
      INSERT INTO schemes (
        scheme_id,
        scheme_name,
        tenant_id
      )
      VALUES
        (
          'ALPHA01',
          'Alpha Scheme',
          'tenant_alpha'
        ),
        (
          'BETA01',
          'Beta Scheme',
          'tenant_beta'
        )
      ON DUPLICATE KEY UPDATE
        scheme_name =
          VALUES(scheme_name),
        tenant_id =
          VALUES(tenant_id)
    `,
  );

  await pool.execute(
    `
      INSERT INTO medical_schemes (
        tenant_id,
        scheme_id,
        scheme_name,
        is_primary
      )
      VALUES
        (
          'tenant_alpha',
          'ALPHA01',
          'Alpha Scheme',
          1
        ),
        (
          'tenant_beta',
          'BETA01',
          'Beta Scheme',
          1
        )
      ON DUPLICATE KEY UPDATE
        scheme_name =
          VALUES(scheme_name),
        is_primary =
          VALUES(is_primary)
    `,
  );

  await pool.execute(
    `
      INSERT INTO members (
        member_id,
        scheme_id,
        first_name,
        last_name,
        date_of_birth,
        gender,
        identity_number,
        banking_detail,
        home_region,
        home_lat,
        home_lon,
        join_date,
        tenant_id
      )
      VALUES
        (
          'ALPHA-MEMBER-1',
          'ALPHA01',
          'Alpha',
          'Member',
          '1980-01-01',
          'F',
          'ALPHA-ID',
          'ALPHA-BANK',
          'Alpha Region',
          -26.1,
          28.0,
          '2020-01-01',
          'tenant_alpha'
        ),
        (
          'BETA-MEMBER-1',
          'BETA01',
          'Beta',
          'Member',
          '1981-01-01',
          'M',
          'BETA-ID',
          'BETA-BANK',
          'Beta Region',
          -33.9,
          18.4,
          '2020-01-01',
          'tenant_beta'
        )
      ON DUPLICATE KEY UPDATE
        scheme_id =
          VALUES(scheme_id),
        first_name =
          VALUES(first_name),
        last_name =
          VALUES(last_name),
        tenant_id =
          VALUES(tenant_id)
    `,
  );

  await pool.execute(
    `
      INSERT INTO providers (
        provider_id,
        scheme_id,
        practice_number,
        specialty,
        practice_name,
        banking_detail,
        practice_region,
        practice_lat,
        practice_lon,
        provider_kind,
        provider_category,
        tenant_id
      )
      VALUES
        (
          'ALPHA-PROVIDER-1',
          'ALPHA01',
          'ALPHA-PRACTICE',
          'GP',
          'Alpha Practice',
          'ALPHA-PBANK',
          'Alpha Region',
          -26.1,
          28.0,
          'INDIVIDUAL',
          'GENERAL_PRACTITIONER',
          'tenant_alpha'
        ),
        (
          'BETA-PROVIDER-1',
          'BETA01',
          'BETA-PRACTICE',
          'GP',
          'Beta Practice',
          'BETA-PBANK',
          'Beta Region',
          -33.9,
          18.4,
          'INDIVIDUAL',
          'GENERAL_PRACTITIONER',
          'tenant_beta'
        )
      ON DUPLICATE KEY UPDATE
        scheme_id =
          VALUES(scheme_id),
        practice_name =
          VALUES(practice_name),
        tenant_id =
          VALUES(tenant_id)
    `,
  );

  /*
   * The tenants above may be created after migration
   * 0014, so give each tenant an explicit active
   * prospective detection strategy.
   */
  await pool.execute(
    `
      UPDATE detection_strategies
      SET
        is_active = 0,
        deactivated_at =
          COALESCE(
            deactivated_at,
            UTC_TIMESTAMP(3)
          )
      WHERE tenant_id IN (
        'tenant_alpha',
        'tenant_beta'
      )
        AND is_active = 1
    `,
  );

  await pool.execute(
    `
      INSERT INTO detection_strategies (
        tenant_id,
        strategy_type,
        model_deployment_id,
        is_active,
        activated_at,
        actor,
        change_reason
      )
      VALUES
        (
          'tenant_alpha',
          'deterministic_rules',
          NULL,
          1,
          UTC_TIMESTAMP(3),
          'integration:phase11d',
          'Activate deterministic prospective integration strategy'
        ),
        (
          'tenant_beta',
          'deterministic_rules',
          NULL,
          1,
          UTC_TIMESTAMP(3),
          'integration:phase11d',
          'Activate deterministic prospective integration strategy'
        )
    `,
  );

  const claims = [
    baselineClaim({
      claimId:
        "ALPHA-CLAIM-1",

      schemeId:
        "ALPHA01",

      memberId:
        "ALPHA-MEMBER-1",

      providerId:
        "ALPHA-PROVIDER-1",

      serviceDate:
        "2026-07-01",

      billingCode:
        "GP01",

      amount:
        101,

      tenantId:
        "tenant_alpha",
    }),

    baselineClaim({
      claimId:
        "ALPHA-CLAIM-2",

      schemeId:
        "ALPHA01",

      memberId:
        "ALPHA-MEMBER-1",

      providerId:
        "ALPHA-PROVIDER-1",

      serviceDate:
        "2026-07-01",

      billingCode:
        "GP02",

      amount:
        102,

      tenantId:
        "tenant_alpha",
    }),

    baselineClaim({
      claimId:
        "BETA-CLAIM-1",

      schemeId:
        "BETA01",

      memberId:
        "BETA-MEMBER-1",

      providerId:
        "BETA-PROVIDER-1",

      serviceDate:
        "2026-07-01",

      billingCode:
        "GP01",

      amount:
        202,

      tenantId:
        "tenant_beta",
    }),
  ];

  for (
    const claim
    of claims
  ) {
    await insertBaselineClaim(
      pool,
      claim,
    );
  }

  await pool.execute(
    `
      INSERT INTO investigations (
        investigation_id,
        tenant_id,
        claim_id,
        assigned_investigator,
        assigned_by,
        status,
        priority
      )
      VALUES
        (
          'ALPHA-INV-1',
          'tenant_alpha',
          'ALPHA-CLAIM-1',
          'alpha-investigator',
          'gate',
          'OPEN',
          'HIGH'
        ),
        (
          'BETA-INV-1',
          'tenant_beta',
          'BETA-CLAIM-1',
          'beta-investigator',
          'gate',
          'OPEN',
          'HIGH'
        )
      ON DUPLICATE KEY UPDATE
        status =
          VALUES(status),
        priority =
          VALUES(priority)
    `,
  );

  await pool.execute(
    `
      INSERT INTO ledger_entries (
        sequence_number,
        entry_type,
        previous_hash,
        entry_hash,
        payload,
        tenant_id
      )
      VALUES
        (
          101,
          'GATE_ALPHA',
          REPEAT('0', 64),
          REPEAT('c', 64),
          '{"marker":"ALPHA-LEDGER"}',
          'tenant_alpha'
        ),
        (
          102,
          'GATE_BETA',
          REPEAT('0', 64),
          REPEAT('d', 64),
          '{"marker":"BETA-LEDGER"}',
          'tenant_beta'
        )
      ON DUPLICATE KEY UPDATE
        payload =
          VALUES(payload),
        tenant_id =
          VALUES(tenant_id)
    `,
  );

  await pool.execute(
    `
      INSERT INTO ledger_chain_heads (
        tenant_id,
        last_sequence_number,
        last_entry_hash
      )
      VALUES
        (
          'tenant_alpha',
          101,
          REPEAT('c', 64)
        ),
        (
          'tenant_beta',
          102,
          REPEAT('d', 64)
        )
      ON DUPLICATE KEY UPDATE
        last_sequence_number =
          VALUES(last_sequence_number),
        last_entry_hash =
          VALUES(last_entry_hash)
    `,
  );
}


function createAuthenticationService(
  repositories,
  configuration,
) {
  return createControlPlaneAuthenticationService({
    authenticationRepository:
      repositories.authentication,

    idleTimeoutMs:
      configuration.idleTimeoutMs,

    absoluteTimeoutMs:
      configuration.absoluteTimeoutMs,

    throttleWindowMs:
      configuration
        .throttle
        .windowMs,

    throttleMaxAttempts:
      configuration
        .throttle
        .maxAttempts,

    throttleBaseDelayMs:
      1,

    throttleMaxDelayMs:
      2,

    throttleLockoutMs:
      configuration
        .throttle
        .lockoutMs,
  });
}


test(
  "Phase 11D real-MySQL gate enforces schema-14 tenant isolation and prospective claim-version scoring",
  {
    skip:
      !enabled,
  },
  async () => {
    assert.match(
      new URL(
        controlUrl,
      ).pathname,
      /cg11d|phase11d/i,
    );

    assert.match(
      new URL(
        operationalUrl,
      ).pathname,
      /cg11d|phase11d/i,
    );

    const controlPool =
      createControlPlanePool(
        controlUrl,
      );

    const operationalPool =
      createMysqlConnection(
        operationalUrl,
      );

    const logs = [];

    let connectionManager;

    try {
      const controlFirst =
        await applyControlPlaneMigrations(
          controlPool,
          {
            applicationVersion:
              "phase11d-gate",
          },
        );

      const controlSecond =
        await applyControlPlaneMigrations(
          controlPool,
          {
            applicationVersion:
              "phase11d-gate",
          },
        );

      const operationalFirst =
        await applyMigrations(
          operationalPool,
          undefined,
          {
            applicationVersion:
              "phase11d-gate",
          },
        );

      const operationalSecond =
        await applyMigrations(
          operationalPool,
          undefined,
          {
            applicationVersion:
              "phase11d-gate",
          },
        );

      assert.equal(
        controlSecond
          .applied
          .length,
        0,
      );

      assert.equal(
        operationalFirst
          .applied
          .some(
            ({
              id,
            }) =>
              id
              === "0014_prospective_claim_detection",
          )
        || operationalFirst
          .skipped
          .includes(
            "0014_prospective_claim_detection",
          ),
        true,
      );

      assert.equal(
        operationalSecond
          .applied
          .length,
        0,
      );

      assert.equal(
        operationalSecond
          .appliedStatements,
        0,
      );

      assert.equal(
        operationalSecond
          .skipped
          .includes(
            "0014_prospective_claim_detection",
          ),
        true,
      );

      assert.equal(
        (
          await getControlPlaneMigrationStatus(
            controlPool,
          )
        ).pending.length,
        0,
      );

      assert.equal(
        (
          await getOperationalMigrationStatus(
            operationalPool,
          )
        ).pending.length,
        0,
      );

      const [
        metadataRows,
      ] =
        await operationalPool.execute(
          `
            SELECT
              database_mode,
              logical_database_identifier,
              schema_version,
              environment_key,
              migration_version
            FROM data_plane_metadata
            WHERE metadata_key =
              'primary'
          `,
        );

      assert.equal(
        metadataRows.length,
        1,
      );

      assert.deepEqual(
        {
          databaseMode:
            metadataRows[0]
              .database_mode,

          logicalIdentifier:
            metadataRows[0]
              .logical_database_identifier,

          schemaVersion:
            String(
              metadataRows[0]
                .schema_version,
            ),

          environment:
            metadataRows[0]
              .environment_key,

          migrationVersion:
            Number(
              metadataRows[0]
                .migration_version,
            ),
        },
        {
          databaseMode:
            "legacy_shared",

          logicalIdentifier:
            "legacy-operational-shared",

          schemaVersion:
            "14",

          environment:
            "legacy",

          migrationVersion:
            14,
        },
      );

      await seedOperationalFixtures(
        operationalPool,
      );

      const [
        preIngestionJobs,
      ] =
        await operationalPool.execute(
          `
            SELECT COUNT(*) AS count
            FROM claim_processing_outbox
            WHERE tenant_id IN (
              'tenant_alpha',
              'tenant_beta'
            )
              AND job_type = ?
          `,
          [
            CLAIM_PROCESSING_JOB_TYPE,
          ],
        );

      assert.equal(
        Number(
          preIngestionJobs[0]
            .count,
        ),
        0,
      );

      const controlRepositories =
        createControlPlaneRepositories(
          controlPool,
        );

      const controlService =
        createControlPlaneService({
          pool:
            controlPool,

          repositories:
            controlRepositories,
        });

      const inventory =
        (
          await readLegacyTenantInventory(
            operationalPool,
          )
        ).filter(
          ({
            tenantId,
          }) =>
            TEST_TENANTS.includes(
              tenantId,
            ),
        );

      const provisioned =
        await provisionDemoAccounts({
          tenants:
            inventory,

          repositories:
            controlRepositories,

          service:
            controlService,

          executor:
            controlPool,

          operationalDatabaseName:
            new URL(
              operationalUrl,
            ).pathname.replace(
              /^\//,
              "",
            ),
        });

      const organisations =
        await controlRepositories
          .organisations
          .list();

      const alphaOrganisation =
        organisations.find(
          ({
            canonicalSlug,
          }) =>
            canonicalSlug
            === "alpha",
        );

      const betaOrganisation =
        organisations.find(
          ({
            canonicalSlug,
          }) =>
            canonicalSlug
            === "beta",
        );

      const platformOrganisation =
        organisations.find(
          ({
            canonicalSlug,
          }) =>
            canonicalSlug
            === "claimguard",
        );

      assert.ok(
        alphaOrganisation
        && betaOrganisation
        && platformOrganisation,
      );

      const routeResolver =
        createControlPlaneDataPlaneRouteResolver({
          repositories:
            controlRepositories,
        });

      const alphaContext =
        await routeResolver.resolve({
          organisationId:
            alphaOrganisation
              .organisationId,

          actorId:
            "gate-alpha",
        });

      const betaContext =
        await routeResolver.resolve({
          organisationId:
            betaOrganisation
              .organisationId,

          actorId:
            "gate-beta",
        });

      const platformContext =
        await routeResolver.resolve({
          organisationId:
            platformOrganisation
              .organisationId,

          actorId:
            "gate-platform",
        });

      assert.equal(
        alphaContext
          .operationalTenantId,
        "tenant_alpha",
      );

      assert.equal(
        betaContext
          .operationalTenantId,
        "tenant_beta",
      );

      assert.equal(
        alphaContext.schemaVersion,
        "14",
      );

      assert.equal(
        betaContext.schemaVersion,
        "14",
      );

      assert.notEqual(
        dataPlanePoolKey(
          alphaContext,
        ),
        dataPlanePoolKey(
          betaContext,
        ),
      );

      assert.equal(
        platformContext
          .routeType,
        "platform_none",
      );

      assert.equal(
        platformContext
          .operationalTenantId,
        null,
      );

      const adapter =
        createLegacySharedAdapter({
          databaseUrl:
            operationalUrl,
        });

      connectionManager =
        createTenantConnectionManager({
          adapters: {
            legacy_shared:
              adapter,
          },

          maxPools:
            8,

          logger(
            level,
            event,
            details,
          ) {
            logs.push({
              level,
              event,
              ...details,
            });
          },
        });

      const configuration =
        resolveAuthenticationConfiguration({
          AUTHENTICATION_MODE:
            "session",

          CONTROL_PLANE_MYSQL_URL:
            controlUrl,

          DEPLOYMENT_CLASS:
            "demo",

          SESSION_COOKIE_SECURE:
            "false",

          AUTH_ALLOWED_ORIGINS:
            "http://localhost",
        });

      const authenticationService =
        createAuthenticationService(
          controlRepositories,
          configuration,
        );

      const app =
        createBackendApp({
          authenticationConfiguration:
            configuration,

          authenticationService,

          controlPlaneConfigurationRepository:
            controlRepositories
              .configuration,

          reportStorage: {
            async getLatestReport({
              tenantContext,
            }) {
              const tenantId =
                tenantContext
                  .tenant_id;

              return {
                report:
                  createCanonicalDetectionReport({
                    tenantId,

                    version:
                      `${tenantId}-gate`,
                  }),

                metadata: {
                  tenant:
                    tenantId,

                  version:
                    `${tenantId}-gate`,
                },
              };
            },

            async checkReadiness() {
              return {
                reachable:
                  true,

                available:
                  true,
              };
            },
          },

          dataPlaneRuntime: {
            routeResolver,
            connectionManager,
          },
        });

      async function login(
        slug,
        role,
      ) {
        const credential =
          provisioned
            .oneTimeCredentials
            .find(
              (entry) => (
                entry.organisation
                  === slug
                && entry.role
                  === role
              ),
            );

        assert.ok(
          credential,
          `Missing ${role} credential for ${slug}.`,
        );

        const response =
          await app.request(
            "http://localhost/auth/login",
            {
              method:
                "POST",

              headers: {
                origin:
                  "http://localhost",

                "content-type":
                  "application/json",
              },

              body:
                JSON.stringify({
                  organisationSlug:
                    slug,

                  username:
                    credential.username,

                  password:
                    credential.password,
                }),
            },
          );

        const payload =
          await response.json();

        assert.equal(
          response.status,
          200,
          JSON.stringify(
            payload,
          ),
        );

        return {
          cookie:
            cookieFrom(
              response,
            ),

          csrf:
            payload.csrfToken,

          payload,
        };
      }

      async function request(
        session,
        requestPath,
        {
          method = "GET",
          body = undefined,
          extraHeaders = {},
        } = {},
      ) {
        return app.request(
          `http://localhost${requestPath}`,
          {
            method,

            headers: {
              cookie:
                session.cookie,

              origin:
                "http://localhost",

              ...(
                method !== "GET"
                  ? {
                      "x-csrf-token":
                        session.csrf,

                      "content-type":
                        "application/json",
                    }
                  : {}
              ),

              ...extraHeaders,
            },

            body:
              body === undefined
                ? undefined
                : JSON.stringify(
                    body,
                  ),
          },
        );
      }

      const alpha =
        await login(
          "alpha",
          "investigator",
        );

      const beta =
        await login(
          "beta",
          "investigator",
        );

      const alphaClaims =
        await login(
          "alpha",
          "claims_analyst",
        );

      const betaClaims =
        await login(
          "beta",
          "claims_analyst",
        );

      const platform =
        await login(
          "claimguard",
          "platform_administrator",
        );

      assert.equal(
        alpha.payload
          .organisation
          .organisationId,
        alphaOrganisation
          .organisationId,
      );

      assert.equal(
        beta.payload
          .organisation
          .organisationId,
        betaOrganisation
          .organisationId,
      );

      const alphaReport =
        await request(
          alpha,
          "/detection/report",
        );

      const betaReport =
        await request(
          beta,
          "/detection/report",
        );

      assert.equal(
        (
          await alphaReport.json()
        ).report
          .metadata
          .tenant
          .tenantId,
        "tenant_alpha",
      );

      assert.equal(
        (
          await betaReport.json()
        ).report
          .metadata
          .tenant
          .tenantId,
        "tenant_beta",
      );

      assert.equal(
        (
          await request(
            alpha,
            "/investigations/ALPHA-INV-1",
          )
        ).status,
        200,
      );

      assert.equal(
        (
          await request(
            alpha,
            "/investigations/BETA-INV-1",
          )
        ).status,
        404,
      );

      assert.equal(
        (
          await request(
            beta,
            "/investigations/BETA-INV-1",
          )
        ).status,
        200,
      );

      assert.equal(
        (
          await request(
            beta,
            "/investigations/ALPHA-INV-1",
          )
        ).status,
        404,
      );

      const alphaLedger =
        await (
          await request(
            alpha,
            "/ledger/latest",
          )
        ).json();

      const betaLedger =
        await (
          await request(
            beta,
            "/ledger/latest",
          )
        ).json();

      assert.equal(
        alphaLedger
          .entry
          .tenantId,
        "tenant_alpha",
      );

      assert.equal(
        betaLedger
          .entry
          .tenantId,
        "tenant_beta",
      );

      assert.equal(
        (
          await request(
            alpha,
            "/detection/report",
            {
              extraHeaders: {
                "x-claimguard-tenant":
                  "tenant_beta",
              },
            },
          )
        ).status,
        403,
      );

      assert.equal(
        (
          await request(
            platform,
            "/detection/report",
          )
        ).status,
        403,
      );

      const createdInvestigationResponse =
        await request(
          alpha,
          "/investigations",
          {
            method:
              "POST",

            body: {
              claimId:
                "ALPHA-CLAIM-2",

              tenantId:
                "tenant_beta",

              priority:
                "NORMAL",
            },
          },
        );

      assert.equal(
        createdInvestigationResponse
          .status,
        201,
      );

      assert.equal(
        (
          await createdInvestigationResponse
            .json()
        ).investigation
          .tenantId,
        "tenant_alpha",
      );

      /*
       * Initial prospective submission.
       */
      const initialIngestionResponse =
        await request(
          alphaClaims,
          "/claims/ingest",
          {
            method:
              "POST",

            body: {
              claims: [
                claimSubmission(),
              ],
            },
          },
        );

      const initialIngestion =
        await initialIngestionResponse
          .json();

      assert.equal(
        initialIngestionResponse
          .status,
        202,
        JSON.stringify(
          initialIngestion,
        ),
      );

      assert.equal(
        initialIngestion.available,
        true,
      );

      assert.equal(
        initialIngestion.committed,
        true,
      );

      assert.equal(
        initialIngestion
          .ingestion
          .received,
        1,
      );

      assert.equal(
        initialIngestion
          .ingestion
          .inserted,
        1,
      );

      assert.equal(
        initialIngestion
          .ingestion
          .updated,
        0,
      );

      assert.equal(
        initialIngestion
          .ingestion
          .unchanged,
        0,
      );

      assert.equal(
        initialIngestion
          .ingestion
          .versioned,
        1,
      );

      assert.equal(
        initialIngestion
          .processing
          .status,
        "queued",
      );

      assert.equal(
        initialIngestion
          .processing
          .skipped,
        false,
      );

      assert.equal(
        initialIngestion
          .processing
          .reused,
        false,
      );

      assert.ok(
        initialIngestion
          .processing
          .jobId,
      );

      const [
        firstVersionRows,
      ] =
        await operationalPool.execute(
          `
            SELECT
              tenant_id,
              claim_id,
              claim_version,
              version_reason
            FROM claim_versions
            WHERE tenant_id =
              'tenant_alpha'
              AND claim_id = ?
            ORDER BY claim_version
          `,
          [
            ALPHA_NEW_CLAIM_ID,
          ],
        );

      assert.deepEqual(
        firstVersionRows.map(
          (row) => ({
            tenantId:
              row.tenant_id,

            claimId:
              row.claim_id,

            claimVersion:
              Number(
                row.claim_version,
              ),

            versionReason:
              row.version_reason,
          }),
        ),
        [
          {
            tenantId:
              "tenant_alpha",

            claimId:
              ALPHA_NEW_CLAIM_ID,

            claimVersion: 1,

            versionReason:
              "initial_submission",
          },
        ],
      );

      const [
        firstOutboxRows,
      ] =
        await operationalPool.execute(
          `
            SELECT
              id,
              idempotency_key,
              payload,
              status,
              detection_strategy_id,
              strategy_type,
              model_deployment_id
            FROM claim_processing_outbox
            WHERE tenant_id =
              'tenant_alpha'
              AND job_type = ?
            ORDER BY
              created_at,
              id
          `,
          [
            CLAIM_PROCESSING_JOB_TYPE,
          ],
        );

      assert.equal(
        firstOutboxRows.length,
        1,
      );

      const firstPayload =
        parseJsonColumn(
          firstOutboxRows[0]
            .payload,
        );

      assert.deepEqual(
        firstPayload.targets,
        [
          {
            claim_id:
              ALPHA_NEW_CLAIM_ID,

            claim_version: 1,
          },
        ],
      );

      assert.equal(
        firstPayload.schema_version,
        CLAIM_PROCESSING_PAYLOAD_SCHEMA_VERSION,
      );

      assert.equal(
        firstPayload.dataset_scope,
        CLAIM_PROCESSING_DATASET_SCOPE,
      );

      assert.equal(
        firstPayload.source,
        "api",
      );

      assert.equal(
        typeof firstPayload
          .context_cutoff_at,
        "string",
      );

      assert.equal(
        Object.hasOwn(
          firstPayload,
          "claims",
        ),
        false,
      );

      assert.equal(
        firstOutboxRows[0]
          .strategy_type,
        "deterministic_rules",
      );

      assert.equal(
        firstOutboxRows[0]
          .model_deployment_id,
        null,
      );

      assert.equal(
        Number(
          firstOutboxRows[0]
            .detection_strategy_id,
        ) > 0,
        true,
      );

      /*
       * Exact retry: no fake version and no new job.
       */
      const retryResponse =
        await request(
          alphaClaims,
          "/claims/ingest",
          {
            method:
              "POST",

            body: {
              claims: [
                claimSubmission(),
              ],
            },
          },
        );

      const retryBody =
        await retryResponse.json();

      assert.equal(
        retryResponse.status,
        202,
        JSON.stringify(
          retryBody,
        ),
      );

      assert.equal(
        retryBody
          .ingestion
          .inserted,
        0,
      );

      assert.equal(
        retryBody
          .ingestion
          .updated,
        0,
      );

      assert.equal(
        retryBody
          .ingestion
          .unchanged,
        1,
      );

      assert.equal(
        retryBody
          .ingestion
          .versioned,
        0,
      );

      assert.equal(
        retryBody
          .processing
          .status,
        "not_queued",
      );

      assert.equal(
        retryBody
          .processing
          .skipped,
        true,
      );

      assert.equal(
        retryBody
          .processing
          .reason,
        "no_claim_changes",
      );

      const [
        afterRetryCounts,
      ] =
        await operationalPool.execute(
          `
            SELECT
              (
                SELECT COUNT(*)
                FROM claim_versions
                WHERE tenant_id =
                  'tenant_alpha'
                  AND claim_id = ?
              ) AS version_count,

              (
                SELECT COUNT(*)
                FROM claim_processing_outbox
                WHERE tenant_id =
                  'tenant_alpha'
                  AND job_type = ?
              ) AS job_count
          `,
          [
            ALPHA_NEW_CLAIM_ID,
            CLAIM_PROCESSING_JOB_TYPE,
          ],
        );

      assert.deepEqual(
        {
          versions:
            Number(
              afterRetryCounts[0]
                .version_count,
            ),

          jobs:
            Number(
              afterRetryCounts[0]
                .job_count,
            ),
        },
        {
          versions: 1,
          jobs: 1,
        },
      );

      /*
       * Genuine amendment: immutable version 2 and a second,
       * differently keyed prospective job.
       */
      const amendmentResponse =
        await request(
          alphaClaims,
          "/claims/ingest",
          {
            method:
              "POST",

            body: {
              claims: [
                claimSubmission({
                  amount: 333,
                }),
              ],
            },
          },
        );

      const amendmentBody =
        await amendmentResponse
          .json();

      assert.equal(
        amendmentResponse.status,
        202,
        JSON.stringify(
          amendmentBody,
        ),
      );

      assert.equal(
        amendmentBody
          .ingestion
          .inserted,
        0,
      );

      assert.equal(
        amendmentBody
          .ingestion
          .updated,
        1,
      );

      assert.equal(
        amendmentBody
          .ingestion
          .unchanged,
        0,
      );

      assert.equal(
        amendmentBody
          .ingestion
          .versioned,
        1,
      );

      assert.equal(
        amendmentBody
          .processing
          .status,
        "queued",
      );

      assert.notEqual(
        amendmentBody
          .processing
          .jobId,
        initialIngestion
          .processing
          .jobId,
      );

      const [
        amendedClaimRows,
      ] =
        await operationalPool.execute(
          `
            SELECT
              current_claim_version,
              amount
            FROM claims
            WHERE tenant_id =
              'tenant_alpha'
              AND claim_id = ?
          `,
          [
            ALPHA_NEW_CLAIM_ID,
          ],
        );

      assert.equal(
        Number(
          amendedClaimRows[0]
            .current_claim_version,
        ),
        2,
      );

      assert.equal(
        Number(
          amendedClaimRows[0]
            .amount,
        ),
        333,
      );

      const [
        versionRows,
      ] =
        await operationalPool.execute(
          `
            SELECT
              claim_version,
              amount,
              version_reason
            FROM claim_versions
            WHERE tenant_id =
              'tenant_alpha'
              AND claim_id = ?
            ORDER BY claim_version
          `,
          [
            ALPHA_NEW_CLAIM_ID,
          ],
        );

      assert.deepEqual(
        versionRows.map(
          (row) => ({
            claimVersion:
              Number(
                row.claim_version,
              ),

            amount:
              Number(
                row.amount,
              ),

            versionReason:
              row.version_reason,
          }),
        ),
        [
          {
            claimVersion: 1,
            amount: 303,
            versionReason:
              "initial_submission",
          },
          {
            claimVersion: 2,
            amount: 333,
            versionReason:
              "claim_amendment",
          },
        ],
      );

      const [
        outboxRows,
      ] =
        await operationalPool.execute(
          `
            SELECT
              id,
              idempotency_key,
              payload,
              status,
              detection_strategy_id,
              strategy_type,
              model_deployment_id
            FROM claim_processing_outbox
            WHERE tenant_id =
              'tenant_alpha'
              AND job_type = ?
            ORDER BY
              created_at,
              id
          `,
          [
            CLAIM_PROCESSING_JOB_TYPE,
          ],
        );

      assert.equal(
        outboxRows.length,
        2,
      );

      const outboxByVersion =
        new Map(
          outboxRows.map(
            (row) => {
              const payload =
                parseJsonColumn(
                  row.payload,
                );

              return [
                Number(
                  payload
                    .targets[0]
                    .claim_version,
                ),
                {
                  row,
                  payload,
                },
              ];
            },
          ),
        );

      assert.deepEqual(
        [
          ...outboxByVersion.keys(),
        ].sort(
          (
            left,
            right,
          ) =>
            left - right,
        ),
        [
          1,
          2,
        ],
      );

      for (
        const [
          claimVersion,
          {
            row,
            payload,
          },
        ]
        of outboxByVersion
      ) {
        assert.equal(
          payload.schema_version,
          CLAIM_PROCESSING_PAYLOAD_SCHEMA_VERSION,
        );

        assert.equal(
          payload.dataset_scope,
          CLAIM_PROCESSING_DATASET_SCOPE,
        );

        assert.deepEqual(
          payload.targets,
          [
            {
              claim_id:
                ALPHA_NEW_CLAIM_ID,

              claim_version:
                claimVersion,
            },
          ],
        );

        assert.equal(
          Object.hasOwn(
            payload,
            "claims",
          ),
          false,
        );

        assert.equal(
          row.strategy_type,
          "deterministic_rules",
        );

        assert.equal(
          row.model_deployment_id,
          null,
        );

        assert.equal(
          Number(
            row.detection_strategy_id,
          ),
          Number(
            firstOutboxRows[0]
              .detection_strategy_id,
          ),
        );
      }

      assert.notEqual(
        outboxRows[0]
          .idempotency_key,
        outboxRows[1]
          .idempotency_key,
      );

      const allTargets =
        outboxRows.flatMap(
          (row) =>
            parseJsonColumn(
              row.payload,
            ).targets,
        );

      assert.equal(
        allTargets.some(
          (target) =>
            target.claim_id
            === "ALPHA-CLAIM-1",
        ),
        false,
      );

      assert.equal(
        allTargets.some(
          (target) =>
            target.claim_id
            === "ALPHA-CLAIM-2",
        ),
        false,
      );

      /*
       * Claims reads remain tenant-scoped.
       */
      const alphaClaimsListResponse =
        await request(
          alphaClaims,
          "/claims",
        );

      const alphaClaimsList =
        await alphaClaimsListResponse
          .json();

      assert.equal(
        alphaClaimsListResponse
          .status,
        200,
      );

      assert.equal(
        alphaClaimsList.available,
        true,
      );

      assert.equal(
        alphaClaimsList.claims.some(
          (claim) =>
            claim.claimId
              .startsWith(
                "ALPHA-",
              ),
        ),
        true,
      );

      assert.equal(
        alphaClaimsList.claims.some(
          (claim) =>
            claim.claimId
              .startsWith(
                "BETA-",
              ),
        ),
        false,
      );

      assert.equal(
        (
          await request(
            alphaClaims,
            "/claims/ALPHA-CLAIM-1",
          )
        ).status,
        200,
      );

      assert.equal(
        (
          await request(
            alphaClaims,
            "/claims/BETA-CLAIM-1",
          )
        ).status,
        404,
      );

      assert.equal(
        (
          await request(
            betaClaims,
            "/claims/ALPHA-CLAIM-1",
          )
        ).status,
        404,
      );

      const crossIngest =
        await request(
          alphaClaims,
          "/claims/ingest",
          {
            method:
              "POST",

            body: {
              claims: [
                {
                  claim_id:
                    "BETA-ATTEMPT",

                  scheme_id:
                    "BETA01",

                  member_id:
                    "BETA-MEMBER-1",

                  provider_id:
                    "BETA-PROVIDER-1",

                  service_date:
                    "2026-07-02",

                  billing_code:
                    "X",

                  amount: 1,

                  ...modelClaimFields(
                    "2026-07-02",
                  ),
                },
              ],
            },
          },
        );

      assert.equal(
        crossIngest.status,
        403,
      );

      const [
        fixtureClaimRows,
      ] =
        await operationalPool.execute(
          `
            SELECT
              tenant_id,
              claim_id,
              current_claim_version
            FROM claims
            WHERE claim_id IN (
              'ALPHA-CLAIM-1',
              'ALPHA-CLAIM-2',
              'ALPHA-CLAIM-NEW',
              'BETA-CLAIM-1'
            )
            ORDER BY
              tenant_id,
              claim_id
          `,
        );

      assert.deepEqual(
        fixtureClaimRows.map(
          (row) => ({
            tenant:
              row.tenant_id,

            claimId:
              row.claim_id,

            version:
              Number(
                row.current_claim_version,
              ),
          }),
        ),
        [
          {
            tenant:
              "tenant_alpha",

            claimId:
              "ALPHA-CLAIM-1",

            version: 1,
          },
          {
            tenant:
              "tenant_alpha",

            claimId:
              "ALPHA-CLAIM-2",

            version: 1,
          },
          {
            tenant:
              "tenant_alpha",

            claimId:
              "ALPHA-CLAIM-NEW",

            version: 2,
          },
          {
            tenant:
              "tenant_beta",

            claimId:
              "BETA-CLAIM-1",

            version: 1,
          },
        ],
      );

      const [
        crossRows,
      ] =
        await operationalPool.execute(
          `
            SELECT COUNT(*) AS count
            FROM claims
            WHERE claim_id =
              'BETA-ATTEMPT'
          `,
        );

      assert.equal(
        Number(
          crossRows[0]
            .count,
        ),
        0,
      );

      const apiPools =
        connectionManager
          .metrics()
          .pools;

      assert.equal(
        apiPools.some(
          (entry) =>
            entry.organisationId
            === alphaOrganisation
              .organisationId,
        ),
        true,
      );

      assert.equal(
        apiPools.some(
          (entry) =>
            entry.organisationId
            === betaOrganisation
              .organisationId,
        ),
        true,
      );

      assert.equal(
        apiPools.some(
          (entry) =>
            entry.organisationId
            === platformOrganisation
              .organisationId,
        ),
        false,
      );

      const alphaHeld =
        await connectionManager.acquire(
          alphaContext,
        );

      const betaHeld =
        await connectionManager.acquire(
          betaContext,
        );

      await controlPool.execute(
        `
          UPDATE data_plane_routes
          SET route_generation =
            route_generation + 1
          WHERE route_id = ?
        `,
        [
          alphaContext.routeId,
        ],
      );

      const alphaGenerationTwo =
        await routeResolver.resolve({
          organisationId:
            alphaOrganisation
              .organisationId,
        });

      assert.equal(
        alphaGenerationTwo
          .routeGeneration,
        alphaContext
          .routeGeneration
        + 1,
      );

      const alphaNew =
        await connectionManager.acquire(
          alphaGenerationTwo,
        );

      assert.equal(
        connectionManager
          .metrics()
          .pools
          .some(
            (entry) => (
              entry.routeGeneration
                === alphaContext
                  .routeGeneration
              && entry.retiring
            ),
          ),
        true,
      );

      await assert.rejects(
        () =>
          connectionManager.acquire(
            alphaContext,
          ),
        (error) =>
          error.code
          === "DATA_PLANE_ROUTE_GENERATION_STALE",
      );

      await alphaHeld.release();

      assert.equal(
        connectionManager
          .metrics()
          .pools
          .some(
            (entry) => (
              entry.organisationId
                === alphaOrganisation
                  .organisationId
              && entry.routeGeneration
                === alphaContext
                  .routeGeneration
            ),
          ),
        false,
      );

      assert.equal(
        connectionManager
          .metrics()
          .pools
          .some(
            (entry) =>
              entry.organisationId
              === betaOrganisation
                .organisationId,
          ),
        true,
      );

      await alphaNew.release();
      await betaHeld.release();

      const metadataCases = [
        [
          "database_mode = 'private_database'",
          "DATA_PLANE_ROUTE_TYPE_MISMATCH",
        ],
        [
          "logical_database_identifier = 'wrong'",
          "DATA_PLANE_LOGICAL_IDENTITY_MISMATCH",
        ],
        [
          "schema_version = '999'",
          "DATA_PLANE_SCHEMA_UNSUPPORTED",
        ],
        [
          "environment_key = 'wrong'",
          "DATA_PLANE_ENVIRONMENT_MISMATCH",
        ],
        [
          "migration_version = 7",
          "DATA_PLANE_MIGRATION_VERSION_MISMATCH",
        ],
      ];

      for (
        const [
          mutation,
          code,
        ]
        of metadataCases
      ) {
        await operationalPool.execute(
          `
            UPDATE data_plane_metadata
            SET ${mutation}
            WHERE metadata_key =
              'primary'
          `,
        );

        const isolatedManager =
          createTenantConnectionManager({
            adapters: {
              legacy_shared:
                createLegacySharedAdapter({
                  databaseUrl:
                    operationalUrl,
                }),
            },
          });

        await assert.rejects(
          () =>
            isolatedManager.acquire(
              betaContext,
            ),
          (error) =>
            error.code
            === code,
        );

        assert.equal(
          isolatedManager
            .metrics()
            .cachedPools,
          0,
        );

        await operationalPool.execute(
          `
            UPDATE data_plane_metadata
            SET
              database_mode =
                'legacy_shared',
              logical_database_identifier =
                'legacy-operational-shared',
              schema_version =
                '14',
              environment_key =
                'legacy',
              migration_version =
                14
            WHERE metadata_key =
              'primary'
          `,
        );
      }

      const missingManager =
        createTenantConnectionManager({
          adapters: {
            legacy_shared:
              createLegacySharedAdapter({
                databaseUrl:
                  operationalUrl,
              }),
          },
        });

      await operationalPool.execute(
        `
          DELETE FROM data_plane_metadata
          WHERE metadata_key =
            'primary'
        `,
      );

      await assert.rejects(
        () =>
          missingManager.acquire(
            betaContext,
          ),
        (error) =>
          error.code
          === "DATA_PLANE_METADATA_MISSING",
      );

      await operationalPool.execute(
        `
          INSERT INTO data_plane_metadata (
            metadata_key,
            database_mode,
            logical_database_identifier,
            schema_version,
            environment_key,
            migration_version
          )
          VALUES (
            'primary',
            'legacy_shared',
            'legacy-operational-shared',
            '14',
            'legacy',
            14
          )
        `,
      );

      await assert.rejects(
        () =>
          operationalPool.execute(
            `
              INSERT INTO data_plane_metadata (
                metadata_key,
                database_mode,
                logical_database_identifier,
                schema_version,
                environment_key,
                migration_version
              )
              VALUES (
                'secondary',
                'legacy_shared',
                'legacy-operational-shared',
                '14',
                'legacy',
                14
              )
            `,
          ),
        (error) =>
          error.code
          === "ER_CHECK_CONSTRAINT_VIOLATED",
      );

      await controlService
        .transitionOrganisation(
          alphaOrganisation
            .organisationId,
          "suspended",
          {
            suspensionReason:
              "phase11d-gate",
          },
        );

      assert.equal(
        (
          await request(
            alpha,
            "/detection/report",
          )
        ).status,
        401,
      );

      assert.equal(
        connectionManager
          .metrics()
          .pools
          .some(
            (entry) =>
              entry.organisationId
              === alphaOrganisation
                .organisationId,
          ),
        false,
      );

      assert.equal(
        (
          await request(
            beta,
            "/detection/report",
          )
        ).status,
        200,
      );

      const alphaCredential =
        provisioned
          .oneTimeCredentials
          .find(
            (entry) => (
              entry.organisation
                === "alpha"
              && entry.role
                === "investigator"
            ),
          );

      const suspendedLogin =
        await app.request(
          "http://localhost/auth/login",
          {
            method:
              "POST",

            headers: {
              origin:
                "http://localhost",

              "content-type":
                "application/json",
            },

            body:
              JSON.stringify({
                organisationSlug:
                  "alpha",

                username:
                  alphaCredential
                    .username,

                password:
                  alphaCredential
                    .password,
              }),
          },
        );

      assert.equal(
        suspendedLogin.status,
        401,
      );

      assert.equal(
        (
          await app.request(
            "http://localhost/health",
          )
        ).status,
        200,
      );

      await controlService
        .transitionOrganisation(
          alphaOrganisation
            .organisationId,
          "active",
        );

      const freshAlpha =
        await login(
          "alpha",
          "investigator",
        );

      assert.equal(
        (
          await request(
            freshAlpha,
            "/detection/report",
          )
        ).status,
        200,
      );

      assert.equal(
        logs.some(
          ({
            event,
          }) =>
            event
            === "data_plane_pool_drained",
        ),
        true,
      );

      assert.equal(
        logs.some(
          ({
            event,
          }) =>
            event
            === "data_plane_metadata_verified",
        ),
        true,
      );

      const [
        mysqlVersionRows,
      ] =
        await operationalPool.execute(
          "SELECT VERSION() AS version",
        );

      console.log(
        JSON.stringify({
          phase11dRealMysql:
            true,

          prospectiveSchema:
            14,

          mysqlVersion:
            mysqlVersionRows[0]
              .version,

          organisations: {
            alpha:
              alphaOrganisation
                .organisationId,

            beta:
              betaOrganisation
                .organisationId,

            platform:
              platformOrganisation
                .organisationId,
          },

          routeKeys: {
            alpha:
              dataPlanePoolKey(
                alphaGenerationTwo,
              ),

            beta:
              dataPlanePoolKey(
                betaContext,
              ),
          },

          claimVersions:
            versionRows,

          safePoolMetrics:
            connectionManager
              .metrics(),

          controlMigrationsApplied:
            controlFirst
              .applied
              .length,
        }),
      );
    } finally {
      if (connectionManager) {
        const organisationIds =
          connectionManager
            .metrics()
            .pools
            .map(
              ({
                organisationId,
              }) =>
                organisationId,
            );

        await Promise.all(
          [
            ...new Set(
              organisationIds,
            ),
          ].map(
            (organisationId) =>
              connectionManager
                .invalidateOrganisation(
                  organisationId,
                  "gate_shutdown",
                )
                .catch(
                  () => undefined,
                ),
          ),
        );
      }

      await Promise.all([
        controlPool.end(),
        operationalPool.end(),
      ]);
    }
  },
);
