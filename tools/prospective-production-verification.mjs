#!/usr/bin/env node

import crypto from "node:crypto";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import {
  createControlPlanePool,
  createControlPlaneRepositories,
  createControlPlaneService,
} from "../packages/control-plane-database/src/index.js";
import {
  CANONICAL_OPERATIONAL_SCHEMA_VERSION,
  createLegacySharedAdapter,
  createOperationalRepositories,
  createTenantConnectionManager,
} from "../packages/database/src/index.js";
import {
  createControlPlaneDataPlaneRouteResolver,
} from "../apps/api/src/data-plane-route-resolver.js";
import {
  createPrivateDatabaseAdapter,
} from "../apps/api/src/private-database-adapter.js";
import {
  resolveDetectionModelSelection,
} from "../apps/api/src/detection-model-selection.js";

const EXPECTED = Object.freeze({
  subscriptionId: "896d3c72-d979-4bdc-a37f-060988d12032",
  resourceGroup: "ClaimGuard",
  vault: "claimguard-kv-ufs",
  apiApp: "claimguard-api",
  apiOrigin: "https://claimguard-api.azurewebsites.net",
  workerJob: "claimguard-report-producer",
  workerContainer: "report-producer",
  workerCron: "0 0 1 1 *",
  modelApp: "claimguard-ml-prospective",
  routeType: "private_database",
  schemaVersion: CANONICAL_OPERATIONAL_SCHEMA_VERSION,
});

const CONTROL_PLANE_SECRET =
  "claimguard--api--control-plane-mysql-url";
const LEGACY_OPERATIONAL_SECRET =
  "claimguard--api--mysql-url";
const ACTOR = "codex-production-verification";
const TOOL_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const STATE_VERSION = 1;
let TARGET = null;

function parseOptions(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!flag?.startsWith("--") || value === undefined) {
      fail(`Invalid option sequence beginning at ${JSON.stringify(flag)}.`);
    }
    const name = flag.slice(2);
    if (values[name] !== undefined) {
      fail(`Option ${flag} was supplied more than once.`);
    }
    values[name] = value;
  }
  return values;
}

function targetFromOptions(command, options) {
  const organisationId = options["organisation-id"];
  assert(
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
      .test(organisationId || ""),
    "--organisation-id must be a UUID.",
  );
  const resolveOnly = command === "resolve";
  const modelDeploymentId = options["model-deployment-id"];
  assert(
    /^[A-Za-z0-9._-]+:[A-Za-z0-9._-]+$/.test(
      modelDeploymentId || "",
    ),
    "--model-deployment-id must be a versioned deployment identifier.",
  );
  const canonicalSlug = options["organisation-slug"] || null;
  const schemeId = options["scheme-id"] || null;
  const claimPrefix = options["claim-prefix"] || null;
  const expectedCurrentModelDeploymentId =
    options["expected-current-model-deployment-id"] || null;
  const expectedCurrentStrategyId =
    options["expected-current-strategy-id"] || null;
  const allowedOptions = resolveOnly
    ? ["organisation-id", "model-deployment-id"]
    : [
        "organisation-id",
        "organisation-slug",
        "scheme-id",
        "claim-prefix",
        "model-deployment-id",
        ...(
          ["audit", "activate"].includes(command)
            ? [
                "expected-current-model-deployment-id",
                ...(
                  command === "activate"
                    ? ["expected-current-strategy-id"]
                    : []
                ),
              ]
            : []
        ),
      ];
  for (const name of Object.keys(options)) {
    assert(
      allowedOptions.includes(name),
      `Unsupported option --${name} for ${command}.`,
    );
  }
  if (!resolveOnly) {
    assert(
      /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(canonicalSlug || ""),
      "--organisation-slug must be an exact canonical slug.",
    );
    assert(
      /^[A-Z0-9_-]{2,24}$/.test(schemeId || ""),
      "--scheme-id must contain 2-24 uppercase letters, digits, '_' or '-'.",
    );
    assert(
      /^[A-Z0-9]{2,5}$/.test(claimPrefix || ""),
      "--claim-prefix must contain 2-5 uppercase letters or digits.",
    );
  }
  if (["audit", "activate"].includes(command)) {
    assert(
      /^[A-Za-z0-9._:-]+$/.test(
        expectedCurrentModelDeploymentId || "",
      ),
      "--expected-current-model-deployment-id is required for this phase.",
    );
  }
  if (command === "activate") {
    assert(
      /^[1-9][0-9]*$/.test(
        expectedCurrentStrategyId || "",
      ),
      "--expected-current-strategy-id must be a positive integer.",
    );
  }
  return Object.freeze({
    organisationId,
    canonicalSlug,
    schemeId,
    claimPrefix,
    modelDeploymentId,
    expectedCurrentModelDeploymentId,
    expectedCurrentStrategyId:
      expectedCurrentStrategyId === null
        ? null
        : Number(expectedCurrentStrategyId),
    statePath: path.join(
      TOOL_DIRECTORY,
      ".prospective-production-verification-state-"
      + `${organisationId}-${schemeId?.toLowerCase() || "resolve"}.json`,
    ),
  });
}

function fail(message) {
  throw new Error(message);
}

function assertEqual(actual, expected, label) {
  if (actual !== expected) {
    fail(
      `${label} mismatch: expected ${JSON.stringify(expected)}, `
      + `received ${JSON.stringify(actual)}.`,
    );
  }
}

function assert(condition, message) {
  if (!condition) {
    fail(message);
  }
}

function az(args, { json = false } = {}) {
  const output = execFileSync(
    "az",
    [...args, "--only-show-errors"],
    {
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    },
  ).trim();
  return json ? JSON.parse(output || "null") : output;
}

function secretValue(name) {
  const value = az([
    "keyvault",
    "secret",
    "show",
    "--vault-name",
    EXPECTED.vault,
    "--name",
    name,
    "--query",
    "value",
    "--output",
    "tsv",
  ]);
  assert(value, `Key Vault secret ${name} is empty.`);
  return value;
}

function appSettings() {
  const rows = az([
    "webapp",
    "config",
    "appsettings",
    "list",
    "--resource-group",
    EXPECTED.resourceGroup,
    "--name",
    EXPECTED.apiApp,
    "--output",
    "json",
  ], { json: true });
  return Object.fromEntries(
    rows.map(({ name, value }) => [name, value]),
  );
}

function mergeEnvironment(existing, replacements) {
  const merged = new Map(
    (existing || []).map((entry) => [entry.name, { ...entry }]),
  );
  for (const [name, value] of Object.entries(replacements)) {
    merged.set(name, { name, value });
  }
  return [...merged.values()];
}

function azurePreflight() {
  const account = az([
    "account",
    "show",
    "--output",
    "json",
  ], { json: true });
  assertEqual(
    account.id,
    EXPECTED.subscriptionId,
    "Azure subscription",
  );

  const settings = appSettings();
  assertEqual(
    settings.APPROVED_MODEL_DEPLOYMENT_IDS,
    TARGET.modelDeploymentId,
    "API approved deployment allowlist",
  );
  assertEqual(
    settings.CLAIMGUARD_MANAGED_MODEL_DEPLOYMENT_ID,
    TARGET.modelDeploymentId,
    "API managed deployment",
  );

  const worker = az([
    "containerapp",
    "job",
    "show",
    "--resource-group",
    EXPECTED.resourceGroup,
    "--name",
    EXPECTED.workerJob,
    "--output",
    "json",
  ], { json: true });
  assertEqual(
    worker?.properties?.configuration?.scheduleTriggerConfig
      ?.cronExpression,
    EXPECTED.workerCron,
    "Worker schedule",
  );
  assertEqual(
    worker?.properties?.configuration?.scheduleTriggerConfig
      ?.parallelism,
    1,
    "Worker parallelism",
  );
  assertEqual(
    worker?.properties?.configuration?.scheduleTriggerConfig
      ?.replicaCompletionCount,
    1,
    "Worker replica completion count",
  );

  const workerContainer =
    worker?.properties?.template?.containers?.find(
      ({ name }) => name === EXPECTED.workerContainer,
    );
  assert(workerContainer, "Expected report-worker container is missing.");
  const workerEnvironment = Object.fromEntries(
    workerContainer.env.map((entry) => [entry.name, entry.value]),
  );
  assertEqual(
    workerEnvironment.MODEL_SERVICE_DEPLOYMENT_ID,
    TARGET.modelDeploymentId,
    "Worker model deployment",
  );
  assertEqual(
    workerEnvironment.MODEL_SERVICE_ENDPOINT_PATH,
    "/v3/claim-screening",
    "Worker model endpoint",
  );

  const model = az([
    "containerapp",
    "show",
    "--resource-group",
    EXPECTED.resourceGroup,
    "--name",
    EXPECTED.modelApp,
    "--output",
    "json",
  ], { json: true });
  assertEqual(
    model?.properties?.provisioningState,
    "Succeeded",
    "Model provisioning state",
  );
  assertEqual(
    model?.properties?.runningStatus,
    "Running",
    "Model running state",
  );
  const modelEnvironment = Object.fromEntries(
    model?.properties?.template?.containers?.[0]?.env
      ?.map((entry) => [entry.name, entry.value]) || [],
  );
  assertEqual(
    modelEnvironment.CLAIMGUARD_MODEL_DEPLOYMENT_ID,
    TARGET.modelDeploymentId,
    "Model service deployment",
  );

  return {
    subscriptionId: account.id,
    api: {
      approvedModelDeploymentIds:
        settings.APPROVED_MODEL_DEPLOYMENT_IDS,
      managedModelDeploymentId:
        settings.CLAIMGUARD_MANAGED_MODEL_DEPLOYMENT_ID,
    },
    worker: {
      name: worker.name,
      cron:
        worker.properties.configuration
          .scheduleTriggerConfig.cronExpression,
      parallelism:
        worker.properties.configuration
          .scheduleTriggerConfig.parallelism,
      replicaCompletionCount:
        worker.properties.configuration
          .scheduleTriggerConfig.replicaCompletionCount,
      command: workerContainer.command,
      args: workerContainer.args,
      modelDeploymentId:
        workerEnvironment.MODEL_SERVICE_DEPLOYMENT_ID,
    },
    model: {
      name: model.name,
      provisioningState: model.properties.provisioningState,
      runningStatus: model.properties.runningStatus,
      deploymentId:
        modelEnvironment.CLAIMGUARD_MODEL_DEPLOYMENT_ID,
    },
    workerDefinition: worker,
    apiEnvironment: settings,
  };
}

async function openProduction({ requireIdentity = true } = {}) {
  const controlPlanePool = createControlPlanePool(
    secretValue(CONTROL_PLANE_SECRET),
  );
  const controlPlaneRepositories =
    createControlPlaneRepositories(controlPlanePool);
  const organisation =
    await controlPlaneRepositories.organisations.getById(
      TARGET.organisationId,
    );
  assert(
    organisation,
    "Expected organisation was not found.",
  );
  assertEqual(
    organisation.organisationId,
    TARGET.organisationId,
    "Organisation ID",
  );
  assertEqual(
    organisation.organisationType,
    "medical_scheme",
    "Organisation type",
  );
  if (requireIdentity) {
    assertEqual(
      organisation.canonicalSlug,
      TARGET.canonicalSlug,
      "Organisation canonical slug",
    );
  }

  const routeResolver =
    createControlPlaneDataPlaneRouteResolver({
      repositories: controlPlaneRepositories,
      supportedSchemaVersions: [EXPECTED.schemaVersion],
    });
  const correlationId = crypto.randomUUID();
  const context = await routeResolver.resolve({
    organisationId: TARGET.organisationId,
    actorId: ACTOR,
    correlationId,
  });
  assertEqual(
    context.organisationId,
    TARGET.organisationId,
    "Routed organisation",
  );
  assertEqual(
    context.operationalTenantId,
    TARGET.organisationId,
    "Operational tenant",
  );
  assertEqual(
    context.routeType,
    EXPECTED.routeType,
    "Route type",
  );
  assertEqual(
    context.schemaVersion,
    EXPECTED.schemaVersion,
    "Route schema",
  );
  assertEqual(
    context.logicalDatabaseIdentifier,
    `private:${TARGET.organisationId}`,
    "Logical database identifier",
  );

  const connectionManager = createTenantConnectionManager({
    adapters: {
      legacy_shared: createLegacySharedAdapter({
        databaseUrl: secretValue(LEGACY_OPERATIONAL_SECRET),
        expectedEnvironment: "legacy",
        supportedSchemaVersions: [EXPECTED.schemaVersion],
      }),
      private_database: createPrivateDatabaseAdapter({
        expectedEnvironment: "production",
        supportedSchemaVersions: [EXPECTED.schemaVersion],
      }),
    },
    maxPools: 2,
  });
  const acquired = await connectionManager.acquire(context);
  const repositories =
    createOperationalRepositories(context, acquired.pool);

  return {
    controlPlanePool,
    controlPlaneRepositories,
    controlPlaneService: createControlPlaneService({
      pool: controlPlanePool,
      repositories: controlPlaneRepositories,
    }),
    organisation,
    context,
    acquired,
    repositories,
    async close() {
      await acquired.release();
      await connectionManager.retireOrganisation(
        TARGET.organisationId,
        "verification_complete",
      );
      await controlPlanePool.end();
    },
  };
}

function safeRoute(production) {
  const { organisation, context, acquired } = production;
  return {
    organisation: {
      organisationId: organisation.organisationId,
      displayName: organisation.displayName,
      canonicalSlug: organisation.canonicalSlug,
      status: organisation.status,
      activationState: organisation.activationState,
      deploymentClass: organisation.deploymentClass,
    },
    route: {
      organisationId: context.organisationId,
      operationalTenantId: context.operationalTenantId,
      operationalTenantSlug: context.operationalTenantSlug,
      routeId: context.routeId,
      routeType: context.routeType,
      routeGeneration: context.routeGeneration,
      logicalDatabaseIdentifier:
        context.logicalDatabaseIdentifier,
      schemaVersion: context.schemaVersion,
      region: context.region,
      secretReferenceCount:
        String(context.secretReference || "")
          .split(",")
          .filter(Boolean)
          .length,
    },
    databaseMetadata: acquired.metadata,
  };
}

async function outboxSummary(pool) {
  const [rows] = await pool.execute(
    `
      SELECT
        status,
        job_type,
        COUNT(*) AS job_count
      FROM claim_processing_outbox
      WHERE tenant_id = ?
      GROUP BY status, job_type
      ORDER BY job_type, status
    `,
    [TARGET.organisationId],
  );
  const [eligible] = await pool.execute(
    `
      SELECT
        id,
        status,
        attempt_count,
        created_at
      FROM claim_processing_outbox
      WHERE tenant_id = ?
        AND job_type = 'claim_detection'
        AND status IN ('pending', 'retry')
        AND available_at <= UTC_TIMESTAMP(3)
      ORDER BY created_at, id
    `,
    [TARGET.organisationId],
  );
  const [processing] = await pool.execute(
    `
      SELECT id, attempt_count, created_at
      FROM claim_processing_outbox
      WHERE tenant_id = ?
        AND job_type = 'claim_detection'
        AND status = 'processing'
      ORDER BY created_at, id
    `,
    [TARGET.organisationId],
  );
  return {
    counts: rows.map((row) => ({
      status: row.status,
      jobType: row.job_type,
      count: Number(row.job_count),
    })),
    eligible: eligible.map((row) => ({
      id: row.id,
      status: row.status,
      attemptCount: Number(row.attempt_count),
      createdAt: row.created_at,
    })),
    processing: processing.map((row) => ({
      id: row.id,
      attemptCount: Number(row.attempt_count),
      createdAt: row.created_at,
    })),
  };
}

function requireCleanOutbox(summary, expectedJobId = null) {
  assertEqual(
    summary.processing.length,
    0,
    "Processing claim-detection job count",
  );
  if (expectedJobId === null) {
    assertEqual(
      summary.eligible.length,
      0,
      "Eligible claim-detection job count",
    );
    return;
  }
  assertEqual(
    summary.eligible.length,
    1,
    "Eligible claim-detection job count",
  );
  assertEqual(
    summary.eligible[0].id,
    expectedJobId,
    "Eligible claim-detection job",
  );
}

function loadState() {
  const state = JSON.parse(readFileSync(TARGET.statePath, "utf8"));
  assertEqual(state.version, STATE_VERSION, "State version");
  assertEqual(
    state.organisationId,
    TARGET.organisationId,
    "State organisation",
  );
  assertEqual(
    state.organisationSlug,
    TARGET.canonicalSlug,
    "State organisation slug",
  );
  assertEqual(state.schemeId, TARGET.schemeId, "State scheme ID");
  assertEqual(
    state.claimPrefix,
    TARGET.claimPrefix,
    "State claim prefix",
  );
  assertEqual(
    state.modelDeploymentId,
    TARGET.modelDeploymentId,
    "State model deployment",
  );
  return state;
}

function saveState(state) {
  writeFileSync(
    TARGET.statePath,
    `${JSON.stringify(state, null, 2)}\n`,
    { encoding: "utf8", mode: 0o600 },
  );
}

function dateOnly(offsetDays) {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + offsetDays);
  return date.toISOString().slice(0, 10);
}

function opaque(runTag, purpose, index) {
  return crypto
    .createHash("sha256")
    .update(`${runTag}:${purpose}:${index}`)
    .digest("hex");
}

function testBatch(runTag, schemeName) {
  const schemeId = TARGET.schemeId;
  const prefix = TARGET.claimPrefix;
  const members = [1, 2, 3].map((index) => ({
    member_id: `${prefix}-${runTag}-M${index}`,
    scheme_id: schemeId,
    first_name: opaque(runTag, "first", index),
    last_name: opaque(runTag, "last", index),
    date_of_birth: `19${78 + index * 4}-01-01`,
    gender: index === 2 ? "F" : "M",
    identity_number: opaque(runTag, "identity", index),
    banking_detail: opaque(runTag, "member-bank", index),
    home_region: index === 3 ? "Western Cape" : "Gauteng",
    home_lat: index === 3 ? -33.9 : -26.2,
    home_lon: index === 3 ? 18.4 : 28.0,
    join_date: "2020-01-01",
  }));
  const providers = [
    {
      provider_id: `${prefix}-${runTag}-P1`,
      scheme_id: schemeId,
      practice_number: opaque(runTag, "practice", 1),
      specialty: "GP",
      practice_name: `${schemeName} verification practice 1`,
      banking_detail: opaque(runTag, "provider-bank", 1),
      practice_region: "Gauteng",
      practice_lat: -26.2,
      practice_lon: 28.0,
      provider_kind: "PRACTICE",
      provider_category: "MEDICAL_PRACTICE",
    },
    {
      provider_id: `${prefix}-${runTag}-P2`,
      scheme_id: schemeId,
      practice_number: opaque(runTag, "practice", 2),
      specialty: "RAD",
      practice_name: `${schemeName} verification practice 2`,
      banking_detail: opaque(runTag, "provider-bank", 2),
      practice_region: "Gauteng",
      practice_lat: -25.7,
      practice_lon: 28.2,
      provider_kind: "PRACTICE",
      provider_category: "MEDICAL_PRACTICE",
    },
    {
      provider_id: `${prefix}-${runTag}-P3`,
      scheme_id: schemeId,
      practice_number: opaque(runTag, "practice", 3),
      specialty: "PHARM",
      practice_name: `${schemeName} verification pharmacy`,
      banking_detail: opaque(runTag, "provider-bank", 3),
      practice_region: "Western Cape",
      practice_lat: -33.9,
      practice_lon: 18.4,
      provider_kind: "FACILITY",
      provider_category: "PHARMACY_PRACTICE",
    },
  ];
  const serviceDate = dateOnly(-5);
  const receivedDate = dateOnly(0);
  const claims = [
    {
      claim_id: `${prefix}-${runTag}-C1`,
      scheme_id: schemeId,
      member_id: members[0].member_id,
      provider_id: providers[0].provider_id,
      service_date: serviceDate,
      received_date: receivedDate,
      billing_code: "0190",
      amount: 532.8,
      quantity: 1,
      benefit_option: "TANZANITE_ONE",
      network_type: "PREFERRED_NETWORK",
      line_type: "PROFESSIONAL_SERVICE",
      tariff_discipline: "014",
      diagnosis_code: "Z00.0",
      rendering_practitioner_id: `${prefix}-${runTag}-R1`,
      rendering_practitioner_category:
        "MED_GENERAL_PRACTITIONER",
      rendering_known_to_billing_provider: true,
    },
    {
      claim_id: `${prefix}-${runTag}-C2`,
      scheme_id: schemeId,
      member_id: members[1].member_id,
      provider_id: providers[1].provider_id,
      service_date: serviceDate,
      received_date: receivedDate,
      billing_code: "3605",
      amount: 14875,
      quantity: 3,
      benefit_option: "EMERALD_VALUE",
      network_type: "NON_NETWORK",
      line_type: "PROFESSIONAL_SERVICE",
      tariff_discipline: "RAD",
      diagnosis_code: "M54.5",
      rendering_practitioner_id: `${prefix}-${runTag}-R2`,
      rendering_practitioner_category: "MED_RADIOLOGY",
      rendering_known_to_billing_provider: false,
    },
    {
      claim_id: `${prefix}-${runTag}-C3`,
      scheme_id: schemeId,
      member_id: members[2].member_id,
      provider_id: providers[2].provider_id,
      service_date: serviceDate,
      received_date: receivedDate,
      billing_code: "798983019",
      amount: 36.82,
      quantity: 1,
      benefit_option: "TANZANITE_ONE",
      network_type: "NON_NETWORK",
      line_type: "MEDICINE",
      tariff_discipline: "PHARM",
      diagnosis_code: "J06.9",
      rendering_practitioner_id: null,
      rendering_practitioner_category: "NONE",
      rendering_known_to_billing_provider: false,
    },
  ];
  return {
    source: "prospective-production-verification",
    schemes: [{
      scheme_id: schemeId,
      scheme_name: `${schemeName} production verification`,
    }],
    members,
    providers,
    claims,
  };
}

async function readJob(production, state) {
  const [rows] = await production.acquired.pool.execute(
    `
      SELECT
        id,
        tenant_id,
        job_type,
        status,
        attempt_count,
        detection_strategy_id,
        strategy_type,
        model_deployment_id,
        payload,
        available_at,
        created_at,
        completed_at,
        failure_code,
        last_error
      FROM claim_processing_outbox
      WHERE tenant_id = ?
        AND id = ?
      LIMIT 2
    `,
    [TARGET.organisationId, state.jobId],
  );
  assertEqual(rows.length, 1, "Verification outbox row count");
  const row = rows[0];
  const payload = typeof row.payload === "string"
    ? JSON.parse(row.payload)
    : row.payload;
  return {
    id: row.id,
    tenantId: row.tenant_id,
    jobType: row.job_type,
    status: row.status,
    attemptCount: Number(row.attempt_count),
    detectionStrategyId: Number(row.detection_strategy_id),
    strategyType: row.strategy_type,
    modelDeploymentId: row.model_deployment_id,
    payload,
    availableAt: row.available_at,
    createdAt: row.created_at,
    completedAt: row.completed_at,
    failureCode: row.failure_code,
    lastError: row.last_error,
  };
}

function assertPinnedJob(job, state, { beforeWorker }) {
  assertEqual(job.tenantId, TARGET.organisationId, "Job tenant");
  assertEqual(job.jobType, "claim_detection", "Job type");
  assertEqual(job.strategyType, "approved_model", "Job strategy");
  assertEqual(
    job.modelDeploymentId,
    TARGET.modelDeploymentId,
    "Job model deployment",
  );
  if (beforeWorker) {
    assertEqual(job.status, "pending", "Job status");
    assertEqual(job.attemptCount, 0, "Job attempt count");
  }
  assertEqual(
    job.payload?.schema_version,
    2,
    "Job payload schema version",
  );
  assertEqual(
    job.payload?.dataset_scope,
    "triggering_claim_versions",
    "Job dataset scope",
  );
  const targets = [...(job.payload?.targets || [])]
    .sort((left, right) =>
      left.claim_id.localeCompare(right.claim_id));
  const expectedTargets = [...state.claimIds]
    .sort()
    .map((claimId) => ({
      claim_id: claimId,
      claim_version: 1,
    }));
  assertEqual(
    JSON.stringify(targets),
    JSON.stringify(expectedTargets),
    "Job targets",
  );
}

async function commandInspect() {
  const azure = azurePreflight();
  const production = await openProduction();
  try {
    const activeStrategy =
      await production.repositories.detectionStrategy
        .getActiveStrategy();
    if (
      activeStrategy.strategyType === "approved_model"
      && activeStrategy.modelDeploymentId
        !== TARGET.modelDeploymentId
    ) {
      fail(
        "Unexpected active model deployment "
        + activeStrategy.modelDeploymentId,
      );
    }
    return {
      azure: {
        subscriptionId: azure.subscriptionId,
        api: azure.api,
        worker: azure.worker,
        model: azure.model,
      },
      ...safeRoute(production),
      activeStrategy,
      outbox: await outboxSummary(production.acquired.pool),
    };
  } finally {
    await production.close();
  }
}

async function commandAudit() {
  const azure = azurePreflight();
  const production = await openProduction();
  try {
    const [strategyRows] =
      await production.acquired.pool.execute(
        `
          SELECT
            id,
            tenant_id,
            strategy_type,
            model_deployment_id,
            is_active,
            activated_at,
            deactivated_at,
            actor,
            change_reason,
            created_at,
            updated_at
          FROM detection_strategies
          WHERE tenant_id = ?
          ORDER BY activated_at DESC, id DESC
          LIMIT 25
        `,
        [TARGET.organisationId],
      );
    assert(
      Array.isArray(strategyRows) && strategyRows.length > 0,
      "No detection-strategy history was found.",
    );
    const activeRows = strategyRows.filter(
      ({ is_active: isActive }) => Number(isActive) === 1,
    );
    assertEqual(activeRows.length, 1, "Active strategy row count");
    assertEqual(
      activeRows[0].model_deployment_id,
      TARGET.expectedCurrentModelDeploymentId,
      "Current model deployment",
    );

    const [outboxRows] =
      await production.acquired.pool.execute(
        `
          SELECT
            strategy_type,
            model_deployment_id,
            status,
            COUNT(*) AS job_count,
            MIN(created_at) AS first_created_at,
            MAX(created_at) AS last_created_at
          FROM claim_processing_outbox
          WHERE tenant_id = ?
          GROUP BY strategy_type, model_deployment_id, status
          ORDER BY model_deployment_id, status
        `,
        [TARGET.organisationId],
      );

    const [auditRows] =
      await production.controlPlanePool.execute(
        `
          SELECT
            audit_event_id,
            actor_type,
            actor_id,
            action,
            target_type,
            target_id,
            correlation_id,
            occurred_at,
            outcome,
            source
          FROM platform_audit_events
          WHERE organisation_scope_id = ?
          ORDER BY occurred_at DESC
          LIMIT 50
        `,
        [TARGET.organisationId],
      );

    return {
      azure: {
        api: azure.api,
        worker: azure.worker,
        model: azure.model,
      },
      ...safeRoute(production),
      activeStrategy: {
        strategyId: Number(activeRows[0].id),
        strategyType: activeRows[0].strategy_type,
        modelDeploymentId:
          activeRows[0].model_deployment_id,
        activatedAt: activeRows[0].activated_at,
        actor: activeRows[0].actor,
        changeReason: activeRows[0].change_reason,
      },
      strategyHistory: strategyRows.map((row) => ({
        strategyId: Number(row.id),
        strategyType: row.strategy_type,
        modelDeploymentId: row.model_deployment_id,
        isActive: Number(row.is_active) === 1,
        activatedAt: row.activated_at,
        deactivatedAt: row.deactivated_at,
        actor: row.actor,
        changeReason: row.change_reason,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      })),
      outboxByDeployment: outboxRows.map((row) => ({
        strategyType: row.strategy_type,
        modelDeploymentId: row.model_deployment_id,
        status: row.status,
        count: Number(row.job_count),
        firstCreatedAt: row.first_created_at,
        lastCreatedAt: row.last_created_at,
      })),
      controlPlaneAudit: auditRows.map((row) => ({
        auditEventId: row.audit_event_id,
        actorType: row.actor_type,
        actorId: row.actor_id,
        action: row.action,
        targetType: row.target_type,
        targetId: row.target_id,
        correlationId: row.correlation_id,
        occurredAt: row.occurred_at,
        outcome: row.outcome,
        source: row.source,
      })),
    };
  } finally {
    await production.close();
  }
}

async function commandResolve() {
  const azure = azurePreflight();
  const production = await openProduction({ requireIdentity: false });
  try {
    return {
      azure: {
        subscriptionId: azure.subscriptionId,
        workerCron: azure.worker.cron,
        modelDeploymentId: azure.model.deploymentId,
      },
      ...safeRoute(production),
      nextStep: {
        organisationSlug: production.organisation.canonicalSlug,
        instruction:
          "Pass this exact canonical slug to every non-resolve command.",
      },
    };
  } finally {
    await production.close();
  }
}

async function commandActivate() {
  const azure = azurePreflight();
  const production = await openProduction();
  const previousApprovedDeployments =
    process.env.APPROVED_MODEL_DEPLOYMENT_IDS;
  try {
    const before =
      await production.repositories.detectionStrategy
        .getActiveStrategy();
    assertEqual(
      before.strategyId,
      TARGET.expectedCurrentStrategyId,
      "Current strategy ID",
    );
    assertEqual(
      before.modelDeploymentId,
      TARGET.expectedCurrentModelDeploymentId,
      "Current model deployment",
    );
    const resolved = resolveDetectionModelSelection(
      {
        strategyType: "claimguard_managed",
        modelDeploymentId: null,
      },
      { tenant_id: production.context.operationalTenantId },
      azure.apiEnvironment,
    );
    assertEqual(
      resolved.repositoryChange.modelDeploymentId,
      TARGET.modelDeploymentId,
      "Resolved managed deployment",
    );
    process.env.APPROVED_MODEL_DEPLOYMENT_IDS =
      azure.api.approvedModelDeploymentIds;
    const after =
      await production.repositories.detectionStrategy.setStrategy(
        null,
        {
          ...resolved.repositoryChange,
          actor: ACTOR,
          changeReason:
            "Activate the PR #67 prospective baseline for a controlled "
            + `three-claim ${TARGET.canonicalSlug} production verification.`,
          expectedActiveStrategyId:
            TARGET.expectedCurrentStrategyId,
        },
      );
    return {
      ...safeRoute(production),
      before,
      operation: {
        publicSelection: resolved.publicSelection,
        actor: ACTOR,
        expectedCurrentStrategyId:
          TARGET.expectedCurrentStrategyId,
        expectedCurrentModelDeploymentId:
          TARGET.expectedCurrentModelDeploymentId,
      },
      after,
    };
  } finally {
    if (previousApprovedDeployments === undefined) {
      delete process.env.APPROVED_MODEL_DEPLOYMENT_IDS;
    } else {
      process.env.APPROVED_MODEL_DEPLOYMENT_IDS =
        previousApprovedDeployments;
    }
    await production.close();
  }
}

async function commandIngest() {
  azurePreflight();
  let existingState = null;
  try {
    existingState = loadState();
  } catch {
    // A missing state file is required for a fresh controlled run.
  }
  assert(
    !existingState,
    `State already exists at ${TARGET.statePath}; refusing a second ingestion.`,
  );
  const production = await openProduction();
  const runTag = new Date()
    .toISOString()
    .replace(/\D/g, "")
    .slice(2, 14);
  const requestId =
    `${TARGET.claimPrefix.toLowerCase()}-prod-verify-${runTag}`;
  const batch = testBatch(
    runTag,
    production.organisation.displayName,
  );
  const state = {
    version: STATE_VERSION,
    organisationId: TARGET.organisationId,
    organisationSlug: TARGET.canonicalSlug,
    schemeId: TARGET.schemeId,
    claimPrefix: TARGET.claimPrefix,
    modelDeploymentId: TARGET.modelDeploymentId,
    runTag,
    requestId,
    claimIds: batch.claims.map(({ claim_id }) => claim_id),
    createdAt: new Date().toISOString(),
    ingestionStatus: "prepared",
    workerStarted: false,
  };
  saveState(state);

  let credential = null;
  let response = null;
  let responseBody = null;
  let revokeResult = null;
  let requestError = null;
  try {
    const activeStrategy =
      await production.repositories.detectionStrategy
        .getActiveStrategy();
    assertEqual(
      activeStrategy.strategyType,
      "approved_model",
      "Active strategy before ingestion",
    );
    assertEqual(
      activeStrategy.modelDeploymentId,
      TARGET.modelDeploymentId,
      "Active deployment before ingestion",
    );
    requireCleanOutbox(
      await outboxSummary(production.acquired.pool),
    );

    credential =
      await production.controlPlaneService
        .createIntegrationCredential(
          {
            organisationId: TARGET.organisationId,
            displayName:
              `${production.organisation.displayName} verification ${runTag}`,
            serviceActorId:
              `${TARGET.claimPrefix.toLowerCase()}-prod-verify-${runTag}`,
            expiresAt: new Date(Date.now() + 60 * 60 * 1000),
          },
          {
            type: "system",
            id: ACTOR,
            source: "checked-in-production-verifier",
            correlationId: requestId,
          },
        );
    state.integrationCredentialId =
      credential.credential.integrationCredentialId;
    saveState(state);

    try {
      response = await fetch(
        `${EXPECTED.apiOrigin}/claims/ingest`,
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${credential.bearerToken}`,
            "content-type": "application/json",
            "x-request-id": requestId,
          },
          body: JSON.stringify(batch),
          signal: AbortSignal.timeout(30_000),
        },
      );
      responseBody = await response.json();
    } catch (error) {
      requestError = error;
    }
  } finally {
    if (credential) {
      try {
        revokeResult =
          await production.controlPlaneService
            .revokeIntegrationCredential(
              {
                organisationId: TARGET.organisationId,
                integrationCredentialId:
                  credential.credential.integrationCredentialId,
              },
              {
                type: "system",
                id: ACTOR,
                source: "checked-in-production-verifier",
                correlationId: requestId,
              },
            );
      } catch (error) {
        state.credentialRevocationError =
          error?.message || String(error);
      }
    }
    state.credentialStatus = revokeResult?.status || "unknown";
    saveState(state);
    await production.close();
  }

  if (state.credentialStatus !== "revoked") {
    fail(
      "Temporary integration credential was not confirmed revoked.",
    );
  }
  if (requestError) {
    fail(
      `Ingestion request failed: ${requestError.message}. `
      + `Use the saved claim IDs to recover state; do not resubmit blindly.`,
    );
  }
  assertEqual(response.status, 202, "Ingestion HTTP status");
  assertEqual(responseBody?.committed, true, "Ingestion commit");
  const jobId = responseBody?.processing?.jobId;
  assert(jobId, "Ingestion response did not return a job ID.");
  state.jobId = jobId;
  state.ingestionStatus = "committed";
  state.ingestionResponse = responseBody;
  saveState(state);
  return {
    requestId,
    httpStatus: response.status,
    claimIds: state.claimIds,
    jobId,
    processing: responseBody.processing,
    ingestion: {
      received: responseBody.ingestion?.received,
      inserted: responseBody.ingestion?.inserted,
      updated: responseBody.ingestion?.updated,
    },
    temporaryCredential: {
      credentialId: state.integrationCredentialId,
      status: state.credentialStatus,
    },
    statePath: TARGET.statePath,
  };
}

async function commandVerifyJob() {
  const azure = azurePreflight();
  const state = loadState();
  assertEqual(
    state.ingestionStatus,
    "committed",
    "Saved ingestion status",
  );
  const production = await openProduction();
  try {
    const job = await readJob(production, state);
    assertPinnedJob(job, state, { beforeWorker: true });
    const summary = await outboxSummary(production.acquired.pool);
    requireCleanOutbox(summary, state.jobId);
    return {
      azure: {
        workerCron: azure.worker.cron,
        workerModelDeploymentId:
          azure.worker.modelDeploymentId,
      },
      ...safeRoute(production),
      job,
      eligibleJobs: summary.eligible,
    };
  } finally {
    await production.close();
  }
}

function executionTemplate(worker) {
  const containers = worker?.properties?.template?.containers;
  assert(
    Array.isArray(containers) && containers.length === 1,
    "Worker must have exactly one container.",
  );
  const container = structuredClone(containers[0]);
  assertEqual(
    container.name,
    EXPECTED.workerContainer,
    "Worker container name",
  );
  container.args = ["worker", "once"];
  container.env = mergeEnvironment(
    container.env,
    {
      INTERNAL_SERVICE_ORGANISATION_IDS:
        TARGET.organisationId,
      REPORT_WORKER_ORGANISATION_ID: TARGET.organisationId,
      REPORT_WORKER_BATCH_SIZE: "1",
      REPORT_WORKER_MAX_BATCHES_PER_RUN: "1",
    },
  );
  return {
    containers: [container],
    ...(
      worker?.properties?.template?.initContainers
        ? {
            initContainers:
              worker.properties.template.initContainers,
          }
        : {}
    ),
  };
}

function assertNoActiveWorkerExecutions() {
  const executions = az([
    "containerapp",
    "job",
    "execution",
    "list",
    "--resource-group",
    EXPECTED.resourceGroup,
    "--name",
    EXPECTED.workerJob,
    "--output",
    "json",
  ], { json: true });
  const activeExecutions = executions.filter(({ properties }) =>
    ["Running", "Processing", "Starting"]
      .includes(properties?.status));
  assertEqual(
    activeExecutions.length,
    0,
    "Active worker execution count",
  );
}

function startWorkerExecution(workerDefinition) {
  const temporaryDirectory = mkdtempSync(
    path.join(os.tmpdir(), "claimguard-worker-execution-"),
  );
  const templatePath = path.join(
    temporaryDirectory,
    "execution.json",
  );
  writeFileSync(
    templatePath,
    JSON.stringify(executionTemplate(workerDefinition)),
    { encoding: "utf8", mode: 0o600 },
  );
  try {
    return az([
      "containerapp",
      "job",
      "start",
      "--resource-group",
      EXPECTED.resourceGroup,
      "--name",
      EXPECTED.workerJob,
      "--yaml",
      templatePath,
      "--output",
      "json",
    ], { json: true });
  } finally {
    rmSync(temporaryDirectory, {
      recursive: true,
      force: true,
    });
  }
}

async function commandStartWorker() {
  const state = loadState();
  assertEqual(state.workerStarted, false, "Worker-start guard");
  const azure = azurePreflight();
  const production = await openProduction();
  try {
    const job = await readJob(production, state);
    assertPinnedJob(job, state, { beforeWorker: true });
    requireCleanOutbox(
      await outboxSummary(production.acquired.pool),
      state.jobId,
    );
    assertNoActiveWorkerExecutions();
    const execution =
      startWorkerExecution(azure.workerDefinition);
    assert(execution?.name, "Worker start returned no execution name.");
    state.workerStarted = true;
    state.workerStartedAt = new Date().toISOString();
    state.workerExecutionName = execution.name;
    saveState(state);
    return {
      executionName: execution.name,
      executionStatus: execution?.properties?.status || null,
      override: {
        organisationId: TARGET.organisationId,
        internalServiceOrganisationIds:
          TARGET.organisationId,
        args: ["worker", "once"],
        batchSize: 1,
        maximumBatchesPerRun: 1,
      },
      recurringDefinition: {
        cron: azure.worker.cron,
        args: azure.worker.args,
      },
    };
  } finally {
    await production.close();
  }
}

async function commandRecoverWorker() {
  const state = loadState();
  assertEqual(state.workerStarted, true, "Worker-start state");
  assertEqual(
    state.workerRecoveryStarted,
    undefined,
    "Worker-recovery guard",
  );
  const failedExecution = az([
    "containerapp",
    "job",
    "execution",
    "show",
    "--resource-group",
    EXPECTED.resourceGroup,
    "--name",
    EXPECTED.workerJob,
    "--job-execution-name",
    state.workerExecutionName,
    "--output",
    "json",
  ], { json: true });
  assertEqual(
    failedExecution?.properties?.status,
    "Failed",
    "Recoverable worker execution status",
  );
  const failedEnvironment = Object.fromEntries(
    failedExecution?.properties?.template?.containers?.[0]?.env
      ?.map(({ name, value }) => [name, value]) || [],
  );
  assertEqual(
    failedEnvironment.REPORT_WORKER_ORGANISATION_ID,
    TARGET.organisationId,
    "Failed execution organisation",
  );
  assert(
    !failedEnvironment.INTERNAL_SERVICE_ORGANISATION_IDS,
    "Recovery is allowed only for the known missing service-scope allowlist.",
  );

  const azure = azurePreflight();
  const production = await openProduction();
  try {
    const job = await readJob(production, state);
    assertPinnedJob(job, state, { beforeWorker: true });
    requireCleanOutbox(
      await outboxSummary(production.acquired.pool),
      state.jobId,
    );
    assertNoActiveWorkerExecutions();
    const execution =
      startWorkerExecution(azure.workerDefinition);
    assert(
      execution?.name,
      "Worker recovery start returned no execution name.",
    );
    state.failedWorkerExecutionName =
      state.workerExecutionName;
    state.workerRecoveryStarted = true;
    state.workerRecoveryStartedAt =
      new Date().toISOString();
    state.workerExecutionName = execution.name;
    saveState(state);
    return {
      failedExecutionName:
        state.failedWorkerExecutionName,
      recoveryExecutionName: execution.name,
      recoveryExecutionStatus:
        execution?.properties?.status || null,
      precondition: {
        jobStatus: job.status,
        attemptCount: job.attemptCount,
        priorFailureOccurredBeforeLease: true,
      },
      override: {
        organisationId: TARGET.organisationId,
        internalServiceOrganisationIds:
          TARGET.organisationId,
        args: ["worker", "once"],
        batchSize: 1,
        maximumBatchesPerRun: 1,
      },
      recurringDefinition: {
        cron: azure.worker.cron,
        args: azure.worker.args,
      },
    };
  } finally {
    await production.close();
  }
}

function commandWorkerStatus() {
  const state = loadState();
  assertEqual(state.workerStarted, true, "Worker-start state");
  const execution = az([
    "containerapp",
    "job",
    "execution",
    "show",
    "--resource-group",
    EXPECTED.resourceGroup,
    "--name",
    EXPECTED.workerJob,
    "--job-execution-name",
    state.workerExecutionName,
    "--output",
    "json",
  ], { json: true });
  return {
    executionName: execution.name,
    status: execution?.properties?.status,
    startTime: execution?.properties?.startTime,
    endTime: execution?.properties?.endTime,
    template: {
      args:
        execution?.properties?.template?.containers?.[0]?.args,
      environment: Object.fromEntries(
        execution?.properties?.template?.containers?.[0]?.env
          ?.filter(({ name }) => [
            "INTERNAL_SERVICE_ORGANISATION_IDS",
            "REPORT_WORKER_ORGANISATION_ID",
            "REPORT_WORKER_BATCH_SIZE",
            "REPORT_WORKER_MAX_BATCHES_PER_RUN",
            "MODEL_SERVICE_DEPLOYMENT_ID",
          ].includes(name))
          .map(({ name, value }) => [name, value]) || [],
      ),
    },
  };
}

function resultProjection(row) {
  const payload = typeof row.result_payload === "string"
    ? JSON.parse(row.result_payload)
    : row.result_payload;
  return {
    tenantId: row.tenant_id,
    claimId: row.claim_id,
    claimVersion: Number(row.claim_version),
    detectionStrategyId: Number(row.detection_strategy_id),
    strategyType: row.strategy_type,
    modelDeploymentId: row.model_deployment_id,
    sourceJobId: row.source_job_id,
    requestId: row.request_id,
    analysisMode: row.analysis_mode,
    modelId: row.ensemble_id,
    modelVersion: row.ensemble_version,
    featureSchemaVersion: row.feature_schema_version,
    scoredAt: row.scored_at,
    resultHash: row.result_hash,
    score: payload?.score,
  };
}

async function commandVerifyResults() {
  const state = loadState();
  assertEqual(state.workerStarted, true, "Worker-start state");
  const azure = azurePreflight();
  const execution = commandWorkerStatus();
  assertEqual(execution.status, "Succeeded", "Worker execution");
  const production = await openProduction();
  try {
    const job = await readJob(production, state);
    assertPinnedJob(job, state, { beforeWorker: false });
    assertEqual(job.status, "completed", "Completed job status");
    assertEqual(job.attemptCount, 1, "Completed job attempt count");
    assertEqual(job.failureCode, null, "Completed job failure code");
    assertEqual(job.lastError, null, "Completed job error");

    const placeholders =
      state.claimIds.map(() => "?").join(", ");
    const [resultRows] = await production.acquired.pool.execute(
      `
        SELECT
          tenant_id,
          claim_id,
          claim_version,
          detection_strategy_id,
          strategy_type,
          model_deployment_id,
          source_job_id,
          request_id,
          analysis_mode,
          ensemble_id,
          ensemble_version,
          feature_schema_version,
          scored_at,
          result_payload,
          result_hash
        FROM claim_detection_results
        WHERE tenant_id = ?
          AND source_job_id = ?
          AND claim_id IN (${placeholders})
        ORDER BY claim_id
      `,
      [
        TARGET.organisationId,
        state.jobId,
        ...state.claimIds,
      ],
    );
    assertEqual(
      resultRows.length,
      3,
      "Persisted detection-result count",
    );
    const results = resultRows.map(resultProjection);
    for (const result of results) {
      assertEqual(
        result.tenantId,
        TARGET.organisationId,
        "Result tenant",
      );
      assertEqual(
        result.claimVersion,
        1,
        "Result claim version",
      );
      assertEqual(
        result.strategyType,
        "approved_model",
        "Result strategy",
      );
      assertEqual(
        result.modelDeploymentId,
        TARGET.modelDeploymentId,
        "Result model deployment",
      );
      assertEqual(
        result.sourceJobId,
        state.jobId,
        "Result source job",
      );
      assertEqual(
        result.analysisMode,
        "PROSPECTIVE_CLAIM_SCREENING",
        "Result analysis mode",
      );
      assert(
        /^[0-9a-f]{64}$/.test(result.resultHash),
        "Result hash is not a SHA-256 digest.",
      );
    }

    const claims = [];
    for (const claimId of state.claimIds) {
      const claim =
        await production.repositories.claimsRead
          .getClaimById(claimId);
      assert(claim, `Claim ${claimId} was not found.`);
      assertEqual(
        claim.processingStatus,
        "scored",
        `Claim ${claimId} processing status`,
      );
      claims.push({
        claimId,
        claimVersion: claim.claimVersion,
        processingStatus: claim.processingStatus,
        status: claim.status,
        riskScore: claim.riskScore,
        riskLevel: claim.riskLevel,
        reviewRecommended:
          claim.detection?.reviewRecommended,
        modelDeploymentId:
          claim.processing?.modelDeploymentId
          || claim.detection?.modelDeploymentId,
      });
    }

    return {
      execution,
      recurringWorker: {
        cron: azure.worker.cron,
        modelDeploymentId:
          azure.worker.modelDeploymentId,
      },
      ...safeRoute(production),
      job,
      results,
      claims,
    };
  } finally {
    await production.close();
  }
}

const COMMANDS = Object.freeze({
  resolve: commandResolve,
  audit: commandAudit,
  inspect: commandInspect,
  activate: commandActivate,
  ingest: commandIngest,
  "verify-job": commandVerifyJob,
  "start-worker": commandStartWorker,
  "recover-worker": commandRecoverWorker,
  "worker-status": commandWorkerStatus,
  "verify-results": commandVerifyResults,
});

async function main() {
  const command = process.argv[2];
  const operation = COMMANDS[command];
  if (!operation) {
    fail(
      "Usage: node tools/prospective-production-verification.mjs "
      + "<resolve|audit|inspect|activate|ingest|verify-job|start-worker|"
      + "recover-worker|worker-status|verify-results> "
      + "--organisation-id <uuid> "
      + "--model-deployment-id <name:version> "
      + "[--organisation-slug <canonical-slug> "
      + "--scheme-id <scheme-id> --claim-prefix <2-5-chars>]",
    );
  }
  TARGET = targetFromOptions(
    command,
    parseOptions(process.argv.slice(3)),
  );
  const result = await operation();
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(
    `${JSON.stringify({
      ok: false,
      error: error?.message || String(error),
    }, null, 2)}\n`,
  );
  process.exitCode = 1;
});
