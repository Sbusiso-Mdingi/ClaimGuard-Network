#!/usr/bin/env node

import { execFileSync } from "node:child_process";

import {
  createControlPlanePool,
} from "../packages/control-plane-database/src/index.js";

const EXPECTED = Object.freeze({
  subscriptionId: "896d3c72-d979-4bdc-a37f-060988d12032",
  resourceGroup: "ClaimGuard",
  vaultName: "claimguard-kv-ufs",
  controlPlaneSecretName: "claimguard--api--control-plane-mysql-url",
  apiAppName: "claimguard-api",
  workerJobName: "claimguard-report-producer",
  managedDeploymentId: "claimguard-claim-fraud-baseline:1.0.0",
});

const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const IMAGE_DIGEST_PATTERN = /@sha256:[a-f0-9]{64}$/;
const ACTIVE_EXECUTION_STATES = new Set([
  "Running",
  "Processing",
  "Starting",
]);

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
  if (!condition) fail(message);
}

function parseOptions(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    assert(
      flag?.startsWith("--") && value !== undefined,
      `Invalid option sequence beginning at ${JSON.stringify(flag)}.`,
    );
    const name = flag.slice(2);
    assert(
      [
        "deployment-id",
        "artifact-sha256",
        "container-image-digest",
      ].includes(name),
      `Unsupported option ${flag}.`,
    );
    assert(options[name] === undefined, `${flag} was supplied more than once.`);
    options[name] = value;
  }

  assert(
    /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(
      options["deployment-id"] || "",
    ),
    "--deployment-id must be a versioned deployment identifier.",
  );
  assert(
    SHA256_PATTERN.test(options["artifact-sha256"] || ""),
    "--artifact-sha256 must be a lowercase SHA-256 digest.",
  );
  assert(
    IMAGE_DIGEST_PATTERN.test(options["container-image-digest"] || ""),
    "--container-image-digest must end in an immutable SHA-256 digest.",
  );

  return Object.freeze({
    deploymentId: options["deployment-id"],
    artifactSha256: options["artifact-sha256"],
    containerImageDigest: options["container-image-digest"],
  });
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

function parseJson(value) {
  return typeof value === "string" ? JSON.parse(value) : value;
}

async function main() {
  const target = parseOptions(process.argv.slice(2));
  const account = az(["account", "show", "--output", "json"], { json: true });
  assertEqual(account.id, EXPECTED.subscriptionId, "Azure subscription");

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
    EXPECTED.managedDeploymentId,
    "API approved deployment allowlist",
  );
  assertEqual(
    settings.CLAIMGUARD_MANAGED_MODEL_DEPLOYMENT_ID,
    EXPECTED.managedDeploymentId,
    "API managed deployment",
  );

  const worker = az([
    "containerapp",
    "job",
    "show",
    "--resource-group",
    EXPECTED.resourceGroup,
    "--name",
    EXPECTED.workerJobName,
    "--output",
    "json",
  ], { json: true });
  assertEqual(
    worker?.properties?.configuration?.triggerType,
    "Event",
    "Worker trigger type",
  );
  assert(
    !worker?.properties?.configuration?.scheduleTriggerConfig,
    "Event-driven worker unexpectedly has a schedule trigger.",
  );

  const executions = az([
    "containerapp",
    "job",
    "execution",
    "list",
    "--resource-group",
    EXPECTED.resourceGroup,
    "--name",
    EXPECTED.workerJobName,
    "--output",
    "json",
  ], { json: true });
  const activeExecutions = executions.filter(({ properties }) =>
    ACTIVE_EXECUTION_STATES.has(properties?.status));
  assertEqual(
    activeExecutions.length,
    0,
    "Active worker execution count",
  );

  const pool = createControlPlanePool(
    secretValue(EXPECTED.controlPlaneSecretName),
  );
  try {
    const [modelRows] = await pool.execute(
      `
        SELECT
          deployment_id,
          model_id,
          model_version,
          owner_type,
          owner_organisation_id,
          lifecycle_status,
          request_schema_version,
          response_schema_version,
          feature_schema_version,
          analysis_mode,
          CAST(decision_threshold AS CHAR) AS decision_threshold,
          artifact_sha256,
          container_image_digest,
          capabilities,
          automatic_adverse_action,
          validated_at,
          activated_at,
          retired_at,
          created_at
        FROM model_deployments
        WHERE deployment_id = ?
        LIMIT 2
      `,
      [target.deploymentId],
    );
    assertEqual(modelRows.length, 1, "Candidate catalogue row count");
    const model = modelRows[0];
    assertEqual(model.deployment_id, target.deploymentId, "Deployment ID");
    assertEqual(model.owner_type, "claimguard", "Model owner type");
    assertEqual(model.owner_organisation_id, null, "Model owner organisation");
    assertEqual(model.lifecycle_status, "candidate", "Lifecycle status");
    assertEqual(
      model.request_schema_version,
      "claimguard.claim-screening-request.v3",
      "Request schema",
    );
    assertEqual(
      model.response_schema_version,
      "claimguard.claim-screening-response.v3",
      "Response schema",
    );
    assertEqual(
      model.feature_schema_version,
      "claim-feature-schema-2026.2",
      "Feature schema",
    );
    assertEqual(
      model.analysis_mode,
      "PROSPECTIVE_CLAIM_SCREENING",
      "Analysis mode",
    );
    assertEqual(
      model.artifact_sha256,
      target.artifactSha256,
      "Artifact digest",
    );
    assertEqual(
      model.container_image_digest,
      target.containerImageDigest,
      "Container image digest",
    );
    assertEqual(
      Number(model.automatic_adverse_action),
      0,
      "Automatic adverse action",
    );
    assertEqual(model.validated_at, null, "Validated timestamp");
    assertEqual(model.activated_at, null, "Activated timestamp");
    assertEqual(model.retired_at, null, "Retired timestamp");
    const capabilities = parseJson(model.capabilities);
    assertEqual(
      capabilities.prospectiveClaimScreening,
      true,
      "Prospective screening capability",
    );
    assertEqual(
      capabilities.networkEnrichment,
      false,
      "Network enrichment capability",
    );

    const [auditRows] = await pool.execute(
      `
        SELECT
          audit_event_id,
          action,
          target_type,
          target_id,
          organisation_scope_id,
          after_summary,
          occurred_at,
          outcome,
          source
        FROM platform_audit_events
        WHERE action = 'model_deployment.register_candidate'
          AND target_type = 'model_deployment'
          AND target_id = ?
        ORDER BY occurred_at DESC
        LIMIT 2
      `,
      [target.deploymentId],
    );
    assertEqual(auditRows.length, 1, "Candidate registration audit count");
    const audit = auditRows[0];
    assertEqual(audit.organisation_scope_id, null, "Audit organisation scope");
    assertEqual(audit.outcome, "success", "Audit outcome");
    const afterSummary = parseJson(audit.after_summary);
    assertEqual(
      afterSummary.deploymentId,
      target.deploymentId,
      "Audited deployment ID",
    );
    assertEqual(
      afterSummary.lifecycleStatus,
      "candidate",
      "Audited lifecycle status",
    );
    assertEqual(
      afterSummary.artifactSha256,
      target.artifactSha256,
      "Audited artifact digest",
    );
    assertEqual(
      afterSummary.containerImageDigest,
      target.containerImageDigest,
      "Audited container image digest",
    );

    process.stdout.write(`${JSON.stringify({
      subscriptionId: account.id,
      candidate: {
        deploymentId: model.deployment_id,
        modelId: model.model_id,
        modelVersion: model.model_version,
        lifecycleStatus: model.lifecycle_status,
        ownerType: model.owner_type,
        decisionThreshold: model.decision_threshold,
        artifactSha256: model.artifact_sha256,
        containerImageDigest: model.container_image_digest,
        capabilities,
        automaticAdverseAction:
          Boolean(model.automatic_adverse_action),
        validatedAt: model.validated_at,
        activatedAt: model.activated_at,
        retiredAt: model.retired_at,
        createdAt: model.created_at,
      },
      runtime: {
        approvedModelDeploymentIds:
          settings.APPROVED_MODEL_DEPLOYMENT_IDS,
        managedModelDeploymentId:
          settings.CLAIMGUARD_MANAGED_MODEL_DEPLOYMENT_ID,
      },
      audit: {
        auditEventId: audit.audit_event_id,
        action: audit.action,
        outcome: audit.outcome,
        occurredAt: audit.occurred_at,
        source: audit.source,
      },
      worker: {
        name: worker.name,
        triggerType: worker.properties.configuration.triggerType,
        scheduleTriggerConfigured: Boolean(
          worker.properties.configuration.scheduleTriggerConfig,
        ),
        activeExecutionCount: activeExecutions.length,
        totalExecutionCount: executions.length,
      },
    }, null, 2)}\n`);
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
