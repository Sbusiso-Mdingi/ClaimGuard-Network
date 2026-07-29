#!/usr/bin/env node

import { execFileSync } from "node:child_process";

import {
  createControlPlanePool,
} from "../packages/control-plane-database/src/index.js";

const EXPECTED = Object.freeze({
  subscriptionId: "896d3c72-d979-4bdc-a37f-060988d12032",
  tenantId: "8efc1bb9-b90f-4a48-bf6c-ba0686193b80",
  resourceGroup: "ClaimGuard",
  location: "southafricanorth",
  vaultName: "claimguard-kv-ufs",
  controlPlaneSecretName: "claimguard--api--control-plane-mysql-url",
  apiAppName: "claimguard-api",
  releaseAppName: "claimguard-ml-ensemble-211",
  eventJobName: "claimguard-report-producer",
  recoveryJobName: "claimguard-report-recovery",
  baselineDeploymentId: "claimguard-claim-fraud-baseline:1.0.0",
  deploymentId: "claimguard-claim-fraud-ensemble:2.1.1",
  approvedDeploymentIds:
    "claimguard-claim-fraud-baseline:1.0.0,"
    + "claimguard-claim-fraud-ensemble:2.1.1",
  artifactSha256:
    "644bbefaf14ac13c7eeb69965d6d53d29d150b632ec485b4bf9fd47297773d62",
  candidateImageDigest:
    "claimguardacr11e.azurecr.io/claimguard/"
    + "ensemble2-prospective-model-service"
    + "@sha256:423a6f88b8fb28580c47950676714237"
    + "f72b73f7273acbad21806afd06c8fd1a",
  releaseImageDigest:
    "claimguardacr11e.azurecr.io/claimguard/"
    + "ensemble2-prospective-model-service"
    + "@sha256:0a4b771e8453b6f891e35b5a2921c2c"
    + "840325ffd29bf773aa7989f5ef4241b2c",
});

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ACTIVE_EXECUTION_STATES = new Set([
  "Running",
  "Processing",
  "Starting",
]);

function fail(message) {
  throw new Error(message);
}

function assert(condition, message) {
  if (!condition) fail(message);
}

function assertEqual(actual, expected, label) {
  if (actual !== expected) {
    fail(
      `${label} mismatch: expected ${JSON.stringify(expected)}, `
      + `received ${JSON.stringify(actual)}.`,
    );
  }
}

function parseOptions(argv) {
  assert(
    argv.length === 2 && argv[0] === "--audit-event-id",
    "Usage: verify-production-model-activation.mjs "
      + "--audit-event-id <uuid>",
  );
  assert(
    UUID_PATTERN.test(argv[1] || ""),
    "--audit-event-id must be a UUID.",
  );
  return Object.freeze({ auditEventId: argv[1].toLowerCase() });
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
    EXPECTED.vaultName,
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

function parseJson(value, label) {
  try {
    return typeof value === "string" ? JSON.parse(value) : value;
  } catch {
    fail(`${label} is not valid JSON.`);
  }
}

function containerArgs(job) {
  return job?.properties?.template?.containers?.[0]?.args || [];
}

function environmentValue(job, name) {
  return job?.properties?.template?.containers?.[0]?.env
    ?.find((entry) => entry.name === name)?.value;
}

async function main() {
  const { auditEventId } = parseOptions(process.argv.slice(2));
  const account = az(["account", "show", "--output", "json"], { json: true });
  assertEqual(account.id, EXPECTED.subscriptionId, "Azure subscription");
  assertEqual(account.tenantId, EXPECTED.tenantId, "Azure tenant");
  assertEqual(
    az([
      "group",
      "show",
      "--name",
      EXPECTED.resourceGroup,
      "--query",
      "location",
      "--output",
      "tsv",
    ]),
    EXPECTED.location,
    "Azure resource-group location",
  );

  const settings = Object.fromEntries(
    az([
      "webapp",
      "config",
      "appsettings",
      "list",
      "--resource-group",
      EXPECTED.resourceGroup,
      "--name",
      EXPECTED.apiAppName,
      "--output",
      "json",
    ], { json: true }).map(({ name, value }) => [name, value]),
  );
  assertEqual(
    settings.APPROVED_MODEL_DEPLOYMENT_IDS,
    EXPECTED.baselineDeploymentId,
    "API approved deployment allowlist",
  );
  assertEqual(
    settings.CLAIMGUARD_MANAGED_MODEL_DEPLOYMENT_ID,
    EXPECTED.baselineDeploymentId,
    "API managed deployment",
  );
  assert(
    !settings.CLAIMGUARD_MODEL_ACTIVATION_AUDIT_EVENT_ID,
    "Runtime activation audit setting already exists.",
  );

  const releaseApp = az([
    "containerapp",
    "show",
    "--resource-group",
    EXPECTED.resourceGroup,
    "--name",
    EXPECTED.releaseAppName,
    "--output",
    "json",
  ], { json: true });
  assertEqual(
    releaseApp?.properties?.provisioningState,
    "Succeeded",
    "Release app provisioning state",
  );
  assertEqual(
    releaseApp?.properties?.template?.containers?.[0]?.image,
    EXPECTED.releaseImageDigest,
    "Release app image",
  );

  const eventJob = az([
    "containerapp",
    "job",
    "show",
    "--resource-group",
    EXPECTED.resourceGroup,
    "--name",
    EXPECTED.eventJobName,
    "--output",
    "json",
  ], { json: true });
  assertEqual(
    eventJob?.properties?.configuration?.triggerType,
    "Event",
    "Event worker trigger",
  );
  assertEqual(
    eventJob?.properties?.configuration?.eventTriggerConfig?.scale
      ?.minExecutions,
    0,
    "Event worker minimum executions",
  );
  assertEqual(
    eventJob?.properties?.configuration?.eventTriggerConfig?.scale
      ?.maxExecutions,
    1,
    "Event worker maximum executions",
  );
  assertEqual(
    containerArgs(eventJob).join(" "),
    "worker event",
    "Event worker command",
  );
  assertEqual(
    environmentValue(eventJob, "MODEL_SERVICE_APPROVED_DEPLOYMENT_IDS"),
    EXPECTED.approvedDeploymentIds,
    "Event worker approved deployment allowlist",
  );

  const recoveryJob = az([
    "containerapp",
    "job",
    "show",
    "--resource-group",
    EXPECTED.resourceGroup,
    "--name",
    EXPECTED.recoveryJobName,
    "--output",
    "json",
  ], { json: true });
  assertEqual(
    recoveryJob?.properties?.configuration?.triggerType,
    "Schedule",
    "Recovery worker trigger",
  );
  assertEqual(
    recoveryJob?.properties?.configuration?.scheduleTriggerConfig
      ?.cronExpression,
    "0 0 1 1 *",
    "Recovery worker schedule",
  );
  assertEqual(
    containerArgs(recoveryJob).join(" "),
    "worker drain-all",
    "Recovery worker command",
  );

  const recoveryExecutions = az([
    "containerapp",
    "job",
    "execution",
    "list",
    "--resource-group",
    EXPECTED.resourceGroup,
    "--name",
    EXPECTED.recoveryJobName,
    "--output",
    "json",
  ], { json: true });
  assertEqual(
    recoveryExecutions.length,
    0,
    "Recovery worker lifetime execution count",
  );

  const eventExecutions = az([
    "containerapp",
    "job",
    "execution",
    "list",
    "--resource-group",
    EXPECTED.resourceGroup,
    "--name",
    EXPECTED.eventJobName,
    "--output",
    "json",
  ], { json: true });
  const activeEventExecutions = eventExecutions.filter(({ properties }) =>
    ACTIVE_EXECUTION_STATES.has(properties?.status));

  const pool = createControlPlanePool(
    secretValue(EXPECTED.controlPlaneSecretName),
  );
  try {
    const [modelRows] = await pool.execute(
      `
        SELECT
          deployment_id,
          lifecycle_status,
          artifact_sha256,
          container_image_digest,
          automatic_adverse_action,
          validated_at,
          activated_at,
          retired_at
        FROM model_deployments
        WHERE owner_type = 'claimguard'
          AND owner_organisation_id IS NULL
          AND deployment_id IN (?, ?)
        ORDER BY deployment_id
      `,
      [EXPECTED.baselineDeploymentId, EXPECTED.deploymentId],
    );
    assertEqual(modelRows.length, 2, "Governed model row count");
    const models = new Map(
      modelRows.map((row) => [row.deployment_id, row]),
    );
    const activatedModel = models.get(EXPECTED.deploymentId);
    const baselineModel = models.get(EXPECTED.baselineDeploymentId);
    assertEqual(
      activatedModel?.lifecycle_status,
      "active",
      "Ensemble catalogue lifecycle",
    );
    assertEqual(
      activatedModel?.artifact_sha256,
      EXPECTED.artifactSha256,
      "Ensemble artifact digest",
    );
    assertEqual(
      activatedModel?.container_image_digest,
      EXPECTED.releaseImageDigest,
      "Ensemble release image",
    );
    assertEqual(
      Number(activatedModel?.automatic_adverse_action),
      0,
      "Ensemble automatic adverse action",
    );
    assert(
      activatedModel?.validated_at && activatedModel?.activated_at,
      "Ensemble validation and activation timestamps are required.",
    );
    assertEqual(
      activatedModel?.retired_at,
      null,
      "Ensemble retirement timestamp",
    );
    assertEqual(
      baselineModel?.lifecycle_status,
      "retired",
      "Baseline catalogue lifecycle",
    );
    assert(
      baselineModel?.retired_at,
      "Baseline retirement timestamp is required.",
    );

    const [activeRows] = await pool.execute(
      `
        SELECT deployment_id
        FROM model_deployments
        WHERE owner_type = 'claimguard'
          AND owner_organisation_id IS NULL
          AND lifecycle_status = 'active'
        ORDER BY deployment_id
      `,
    );
    assertEqual(activeRows.length, 1, "Active ClaimGuard model count");
    assertEqual(
      activeRows[0].deployment_id,
      EXPECTED.deploymentId,
      "Active ClaimGuard model",
    );

    const [auditRows] = await pool.execute(
      `
        SELECT
          audit_event_id,
          actor_type,
          actor_id,
          organisation_scope_id,
          action,
          target_type,
          target_id,
          before_summary,
          after_summary,
          occurred_at,
          outcome,
          source
        FROM platform_audit_events
        WHERE audit_event_id = ?
        LIMIT 2
      `,
      [auditEventId],
    );
    assertEqual(auditRows.length, 1, "Activation audit row count");
    const audit = auditRows[0];
    assertEqual(
      audit.audit_event_id.toLowerCase(),
      auditEventId,
      "Activation audit event ID",
    );
    assertEqual(audit.organisation_scope_id, null, "Audit organisation scope");
    assertEqual(audit.action, "model_deployment.activate", "Audit action");
    assertEqual(audit.target_type, "model_deployment", "Audit target type");
    assertEqual(audit.target_id, EXPECTED.deploymentId, "Audit target");
    assertEqual(audit.outcome, "success", "Audit outcome");
    assertEqual(audit.source, "platform-admin-api", "Audit source");
    assert(audit.actor_id, "Activation audit actor ID is required.");

    const beforeSummary = parseJson(audit.before_summary, "before_summary");
    const afterSummary = parseJson(audit.after_summary, "after_summary");
    assertEqual(
      beforeSummary.deploymentId,
      EXPECTED.deploymentId,
      "Audited prior deployment",
    );
    assertEqual(
      beforeSummary.lifecycleStatus,
      "candidate",
      "Audited prior lifecycle",
    );
    assertEqual(
      beforeSummary.artifactSha256,
      EXPECTED.artifactSha256,
      "Audited prior artifact",
    );
    assertEqual(
      beforeSummary.containerImageDigest,
      EXPECTED.candidateImageDigest,
      "Audited candidate image",
    );
    assertEqual(
      afterSummary.deploymentId,
      EXPECTED.deploymentId,
      "Audited activated deployment",
    );
    assertEqual(
      afterSummary.lifecycleStatus,
      "active",
      "Audited activated lifecycle",
    );
    assertEqual(
      afterSummary.artifactSha256,
      EXPECTED.artifactSha256,
      "Audited activated artifact",
    );
    assertEqual(
      afterSummary.containerImageDigest,
      EXPECTED.releaseImageDigest,
      "Audited release image",
    );
    assertEqual(
      afterSummary.automaticAdverseAction,
      false,
      "Audited automatic adverse action",
    );
    assertEqual(
      JSON.stringify(afterSummary.retiredDeploymentIds),
      JSON.stringify([EXPECTED.baselineDeploymentId]),
      "Audited retired deployment IDs",
    );

    process.stdout.write(`${JSON.stringify({
      subscriptionId: account.id,
      tenantId: account.tenantId,
      catalogue: {
        activeDeploymentId: activatedModel.deployment_id,
        activeLifecycleStatus: activatedModel.lifecycle_status,
        artifactSha256: activatedModel.artifact_sha256,
        releaseImageDigest: activatedModel.container_image_digest,
        activatedAt: activatedModel.activated_at,
        baselineLifecycleStatus: baselineModel.lifecycle_status,
        baselineRetiredAt: baselineModel.retired_at,
      },
      audit: {
        auditEventId: audit.audit_event_id,
        action: audit.action,
        targetId: audit.target_id,
        outcome: audit.outcome,
        occurredAt: audit.occurred_at,
        source: audit.source,
      },
      runtime: {
        approvedModelDeploymentIds:
          settings.APPROVED_MODEL_DEPLOYMENT_IDS,
        managedModelDeploymentId:
          settings.CLAIMGUARD_MANAGED_MODEL_DEPLOYMENT_ID,
        activationAuditEventId:
          settings.CLAIMGUARD_MODEL_ACTIVATION_AUDIT_EVENT_ID || null,
      },
      eventWorker: {
        triggerType: eventJob.properties.configuration.triggerType,
        minExecutions:
          eventJob.properties.configuration.eventTriggerConfig.scale
            .minExecutions,
        maxExecutions:
          eventJob.properties.configuration.eventTriggerConfig.scale
            .maxExecutions,
        activeExecutionCount: activeEventExecutions.length,
        totalExecutionCount: eventExecutions.length,
      },
      recoveryWorker: {
        triggerType: recoveryJob.properties.configuration.triggerType,
        schedule:
          recoveryJob.properties.configuration.scheduleTriggerConfig
            .cronExpression,
        lifetimeExecutionCount: recoveryExecutions.length,
      },
    }, null, 2)}\n`);
  } finally {
    await pool.end();
  }
}

await main();
