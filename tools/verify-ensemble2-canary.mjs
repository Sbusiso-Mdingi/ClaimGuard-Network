#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const EXPECTED = Object.freeze({
  subscriptionId: "896d3c72-d979-4bdc-a37f-060988d12032",
  resourceGroup: "ClaimGuard",
  containerAppName: "claimguard-ensemble-211-canary",
  identityName: "claimguard-ensemble-211-canary-identity",
  environmentName: "claimguard-env-11e",
  registryName: "claimguardacr11e",
  modelAuthClientId: "58019e2d-cfd0-4bdf-b757-bc96876f2f25",
  modelAudience: "api://58019e2d-cfd0-4bdf-b757-bc96876f2f25",
  tenantId: "8efc1bb9-b90f-4a48-bf6c-ba0686193b80",
  deploymentId: "claimguard-claim-fraud-ensemble:2.1.1",
  modelId: "claimguard-claim-fraud-ensemble",
  modelVersion: "2.1.1",
  featureSchemaVersion: "claim-feature-schema-2026.2",
  analysisMode: "PROSPECTIVE_CLAIM_SCREENING",
  threshold: 0.049236234887246655,
  image:
    "claimguardacr11e.azurecr.io/claimguard/"
    + "ensemble2-prospective-model-service"
    + "@sha256:0a4b771e8453b6f891e35b5a2921c2c"
    + "840325ffd29bf773aa7989f5ef4241b2c",
  governedCandidateImage:
    "claimguardacr11e.azurecr.io/claimguard/"
    + "ensemble2-prospective-model-service"
    + "@sha256:423a6f88b8fb28580c47950676714237"
    + "f72b73f7273acbad21806afd06c8fd1a",
  baselineApps: Object.freeze({
    "claimguard-ml-inference":
      "claimguardacr11e.azurecr.io/claimguard/model-service"
      + "@sha256:65360d57ac90aea446c36effe50125122710cc3"
      + "b3178cd8c95c99cdf04c94605",
    "claimguard-ml-prospective":
      "claimguardacr11e.azurecr.io/claimguard/"
      + "prospective-model-service:7ca388145a755bb18a70fd27ba079ddc909ec19a",
  }),
});

const ACR_PULL_ROLE_ID =
  "/providers/Microsoft.Authorization/roleDefinitions/"
  + "7f951dda-4ed3-4680-a7ca-43fe172d538d";
const MARKER = "CLAIMGUARD_CANARY_RESULT=";
const TOOL_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const EXEC_HELPER = join(
  TOOL_DIRECTORY,
  "containerapp-canary-exec.exp",
);

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

function az(args, { json = false } = {}) {
  const output = execFileSync(
    "az",
    [...args, "--only-show-errors"],
    {
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 5 * 60 * 1000,
    },
  ).trim();
  return json ? JSON.parse(output || "null") : output;
}

function environmentMap(container) {
  return Object.fromEntries(
    (container?.env || []).map(({ name, value, secretRef }) => [
      name,
      { value: value ?? null, secretRef: secretRef ?? null },
    ]),
  );
}

function expectedEnvironmentId() {
  return `/subscriptions/${EXPECTED.subscriptionId}`
    + `/resourceGroups/${EXPECTED.resourceGroup}`
    + "/providers/Microsoft.App/managedEnvironments/"
    + EXPECTED.environmentName;
}

function expectedRegistryId() {
  return `/subscriptions/${EXPECTED.subscriptionId}`
    + `/resourceGroups/${EXPECTED.resourceGroup}`
    + "/providers/Microsoft.ContainerRegistry/registries/"
    + EXPECTED.registryName;
}

export function parseCanaryMarker(output) {
  const markerIndex = output.indexOf(MARKER);
  assert(markerIndex >= 0, "Authenticated canary output marker is absent.");
  const encoded = output
    .slice(markerIndex + MARKER.length)
    .split(/\r?\n/, 1)[0];
  try {
    return JSON.parse(encoded);
  } catch {
    fail("Authenticated canary output marker contains invalid JSON.");
  }
}

export function assertCanaryResponse(response) {
  assertEqual(
    response.schemaVersion,
    "claimguard.claim-screening-response.v3",
    "Response schema",
  );
  assertEqual(
    response.featureSchemaVersion,
    EXPECTED.featureSchemaVersion,
    "Response feature schema",
  );
  assertEqual(response.deploymentId, EXPECTED.deploymentId, "Deployment ID");
  assertEqual(response.modelId, EXPECTED.modelId, "Model ID");
  assertEqual(response.modelVersion, EXPECTED.modelVersion, "Model version");
  assertEqual(response.analysisMode, EXPECTED.analysisMode, "Analysis mode");
  assertEqual(response.tenantId, "canary-tenant", "Synthetic tenant ID");
  assertEqual(response.requestId, "canary-request", "Synthetic request ID");
  assert(Array.isArray(response.scores), "Response scores must be an array.");
  assertEqual(response.scores.length, 1, "Response score count");
  const [score] = response.scores;
  assertEqual(score.claimId, "canary-claim", "Scored claim ID");
  assertEqual(score.claimVersion, 1, "Scored claim version");
  assertEqual(score.threshold, EXPECTED.threshold, "Decision threshold");
  assert(
    Number.isFinite(score.fraudProbability)
      && score.fraudProbability >= 0
      && score.fraudProbability <= 1,
    "Fraud probability must be finite and within [0, 1].",
  );
  assert(
    ["FRAUD", "LEGITIMATE"].includes(score.predictedClass),
    "Predicted class is invalid.",
  );
  assert(
    typeof score.reviewRecommended === "boolean",
    "Review recommendation must be boolean.",
  );
}

export function parseResponseBody(
  body,
  { url, status, allowNonJson = false },
) {
  try {
    return JSON.parse(body);
  } catch {
    if (!allowNonJson) {
      fail(`${url} returned non-JSON content with status ${status}.`);
    }
    return body;
  }
}

function buildSelfProbe(baseUrl) {
  return String.raw`
import json
import math
import os
import urllib.parse
import urllib.request
from pathlib import Path

import joblib

audience = ${JSON.stringify(EXPECTED.modelAudience)}
base_url = ${JSON.stringify(baseUrl)}
client_id = os.environ["AZURE_CLIENT_ID"]
identity_endpoint = os.environ["IDENTITY_ENDPOINT"]
identity_header = os.environ["IDENTITY_HEADER"]
query = urllib.parse.urlencode({
    "api-version": "2019-08-01",
    "resource": audience,
    "client_id": client_id,
})
token_request = urllib.request.Request(
    f"{identity_endpoint}?{query}",
    headers={"X-IDENTITY-HEADER": identity_header},
)
with urllib.request.urlopen(token_request, timeout=15) as response:
    token = json.load(response)["access_token"]

artifact = joblib.load(Path("/opt/claimguard/model/model.joblib"))
numeric = set(artifact["numeric_predictors"])
categorical = set(artifact["categorical_predictors"])
features = {}
for name in artifact["predictor_names"]:
    if name in numeric:
        features[name] = 0.0
    elif name in categorical:
        features[name] = "CANARY"
    else:
        raise RuntimeError(f"unclassified predictor: {name}")
features.update({
    "claimed_amount": 450.0,
    "log1p_claimed_amount": math.log1p(450.0),
    "quantity": 1.0,
    "submission_lag_days": 0.0,
    "service_weekday_sin": 0.0,
    "service_weekday_cos": 1.0,
    "service_month_sin": 0.0,
    "service_month_cos": 1.0,
    "has_rendering_practitioner": 0.0,
    "rendering_known_to_billing_provider": 0.0,
    "benefit_option": "COMPREHENSIVE",
    "network_type": "IN_NETWORK",
    "line_type": "PROFESSIONAL",
    "billing_code": "CONSULT",
    "tariff_discipline": "MEDICAL",
    "diagnosis_code": "Z00.0",
    "billing_provider_kind": "INDIVIDUAL",
    "billing_provider_category": "GENERAL_PRACTITIONER",
    "rendering_practitioner_category": "NONE",
})
payload = {
    "schemaVersion": "claimguard.claim-screening-request.v3",
    "featureSchemaVersion": ${JSON.stringify(EXPECTED.featureSchemaVersion)},
    "deploymentId": ${JSON.stringify(EXPECTED.deploymentId)},
    "tenantId": "canary-tenant",
    "requestId": "canary-request",
    "analysisMode": ${JSON.stringify(EXPECTED.analysisMode)},
    "window": {
        "capturedAt": "2026-07-28T07:00:00+00:00",
        "contextCutoffAt": "2026-07-28T06:59:59+00:00",
        "watermark": "canary-watermark",
    },
    "targetClaims": [{
        "claimId": "canary-claim",
        "claimVersion": 1,
        "memberKey": "canary-member",
        "billingProviderKey": "canary-provider",
        "renderingPractitionerKey": None,
        "serviceDate": "2026-07-28",
        "receivedDate": "2026-07-28",
        "claimedAmount": "450.00",
        "quantity": "1.000",
        "benefitOption": "COMPREHENSIVE",
        "networkType": "IN_NETWORK",
        "lineType": "PROFESSIONAL",
        "billingCode": "CONSULT",
        "tariffDiscipline": "MEDICAL",
        "diagnosisCode": "Z00.0",
        "billingProviderKind": "INDIVIDUAL",
        "billingProviderCategory": "GENERAL_PRACTITIONER",
        "renderingPractitionerCategory": "NONE",
        "renderingKnownToBillingProvider": False,
    }],
    "contextFeatures": {
        "schemaVersion": ${JSON.stringify(EXPECTED.featureSchemaVersion)},
        "targets": [{
            "claimId": "canary-claim",
            "claimVersion": 1,
            "features": features,
        }],
    },
}
request = urllib.request.Request(
    f"{base_url}/v3/claim-screening",
    data=json.dumps(payload).encode("utf-8"),
    headers={
        "Authorization": f"Bearer {token}",
        "Content-Type": "application/json",
        "X-Request-Id": "canary-request",
    },
    method="POST",
)
with urllib.request.urlopen(request, timeout=30) as response:
    result = json.load(response)
print(${JSON.stringify(MARKER)} + json.dumps(result, separators=(",", ":")))
`;
}

export function selectExecTarget(revisions, replicasByRevision) {
  const active = revisions.filter(({ properties }) =>
    properties?.active === true
    && properties?.healthState === "Healthy"
    && properties?.provisioningState === "Provisioned"
    && properties?.replicas === 1);
  assertEqual(active.length, 1, "Healthy active canary revision count");
  const [revision] = active;
  const replicas = replicasByRevision[revision.name] || [];
  const ready = replicas.filter(({ properties }) => {
    if (properties?.runningState !== "Running") return false;
    const containers = properties?.containers || [];
    const modelService = containers.find(
      ({ name }) => name === "model-service",
    );
    const authSidecar = containers.find(({ name }) => name === "http-auth");
    return modelService?.ready === true
      && modelService?.runningState === "Running"
      && modelService?.restartCount === 0
      && authSidecar?.ready === true
      && authSidecar?.runningState === "Running"
      && authSidecar?.restartCount === 0;
  });
  assertEqual(ready.length, 1, "Ready canary replica count");
  return Object.freeze({
    revision: revision.name,
    replica: ready[0].name,
  });
}

function resolveExecTarget() {
  const revisions = az([
    "containerapp",
    "revision",
    "list",
    "--resource-group",
    EXPECTED.resourceGroup,
    "--name",
    EXPECTED.containerAppName,
    "--output",
    "json",
  ], { json: true });
  const replicasByRevision = Object.fromEntries(
    revisions.map((revision) => [
      revision.name,
      az([
        "containerapp",
        "replica",
        "list",
        "--resource-group",
        EXPECTED.resourceGroup,
        "--name",
        EXPECTED.containerAppName,
        "--revision",
        revision.name,
        "--output",
        "json",
      ], { json: true }),
    ]),
  );
  return selectExecTarget(revisions, replicasByRevision);
}

function runSelfProbe(baseUrl) {
  const encoded = Buffer.from(buildSelfProbe(baseUrl), "utf8").toString(
    "base64",
  );
  const target = resolveExecTarget();
  const output = execFileSync(
    "/usr/bin/expect",
    [EXEC_HELPER, target.revision, target.replica, encoded],
    {
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 5 * 60 * 1000,
    },
  ).trim();
  return parseCanaryMarker(output);
}

async function fetchJson(
  url,
  { allowNonJson = false, ...options } = {},
) {
  const response = await fetch(url, {
    ...options,
    signal: AbortSignal.timeout(30_000),
  });
  const body = await response.text();
  const parsed = parseResponseBody(body, {
    url,
    status: response.status,
    allowNonJson,
  });
  return { response, body: parsed };
}

async function waitForReadiness(baseUrl) {
  let last;
  for (let attempt = 1; attempt <= 30; attempt += 1) {
    try {
      const result = await fetchJson(`${baseUrl}/health/ready`);
      if (result.response.status === 200) return result.body;
      last = `HTTP ${result.response.status}`;
    } catch (error) {
      last = error.message;
    }
    await new Promise((resolve) => setTimeout(resolve, 5_000));
  }
  fail(`Canary did not become ready: ${last}`);
}

function verifyProductionBaseline() {
  return JSON.parse(execFileSync(
    process.execPath,
    [
      "tools/verify-production-model-candidate.mjs",
      "--deployment-id",
      EXPECTED.deploymentId,
      "--artifact-sha256",
      "644bbefaf14ac13c7eeb69965d6d53d29d150b632ec485b4bf9fd47297773d62",
      "--container-image-digest",
      EXPECTED.governedCandidateImage,
    ],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 5 * 60 * 1000,
    },
  ));
}

async function main() {
  const account = az(["account", "show", "--output", "json"], { json: true });
  assertEqual(account.id, EXPECTED.subscriptionId, "Azure subscription");
  assertEqual(account.tenantId, EXPECTED.tenantId, "Azure directory tenant");

  const productionBefore = verifyProductionBaseline();
  const baselineAppsBefore = az([
    "containerapp",
    "list",
    "--resource-group",
    EXPECTED.resourceGroup,
    "--output",
    "json",
  ], { json: true });
  for (const [name, image] of Object.entries(EXPECTED.baselineApps)) {
    const app = baselineAppsBefore.find((candidate) => candidate.name === name);
    assert(app, `Production model app ${name} is absent.`);
    assertEqual(
      app.properties?.template?.containers?.[0]?.image,
      image,
      `${name} image`,
    );
  }

  const identity = az([
    "identity",
    "show",
    "--resource-group",
    EXPECTED.resourceGroup,
    "--name",
    EXPECTED.identityName,
    "--output",
    "json",
  ], { json: true });
  assert(identity.principalId, "Canary identity principal ID is absent.");
  assert(identity.clientId, "Canary identity client ID is absent.");

  const app = az([
    "containerapp",
    "show",
    "--resource-group",
    EXPECTED.resourceGroup,
    "--name",
    EXPECTED.containerAppName,
    "--output",
    "json",
  ], { json: true });
  assertEqual(app.properties?.provisioningState, "Succeeded", "Provisioning");
  assertEqual(
    app.properties?.environmentId?.toLowerCase(),
    expectedEnvironmentId().toLowerCase(),
    "Container Apps environment",
  );
  assertEqual(
    app.properties?.configuration?.activeRevisionsMode,
    "Single",
    "Revision mode",
  );
  assertEqual(
    app.properties?.configuration?.ingress?.external,
    true,
    "External ingress",
  );
  assertEqual(
    app.properties?.configuration?.ingress?.allowInsecure,
    false,
    "Insecure ingress",
  );
  assertEqual(
    app.properties?.configuration?.ingress?.targetPort,
    8000,
    "Target port",
  );
  assertEqual(
    app.properties?.template?.scale?.minReplicas,
    0,
    "Minimum replicas",
  );
  assertEqual(
    app.properties?.template?.scale?.maxReplicas,
    1,
    "Maximum replicas",
  );
  const [container] = app.properties?.template?.containers || [];
  assertEqual(container?.name, "model-service", "Container name");
  assertEqual(container?.image, EXPECTED.image, "Canary image");
  const env = environmentMap(container);
  assertEqual(
    env.CLAIMGUARD_MODEL_DEPLOYMENT_ID?.value,
    EXPECTED.deploymentId,
    "Runtime deployment ID",
  );
  assertEqual(
    env.CLAIMGUARD_MODEL_AUTH_MODE?.value,
    "entra_proxy",
    "Runtime auth mode",
  );
  assertEqual(
    env.CLAIMGUARD_ALLOWED_CALLER_PRINCIPAL_ID?.value,
    identity.principalId,
    "Runtime allowed caller",
  );
  assertEqual(
    env.AZURE_CLIENT_ID?.value,
    identity.clientId,
    "Runtime managed identity client ID",
  );
  const assignedIdentityIds = Object.keys(
    app.identity?.userAssignedIdentities || {},
  );
  assertEqual(assignedIdentityIds.length, 1, "Assigned identity count");
  assertEqual(
    assignedIdentityIds[0].toLowerCase(),
    identity.id.toLowerCase(),
    "Assigned identity",
  );

  const assignments = az([
    "role",
    "assignment",
    "list",
    "--assignee-object-id",
    identity.principalId,
    "--scope",
    expectedRegistryId(),
    "--output",
    "json",
  ], { json: true });
  assertEqual(assignments.length, 1, "Canary ACR role count");
  assert(
    assignments[0].roleDefinitionId.endsWith(ACR_PULL_ROLE_ID),
    "Canary role is not AcrPull.",
  );
  assertEqual(
    assignments[0].scope.toLowerCase(),
    expectedRegistryId().toLowerCase(),
    "Canary role scope",
  );

  const auth = az([
    "containerapp",
    "auth",
    "show",
    "--resource-group",
    EXPECTED.resourceGroup,
    "--name",
    EXPECTED.containerAppName,
    "--output",
    "json",
  ], { json: true });
  assertEqual(auth.platform?.enabled, true, "EasyAuth platform");
  assertEqual(
    auth.globalValidation?.unauthenticatedClientAction,
    "Return401",
    "Unauthenticated action",
  );
  assertEqual(auth.httpSettings?.requireHttps, true, "HTTPS requirement");
  assertEqual(auth.login?.tokenStore?.enabled, false, "Token store");
  const aad = auth.identityProviders?.azureActiveDirectory;
  assertEqual(aad?.enabled, true, "Entra provider");
  assertEqual(
    aad?.registration?.clientId,
    EXPECTED.modelAuthClientId,
    "Entra client ID",
  );
  assertEqual(
    aad?.registration?.openIdIssuer,
    `https://login.microsoftonline.com/${EXPECTED.tenantId}/v2.0`,
    "Entra issuer",
  );
  assertEqual(
    aad?.validation?.allowedAudiences?.join(","),
    EXPECTED.modelAudience,
    "Allowed audience",
  );
  assert(
    !aad?.validation?.defaultAuthorizationPolicy,
    "EasyAuth must delegate exact-principal enforcement to the model service.",
  );

  const fqdn = app.properties?.configuration?.ingress?.fqdn;
  assert(fqdn, "Canary ingress FQDN is absent.");
  const baseUrl = `https://${fqdn}`;
  const ready = await waitForReadiness(baseUrl);
  assertEqual(ready.status, "ready", "Readiness status");
  assertEqual(ready.deploymentId, EXPECTED.deploymentId, "Ready deployment ID");
  assertEqual(ready.modelId, EXPECTED.modelId, "Ready model ID");
  assertEqual(ready.modelVersion, EXPECTED.modelVersion, "Ready model version");
  assertEqual(
    ready.featureSchemaVersion,
    EXPECTED.featureSchemaVersion,
    "Ready feature schema",
  );
  assertEqual(
    ready.analysisMode,
    EXPECTED.analysisMode,
    "Ready analysis mode",
  );
  assertEqual(
    ready.deterministicFallbackEnabled,
    false,
    "Deterministic fallback",
  );

  const unauthenticated = await fetchJson(
    `${baseUrl}/v3/claim-screening`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-request-id": "canary-unauthenticated",
      },
      body: "{}",
      allowNonJson: true,
    },
  );
  assertEqual(
    unauthenticated.response.status,
    401,
    "Unauthenticated scoring status",
  );

  const authenticated = runSelfProbe(baseUrl);
  assertCanaryResponse(authenticated);

  const productionAfter = verifyProductionBaseline();
  assertEqual(
    JSON.stringify(productionAfter),
    JSON.stringify(productionBefore),
    "Production candidate/runtime/worker state",
  );

  process.stdout.write(`${JSON.stringify({
    status: "ENSEMBLE_2_1_1_CANARY_PASSED",
    canary: {
      name: app.name,
      baseUrl,
      identityName: identity.name,
      identityPrincipalId: identity.principalId,
      image: container.image,
      deploymentId: authenticated.deploymentId,
      modelVersion: authenticated.modelVersion,
      featureSchemaVersion: authenticated.featureSchemaVersion,
      analysisMode: authenticated.analysisMode,
      threshold: authenticated.scores[0].threshold,
      fraudProbability: authenticated.scores[0].fraudProbability,
      unauthenticatedStatus: unauthenticated.response.status,
      authenticatedStatus: 200,
      minReplicas: app.properties.template.scale.minReplicas,
      maxReplicas: app.properties.template.scale.maxReplicas,
    },
    productionInvariant: {
      approvedModelDeploymentIds:
        productionAfter.runtime.approvedModelDeploymentIds,
      managedModelDeploymentId:
        productionAfter.runtime.managedModelDeploymentId,
      candidateLifecycleStatus:
        productionAfter.candidate.lifecycleStatus,
      candidateValidatedAt:
        productionAfter.candidate.validatedAt,
      candidateActivatedAt:
        productionAfter.candidate.activatedAt,
      workerTriggerType: productionAfter.worker.triggerType,
      workerScheduleTriggerConfigured:
        productionAfter.worker.scheduleTriggerConfigured,
      workerActiveExecutionCount:
        productionAfter.worker.activeExecutionCount,
      workerTotalExecutionCount:
        productionAfter.worker.totalExecutionCount,
    },
  }, null, 2)}\n`);
}

const invokedPath = process.argv[1]
  ? pathToFileURL(process.argv[1]).href
  : null;
if (invokedPath === import.meta.url) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
