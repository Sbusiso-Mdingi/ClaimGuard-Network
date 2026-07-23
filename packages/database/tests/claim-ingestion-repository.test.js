import assert from "node:assert/strict";
import test from "node:test";

import {
  ClaimOwnershipConflictError,
  ClaimReferenceValidationError,
  createClaimIngestionRepository,
  ReferenceOwnershipConflictError,
  runWithTenantContext,
} from "../src/index.js";


const FIXED_DATABASE_TIMESTAMP =
  "2026-07-23 12:30:45.123";


function modelClaimFields() {
  return {
    received_date: "2026-07-20",
    quantity: 1,
    benefit_option: "COMPREHENSIVE",
    network_type: "IN_NETWORK",
    line_type: "PROFESSIONAL",
    tariff_discipline: "MEDICAL",
    diagnosis_code: "Z00.0",
    rendering_practitioner_id: null,
    rendering_practitioner_category: "NONE",
    rendering_known_to_billing_provider: false,
  };
}


function claimInput({
  claimId = "C-100",
  amount = 233.19,
  schemeId = "scheme_a",
  memberId = "M-1",
  providerId = "P-1",
} = {}) {
  return {
    claim_id: claimId,
    scheme_id: schemeId,
    member_id: memberId,
    provider_id: providerId,
    service_date: "2026-07-20",
    billing_code: "CONSULT",
    amount,
    ...modelClaimFields(),
  };
}


function normalizeSql(sql) {
  return String(sql)
    .replace(/\s+/g, " ")
    .trim();
}


function cloneMap(map) {
  return new Map(
    [...map].map(
      ([key, value]) => [
        key,
        value && typeof value === "object"
          ? { ...value }
          : value,
      ],
    ),
  );
}


function cloneReferenceMaps(references) {
  return {
    schemes: cloneMap(references.schemes),
    members: cloneMap(references.members),
    providers: cloneMap(references.providers),
  };
}


function replaceMap(target, source) {
  target.clear();

  for (const [key, value] of source) {
    target.set(
      key,
      value && typeof value === "object"
        ? { ...value }
        : value,
    );
  }
}


function restoreReferences(target, source) {
  replaceMap(
    target.schemes,
    source.schemes,
  );

  replaceMap(
    target.members,
    source.members,
  );

  replaceMap(
    target.providers,
    source.providers,
  );
}


function createMemoryPool({
  tenantId = "tenant_default",
  seedReferences = true,
  activeStrategy = {
    id: 1,
    strategy_type: "deterministic_rules",
    model_deployment_id: null,
  },
  failClaimInsert = false,
  failOutboxInsert = false,
} = {}) {
  const executions = [];

  const references = {
    schemes: new Map(),
    members: new Map(),
    providers: new Map(),
  };

  if (seedReferences) {
    references.schemes.set(
      "scheme_a",
      {
        tenant_id: tenantId,
      },
    );

    references.members.set(
      "M-1",
      {
        tenant_id: tenantId,
        scheme_id: "scheme_a",
      },
    );

    references.providers.set(
      "P-1",
      {
        tenant_id: tenantId,
        scheme_id: "scheme_a",
      },
    );
  }

  const claims = new Map();
  const claimVersions = new Map();
  const outbox = new Map();

  let rollbackCount = 0;
  let commitCount = 0;

  function claimVersionKey(
    versionTenantId,
    claimId,
    claimVersion,
  ) {
    return (
      `${versionTenantId}:`
      + `${claimId}:`
      + `${claimVersion}`
    );
  }

  function outboxKey(
    jobTenantId,
    idempotencyKey,
  ) {
    return (
      `${jobTenantId}:`
      + idempotencyKey
    );
  }

  function referenceMap(tableName) {
    const map = references[tableName];

    if (!map) {
      throw new Error(
        `Unsupported reference table ${tableName}.`,
      );
    }

    return map;
  }

  const pool = {
    executions,
    references,
    claims,
    claimVersions,
    outbox,

    get rollbackCount() {
      return rollbackCount;
    },

    get commitCount() {
      return commitCount;
    },

    setReferenceTenant(
      nextTenantId,
    ) {
      for (
        const row
        of references.schemes.values()
      ) {
        row.tenant_id = nextTenantId;
      }

      for (
        const row
        of references.members.values()
      ) {
        row.tenant_id = nextTenantId;
      }

      for (
        const row
        of references.providers.values()
      ) {
        row.tenant_id = nextTenantId;
      }
    },

    async getConnection() {
      let transactionSnapshot = null;

      return {
        async beginTransaction() {
          transactionSnapshot = {
            references:
              cloneReferenceMaps(
                references,
              ),

            claims:
              cloneMap(
                claims,
              ),

            claimVersions:
              cloneMap(
                claimVersions,
              ),

            outbox:
              cloneMap(
                outbox,
              ),
          };
        },

        async execute(
          sql,
          params = [],
        ) {
          const statement =
            normalizeSql(sql);

          executions.push({
            sql: statement,
            params,
          });

          if (
            statement.includes(
              "FROM detection_strategies",
            )
          ) {
            return [
              activeStrategy
                ? [
                    {
                      ...activeStrategy,
                    },
                  ]
                : [],
            ];
          }

          if (
            statement.includes(
              "UTC_TIMESTAMP(3) AS context_cutoff_at",
            )
          ) {
            return [
              [
                {
                  context_cutoff_at:
                    FIXED_DATABASE_TIMESTAMP,
                },
              ],
            ];
          }

          if (
            statement.includes(
              "FROM claims c",
            )
            && statement.includes(
              "LEFT JOIN claim_versions cv",
            )
          ) {
            const claimId =
              params[0];

            const claim =
              claims.get(
                claimId,
              );

            if (!claim) {
              return [
                [],
              ];
            }

            const version =
              claimVersions.get(
                claimVersionKey(
                  claim.tenant_id,
                  claimId,
                  claim.current_claim_version,
                ),
              );

            return [
              [
                {
                  tenant_id:
                    claim.tenant_id,

                  current_claim_version:
                    claim.current_claim_version,

                  payload_hash:
                    version?.payload_hash
                    || null,

                  claim_payload:
                    version?.claim_payload
                    || null,
                },
              ],
            ];
          }

          const referenceSelect =
            statement.match(
              /FROM (schemes|members|providers) WHERE/i,
            );

          if (referenceSelect) {
            const tableName =
              referenceSelect[1]
                .toLowerCase();

            const record =
              referenceMap(
                tableName,
              ).get(
                params[0],
              );

            return [
              record
                ? [
                    {
                      ...record,
                    },
                  ]
                : [],
            ];
          }

          if (
            statement.startsWith(
              "INSERT INTO schemes",
            )
          ) {
            const [
              schemeId,
              ,
              recordTenantId,
            ] = params;

            references.schemes.set(
              schemeId,
              {
                tenant_id:
                  recordTenantId,
              },
            );

            return [
              {
                affectedRows: 1,
              },
            ];
          }

          if (
            statement.startsWith(
              "INSERT INTO members",
            )
          ) {
            const [
              memberId,
              schemeId,
            ] = params;

            const recordTenantId =
              params.at(-1);

            references.members.set(
              memberId,
              {
                tenant_id:
                  recordTenantId,

                scheme_id:
                  schemeId,
              },
            );

            return [
              {
                affectedRows: 1,
              },
            ];
          }

          if (
            statement.startsWith(
              "INSERT INTO providers",
            )
          ) {
            const [
              providerId,
              schemeId,
            ] = params;

            const recordTenantId =
              params.at(-1);

            references.providers.set(
              providerId,
              {
                tenant_id:
                  recordTenantId,

                scheme_id:
                  schemeId,
              },
            );

            return [
              {
                affectedRows: 1,
              },
            ];
          }

          if (
            statement.startsWith(
              "UPDATE schemes",
            )
            || statement.startsWith(
              "UPDATE members",
            )
            || statement.startsWith(
              "UPDATE providers",
            )
          ) {
            return [
              {
                affectedRows: 1,
              },
            ];
          }

          if (
            statement.startsWith(
              "INSERT INTO claims",
            )
          ) {
            if (failClaimInsert) {
              throw new Error(
                "claim insert failed",
              );
            }

            const [
              claimId,
              schemeId,
              memberId,
              providerId,
              serviceDate,
              receivedDate,
              billingCode,
              amount,
              quantity,
              benefitOption,
              networkType,
              lineType,
              tariffDiscipline,
              diagnosisCode,
              renderingPractitionerId,
              renderingPractitionerCategory,
              renderingKnownToBillingProvider,
              claimTenantId,
            ] = params;

            if (
              claims.has(
                claimId,
              )
            ) {
              const error =
                new Error(
                  "duplicate claim",
                );

              error.code =
                "ER_DUP_ENTRY";

              throw error;
            }

            claims.set(
              claimId,
              {
                claim_id:
                  claimId,

                current_claim_version:
                  1,

                scheme_id:
                  schemeId,

                member_id:
                  memberId,

                provider_id:
                  providerId,

                service_date:
                  serviceDate,

                received_date:
                  receivedDate,

                billing_code:
                  billingCode,

                amount,
                quantity,

                benefit_option:
                  benefitOption,

                network_type:
                  networkType,

                line_type:
                  lineType,

                tariff_discipline:
                  tariffDiscipline,

                diagnosis_code:
                  diagnosisCode,

                rendering_practitioner_id:
                  renderingPractitionerId,

                rendering_practitioner_category:
                  renderingPractitionerCategory,

                rendering_known_to_billing_provider:
                  renderingKnownToBillingProvider,

                tenant_id:
                  claimTenantId,
              },
            );

            return [
              {
                affectedRows: 1,
              },
            ];
          }

          if (
            statement.startsWith(
              "INSERT INTO claim_versions",
            )
          ) {
            const [
              versionTenantId,
              claimId,
              claimVersion,
              schemeId,
              memberId,
              providerId,
              serviceDate,
              receivedDate,
              billingCode,
              amount,
              claimPayload,
              payloadHash,
              versionReason,
            ] = params;

            claimVersions.set(
              claimVersionKey(
                versionTenantId,
                claimId,
                claimVersion,
              ),
              {
                tenant_id:
                  versionTenantId,

                claim_id:
                  claimId,

                claim_version:
                  claimVersion,

                scheme_id:
                  schemeId,

                member_id:
                  memberId,

                provider_id:
                  providerId,

                service_date:
                  serviceDate,

                received_date:
                  receivedDate,

                billing_code:
                  billingCode,

                amount,

                claim_payload:
                  claimPayload,

                payload_hash:
                  payloadHash,

                version_reason:
                  versionReason,
              },
            );

            return [
              {
                affectedRows: 1,
              },
            ];
          }

          if (
            statement.startsWith(
              "UPDATE claim_versions SET payload_hash",
            )
          ) {
            const [
              payloadHash,
              versionTenantId,
              claimId,
              claimVersion,
            ] = params;

            const key =
              claimVersionKey(
                versionTenantId,
                claimId,
                claimVersion,
              );

            const existing =
              claimVersions.get(
                key,
              );

            if (existing) {
              existing.payload_hash =
                payloadHash;
            }

            return [
              {
                affectedRows:
                  existing ? 1 : 0,
              },
            ];
          }

          if (
            statement.startsWith(
              "UPDATE claims SET current_claim_version",
            )
          ) {
            const nextVersion =
              params[0];

            const claimValues =
              params.slice(
                1,
                17,
              );

            const claimId =
              params[17];

            const claimTenantId =
              params[18];

            const expectedVersion =
              params[19];

            const existing =
              claims.get(
                claimId,
              );

            if (
              !existing
              || existing.tenant_id
                !== claimTenantId
              || existing.current_claim_version
                !== expectedVersion
            ) {
              return [
                {
                  affectedRows: 0,
                },
              ];
            }

            const [
              schemeId,
              memberId,
              providerId,
              serviceDate,
              receivedDate,
              billingCode,
              amount,
              quantity,
              benefitOption,
              networkType,
              lineType,
              tariffDiscipline,
              diagnosisCode,
              renderingPractitionerId,
              renderingPractitionerCategory,
              renderingKnownToBillingProvider,
            ] = claimValues;

            claims.set(
              claimId,
              {
                ...existing,

                current_claim_version:
                  nextVersion,

                scheme_id:
                  schemeId,

                member_id:
                  memberId,

                provider_id:
                  providerId,

                service_date:
                  serviceDate,

                received_date:
                  receivedDate,

                billing_code:
                  billingCode,

                amount,
                quantity,

                benefit_option:
                  benefitOption,

                network_type:
                  networkType,

                line_type:
                  lineType,

                tariff_discipline:
                  tariffDiscipline,

                diagnosis_code:
                  diagnosisCode,

                rendering_practitioner_id:
                  renderingPractitionerId,

                rendering_practitioner_category:
                  renderingPractitionerCategory,

                rendering_known_to_billing_provider:
                  renderingKnownToBillingProvider,
              },
            );

            return [
              {
                affectedRows: 1,
              },
            ];
          }

          if (
            statement.startsWith(
              "INSERT INTO claim_processing_outbox",
            )
          ) {
            if (failOutboxInsert) {
              throw new Error(
                "outbox insert failed",
              );
            }

            const [
              id,
              jobTenantId,
              jobType,
              aggregateType,
              aggregateId,
              correlationId,
              idempotencyKey,
              payload,
              maxAttempts,
              detectionStrategyId,
              strategyType,
              modelDeploymentId,
            ] = params;

            const key =
              outboxKey(
                jobTenantId,
                idempotencyKey,
              );

            if (
              !outbox.has(
                key,
              )
            ) {
              outbox.set(
                key,
                {
                  id,

                  tenant_id:
                    jobTenantId,

                  job_type:
                    jobType,

                  aggregate_type:
                    aggregateType,

                  aggregate_id:
                    aggregateId,

                  correlation_id:
                    correlationId,

                  idempotency_key:
                    idempotencyKey,

                  payload,

                  status:
                    "pending",

                  attempt_count:
                    0,

                  max_attempts:
                    maxAttempts,

                  available_at:
                    FIXED_DATABASE_TIMESTAMP,

                  leased_at:
                    null,

                  lease_expires_at:
                    null,

                  leased_by:
                    null,

                  last_error:
                    null,

                  failure_code:
                    null,

                  failed_watermark:
                    null,

                  covered_report_id:
                    null,

                  covered_watermark:
                    null,

                  covered_at:
                    null,

                  detection_strategy_id:
                    detectionStrategyId,

                  strategy_type:
                    strategyType,

                  model_deployment_id:
                    modelDeploymentId,

                  created_at:
                    FIXED_DATABASE_TIMESTAMP,

                  updated_at:
                    FIXED_DATABASE_TIMESTAMP,

                  completed_at:
                    null,
                },
              );

              return [
                {
                  affectedRows: 1,
                },
              ];
            }

            return [
              {
                affectedRows: 0,
              },
            ];
          }

          if (
            statement.includes(
              "FROM claim_processing_outbox",
            )
            && statement.includes(
              "idempotency_key = ?",
            )
          ) {
            const [
              jobTenantId,
              idempotencyKey,
            ] = params;

            const row =
              outbox.get(
                outboxKey(
                  jobTenantId,
                  idempotencyKey,
                ),
              );

            return [
              row
                ? [
                    {
                      ...row,
                    },
                  ]
                : [],
            ];
          }

          throw new Error(
            `Unexpected SQL: ${statement}`,
          );
        },

        async commit() {
          commitCount += 1;
          transactionSnapshot = null;
        },

        async rollback() {
          rollbackCount += 1;

          if (!transactionSnapshot) {
            return;
          }

          restoreReferences(
            references,
            transactionSnapshot.references,
          );

          replaceMap(
            claims,
            transactionSnapshot.claims,
          );

          replaceMap(
            claimVersions,
            transactionSnapshot.claimVersions,
          );

          replaceMap(
            outbox,
            transactionSnapshot.outbox,
          );
        },

        release() {},
      };
    },
  };

  return pool;
}


test(
  "new claims create immutable version one and a prospective scoring job",
  async () => {
    const pool =
      createMemoryPool();

    const repository =
      createClaimIngestionRepository(
        pool,
        {
          allowLegacyTenantContext:
            true,
        },
      );

    const result =
      await repository.ingestClaims({
        source:
          "upstream-connector",

        correlationId:
          "request-100",

        claims: [
          claimInput(),
        ],
      });

    assert.equal(
      result.received,
      1,
    );

    assert.equal(
      result.inserted,
      1,
    );

    assert.equal(
      result.updated,
      0,
    );

    assert.equal(
      result.unchanged,
      0,
    );

    assert.equal(
      result.versioned,
      1,
    );

    assert.equal(
      result.processing.status,
      "queued",
    );

    assert.equal(
      result.processing.asynchronous,
      true,
    );

    assert.equal(
      result.processing.reused,
      false,
    );

    const claim =
      pool.claims.get(
        "C-100",
      );

    assert.equal(
      claim.current_claim_version,
      1,
    );

    assert.equal(
      claim.tenant_id,
      "tenant_default",
    );

    const version =
      pool.claimVersions.get(
        "tenant_default:C-100:1",
      );

    assert.equal(
      version.version_reason,
      "initial_submission",
    );

    assert.match(
      version.payload_hash,
      /^[a-f0-9]{64}$/,
    );

    assert.equal(
      pool.outbox.size,
      1,
    );

    const job =
      [...pool.outbox.values()][0];

    assert.equal(
      job.job_type,
      "claim_detection",
    );

    assert.equal(
      job.strategy_type,
      "deterministic_rules",
    );

    assert.equal(
      job.detection_strategy_id,
      1,
    );

    assert.deepEqual(
      JSON.parse(
        job.payload,
      ),
      {
        schema_version: 2,

        dataset_scope:
          "triggering_claim_versions",

        source:
          "upstream-connector",

        context_cutoff_at:
          "2026-07-23T12:30:45.123Z",

        targets: [
          {
            claim_id:
              "C-100",

            claim_version:
              1,
          },
        ],
      },
    );
  },
);


test(
  "reference data and claims are committed in one authoritative batch",
  async () => {
    const pool =
      createMemoryPool({
        seedReferences: false,
      });

    const repository =
      createClaimIngestionRepository(
        pool,
        {
          allowLegacyTenantContext:
            true,
        },
      );

    const result =
      await repository.ingestClaims({
        source:
          "medical-aid-desktop",

        schemes: [
          {
            scheme_id:
              "scheme_a",

            scheme_name:
              "Scheme A",
          },
        ],

        members: [
          {
            member_id:
              "M-1",

            scheme_id:
              "scheme_a",

            first_name:
              "token:first",

            last_name:
              "token:last",

            date_of_birth:
              "1985-01-01",

            gender:
              "unspecified",

            identity_number:
              "token:identity",

            banking_detail:
              "token:member-bank",

            home_region:
              "Gauteng",

            home_lat:
              -26.2,

            home_lon:
              28,

            join_date:
              "2020-01-01",
          },
        ],

        providers: [
          {
            provider_id:
              "P-1",

            scheme_id:
              "scheme_a",

            practice_number:
              "practice-1",

            specialty:
              "GP",

            practice_name:
              "Practice 1",

            banking_detail:
              "token:provider-bank",

            practice_region:
              "Gauteng",

            practice_lat:
              -26.2,

            practice_lon:
              28,

            provider_kind:
              "INDIVIDUAL",

            provider_category:
              "GENERAL_PRACTITIONER",
          },
        ],

        claims: [
          claimInput({
            claimId:
              "C-REFERENCE",
          }),
        ],
      });

    assert.deepEqual(
      result.referenceData,
      {
        schemes: {
          received: 1,
          inserted: 1,
          updated: 0,
        },

        members: {
          received: 1,
          inserted: 1,
          updated: 0,
        },

        providers: {
          received: 1,
          inserted: 1,
          updated: 0,
        },
      },
    );

    assert.equal(
      result.inserted,
      1,
    );

    assert.equal(
      result.processing.status,
      "queued",
    );

    assert.equal(
      pool.references.schemes
        .get("scheme_a")
        .tenant_id,
      "tenant_default",
    );
  },
);


test(
  "ingestion fails closed when the tenant has no active detection strategy",
  async () => {
    const pool =
      createMemoryPool({
        activeStrategy: null,
      });

    const repository =
      createClaimIngestionRepository(
        pool,
        {
          allowLegacyTenantContext:
            true,
        },
      );

    await assert.rejects(
      () =>
        repository.ingestClaims({
          claims: [
            claimInput(),
          ],
        }),
      /no active detection strategy/i,
    );

    assert.equal(
      pool.claims.size,
      0,
    );

    assert.equal(
      pool.claimVersions.size,
      0,
    );

    assert.equal(
      pool.outbox.size,
      0,
    );

    assert.equal(
      pool.rollbackCount,
      1,
    );
  },
);


test(
  "required claim fields are validated before opening a transaction",
  async () => {
    const pool =
      createMemoryPool();

    const repository =
      createClaimIngestionRepository(
        pool,
        {
          allowLegacyTenantContext:
            true,
        },
      );

    await assert.rejects(
      () =>
        repository.ingestClaims({
          claims: [
            {
              claim_id:
                "C-INCOMPLETE",

              scheme_id:
                "scheme_a",
            },
          ],
        }),
      /member_id is required/i,
    );

    assert.equal(
      pool.executions.length,
      0,
    );
  },
);


test(
  "reference identifiers remain immutable across tenants",
  async () => {
    const pool =
      createMemoryPool({
        tenantId:
          "tenant_beta",
      });

    const repository =
      createClaimIngestionRepository(
        pool,
        {
          allowLegacyTenantContext:
            true,
        },
      );

    await assert.rejects(
      () =>
        runWithTenantContext(
          {
            tenant_id:
              "tenant_alpha",
          },
          () =>
            repository.ingestClaims({
              schemes: [
                {
                  scheme_id:
                    "scheme_a",

                  scheme_name:
                    "Scheme A",
                },
              ],

              claims: [
                claimInput(),
              ],
            }),
        ),
      ReferenceOwnershipConflictError,
    );

    assert.equal(
      pool.rollbackCount,
      1,
    );

    assert.equal(
      pool.claims.size,
      0,
    );
  },
);


test(
  "identical retries create no artificial claim version or second job",
  async () => {
    const pool =
      createMemoryPool({
        tenantId:
          "tenant_alpha",
      });

    const repository =
      createClaimIngestionRepository(
        pool,
        {
          allowLegacyTenantContext:
            true,
        },
      );

    const first =
      await runWithTenantContext(
        {
          tenant_id:
            "tenant_alpha",
        },
        () =>
          repository.ingestClaims({
            source:
              "api",

            correlationId:
              "request-1",

            claims: [
              claimInput({
                claimId:
                  "C-IDEMPOTENT",
              }),
            ],
          }),
      );

    const retry =
      await runWithTenantContext(
        {
          tenant_id:
            "tenant_alpha",
        },
        () =>
          repository.ingestClaims({
            source:
              "api",

            correlationId:
              "request-2",

            claims: [
              claimInput({
                claimId:
                  "C-IDEMPOTENT",
              }),
            ],
          }),
      );

    assert.equal(
      first.inserted,
      1,
    );

    assert.equal(
      first.versioned,
      1,
    );

    assert.equal(
      retry.inserted,
      0,
    );

    assert.equal(
      retry.updated,
      0,
    );

    assert.equal(
      retry.unchanged,
      1,
    );

    assert.equal(
      retry.versioned,
      0,
    );

    assert.deepEqual(
      retry.processing,
      {
        status:
          "not_queued",

        asynchronous:
          false,

        jobId:
          null,

        correlationId:
          "request-2",

        reused:
          false,

        skipped:
          true,

        reason:
          "no_claim_changes",
      },
    );

    assert.equal(
      pool.claimVersions.size,
      1,
    );

    assert.equal(
      pool.outbox.size,
      1,
    );
  },
);


test(
  "changed claims create an immutable amendment and a second prospective job",
  async () => {
    const pool =
      createMemoryPool({
        tenantId:
          "tenant_alpha",
      });

    const repository =
      createClaimIngestionRepository(
        pool,
        {
          allowLegacyTenantContext:
            true,
        },
      );

    await runWithTenantContext(
      {
        tenant_id:
          "tenant_alpha",
      },
      () =>
        repository.ingestClaims({
          claims: [
            claimInput({
              claimId:
                "C-AMENDMENT",

              amount:
                100,
            }),
          ],
        }),
    );

    const amendment =
      await runWithTenantContext(
        {
          tenant_id:
            "tenant_alpha",
        },
        () =>
          repository.ingestClaims({
            claims: [
              claimInput({
                claimId:
                  "C-AMENDMENT",

                amount:
                  125,
              }),
            ],
          }),
      );

    assert.equal(
      amendment.inserted,
      0,
    );

    assert.equal(
      amendment.updated,
      1,
    );

    assert.equal(
      amendment.unchanged,
      0,
    );

    assert.equal(
      amendment.versioned,
      1,
    );

    assert.equal(
      pool.claims
        .get("C-AMENDMENT")
        .current_claim_version,
      2,
    );

    assert.equal(
      pool.claims
        .get("C-AMENDMENT")
        .amount,
      125,
    );

    assert.equal(
      pool.claimVersions.size,
      2,
    );

    assert.equal(
      pool.claimVersions
        .get(
          "tenant_alpha:C-AMENDMENT:2",
        )
        .version_reason,
      "claim_amendment",
    );

    assert.equal(
      pool.outbox.size,
      2,
    );

    const targets =
      [...pool.outbox.values()]
        .map(
          (row) =>
            JSON.parse(
              row.payload,
            ).targets[0],
        )
        .sort(
          (left, right) =>
            left.claim_version
            - right.claim_version,
        );

    assert.deepEqual(
      targets,
      [
        {
          claim_id:
            "C-AMENDMENT",

          claim_version:
            1,
        },

        {
          claim_id:
            "C-AMENDMENT",

          claim_version:
            2,
        },
      ],
    );
  },
);


test(
  "claim identifiers cannot be reassigned to another tenant",
  async () => {
    const pool =
      createMemoryPool({
        tenantId:
          "tenant_alpha",
      });

    const repository =
      createClaimIngestionRepository(
        pool,
        {
          allowLegacyTenantContext:
            true,
        },
      );

    await runWithTenantContext(
      {
        tenant_id:
          "tenant_alpha",
      },
      () =>
        repository.ingestClaims({
          claims: [
            claimInput({
              claimId:
                "C-OWNED",
            }),
          ],
        }),
    );

    /*
     * Isolate the claim-ownership assertion by
     * simulating references valid for tenant_beta.
     */
    pool.setReferenceTenant(
      "tenant_beta",
    );

    await assert.rejects(
      () =>
        runWithTenantContext(
          {
            tenant_id:
              "tenant_beta",
          },
          () =>
            repository.ingestClaims({
              claims: [
                claimInput({
                  claimId:
                    "C-OWNED",

                  amount:
                    999,
                }),
              ],
            }),
        ),
      ClaimOwnershipConflictError,
    );

    assert.equal(
      pool.claims
        .get("C-OWNED")
        .tenant_id,
      "tenant_alpha",
    );

    assert.equal(
      pool.claims
        .get("C-OWNED")
        .amount,
      233.19,
    );

    assert.equal(
      pool.outbox.size,
      1,
    );

    assert.equal(
      pool.rollbackCount,
      1,
    );
  },
);


test(
  "outbox enqueue failure rolls back the claim and its immutable version",
  async () => {
    const pool =
      createMemoryPool({
        tenantId:
          "tenant_alpha",

        failOutboxInsert:
          true,
      });

    const repository =
      createClaimIngestionRepository(
        pool,
        {
          allowLegacyTenantContext:
            true,
        },
      );

    await assert.rejects(
      () =>
        runWithTenantContext(
          {
            tenant_id:
              "tenant_alpha",
          },
          () =>
            repository.ingestClaims({
              claims: [
                claimInput(),
              ],
            }),
        ),
      /outbox insert failed/i,
    );

    assert.equal(
      pool.claims.size,
      0,
    );

    assert.equal(
      pool.claimVersions.size,
      0,
    );

    assert.equal(
      pool.outbox.size,
      0,
    );

    assert.equal(
      pool.rollbackCount,
      1,
    );
  },
);


test(
  "claim insert failure creates neither a claim version nor an outbox job",
  async () => {
    const pool =
      createMemoryPool({
        tenantId:
          "tenant_alpha",

        failClaimInsert:
          true,
      });

    const repository =
      createClaimIngestionRepository(
        pool,
        {
          allowLegacyTenantContext:
            true,
        },
      );

    await assert.rejects(
      () =>
        runWithTenantContext(
          {
            tenant_id:
              "tenant_alpha",
          },
          () =>
            repository.ingestClaims({
              claims: [
                claimInput(),
              ],
            }),
        ),
      /claim insert failed/i,
    );

    assert.equal(
      pool.claims.size,
      0,
    );

    assert.equal(
      pool.claimVersions.size,
      0,
    );

    assert.equal(
      pool.outbox.size,
      0,
    );

    assert.equal(
      pool.rollbackCount,
      1,
    );
  },
);


test(
  "claim references cannot cross tenant boundaries",
  async () => {
    const pool =
      createMemoryPool({
        tenantId:
          "tenant_alpha",
      });

    const repository =
      createClaimIngestionRepository(
        pool,
        {
          allowLegacyTenantContext:
            true,
        },
      );

    await assert.rejects(
      () =>
        runWithTenantContext(
          {
            tenant_id:
              "tenant_beta",
          },
          () =>
            repository.ingestClaims({
              claims: [
                claimInput({
                  claimId:
                    "C-CROSS-TENANT",
                }),
              ],
            }),
        ),
      ClaimReferenceValidationError,
    );

    assert.equal(
      pool.claims.size,
      0,
    );

    assert.equal(
      pool.claimVersions.size,
      0,
    );

    assert.equal(
      pool.outbox.size,
      0,
    );

    assert.equal(
      pool.rollbackCount,
      1,
    );
  },
);
