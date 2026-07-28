import assert from "node:assert/strict";
import test from "node:test";

import {
  createModelDeploymentRepository,
  modelDeploymentRuntimeConfigKey,
} from "../src/index.js";

const BASELINE_DEPLOYMENT = "claimguard-claim-fraud-baseline:1.0.0";

function candidate(overrides = {}) {
  return {
    deploymentId: "claimguard-claim-fraud-ensemble:2.0.0",
    modelId: "claimguard-claim-fraud-ensemble",
    modelVersion: "2.0.0",
    displayName: "ClaimGuard fraud ensemble 2.0.0",
    ownerType: "claimguard",
    ownerOrganisationId: null,
    requestSchemaVersion: "claimguard.claim-screening-request.v3",
    responseSchemaVersion: "claimguard.claim-screening-response.v3",
    featureSchemaVersion: "claim-feature-schema-2026.2",
    analysisMode: "PROSPECTIVE_CLAIM_SCREENING",
    decisionThreshold: 0.19,
    artifactSha256: "a".repeat(64),
    containerImageDigest: `registry.example/model@sha256:${"b".repeat(64)}`,
    capabilities: {
      prospectiveClaimScreening: true,
      networkEnrichment: false,
    },
    automaticAdverseAction: false,
    registeredBy: "platform-admin-1",
    ...overrides,
  };
}

function rowFrom(params) {
  return {
    deployment_id: params[0],
    model_id: params[1],
    model_version: params[2],
    display_name: params[3],
    owner_type: params[4],
    owner_organisation_id: params[5],
    lifecycle_status: "candidate",
    request_schema_version: params[6],
    response_schema_version: params[7],
    feature_schema_version: params[8],
    analysis_mode: params[9],
    decision_threshold: String(params[10]),
    runtime_config_key: params[11],
    artifact_sha256: params[12],
    container_image_digest: params[13],
    capabilities: params[14],
    automatic_adverse_action: 0,
    registered_by: params[15],
    validated_at: null,
    activated_at: null,
    retired_at: null,
    created_at: new Date("2026-07-26T12:00:00Z"),
    updated_at: new Date("2026-07-26T12:00:00Z"),
  };
}

test("runtime configuration keys match the prospective worker convention", () => {
  assert.equal(
    modelDeploymentRuntimeConfigKey(BASELINE_DEPLOYMENT),
    "CLAIMGUARD_CLAIM_FRAUD_BASELINE_1_0_0_6E9ED9BC2DEA",
  );
});

test("platform registration stores only immutable candidate metadata", async () => {
  let stored = null;
  const executor = {
    async execute(sql, params = []) {
      const normalized = String(sql).replace(/\s+/g, " ").trim();
      if (normalized.startsWith("INSERT INTO model_deployments")) {
        stored = rowFrom(params);
        return [{ affectedRows: 1 }, []];
      }
      if (normalized.startsWith("SELECT * FROM model_deployments WHERE deployment_id")) {
        return [[stored], []];
      }
      throw new Error(`Unexpected SQL: ${normalized}`);
    },
  };

  const result = await createModelDeploymentRepository(executor)
    .registerCandidate(candidate());

  assert.equal(result.lifecycleStatus, "candidate");
  assert.equal(result.ownerType, "claimguard");
  assert.equal(result.ownerOrganisationId, null);
  assert.equal(result.decisionThreshold, 0.19);
  assert.equal(result.automaticAdverseAction, false);
  assert.equal(result.artifactSha256, "a".repeat(64));
});

test("scheme registration verifies ownership and selectable queries stay scoped", async () => {
  const rows = [
    rowFrom([
      "scheme-alpha-model:1.0.0",
      "scheme-alpha-model",
      "1.0.0",
      "Alpha model",
      "scheme",
      "org-alpha",
      "claimguard.claim-screening-request.v3",
      "claimguard.claim-screening-response.v3",
      "claim-feature-schema-2026.2",
      "PROSPECTIVE_CLAIM_SCREENING",
      0.2,
      "SCHEME_ALPHA_MODEL_1_0_0_TEST",
      "a".repeat(64),
      `registry.example/model@sha256:${"b".repeat(64)}`,
      JSON.stringify({ prospectiveClaimScreening: true }),
      "platform-admin-1",
    ]),
  ];
  rows[0].lifecycle_status = "active";
  const calls = [];
  const executor = {
    async execute(sql, params = []) {
      const normalized = String(sql).replace(/\s+/g, " ").trim();
      calls.push({ sql: normalized, params });
      if (normalized.startsWith("SELECT organisation_type FROM organisations")) {
        return [[{ organisation_type: "medical_scheme" }], []];
      }
      if (normalized.startsWith("INSERT INTO model_deployments")) {
        return [{ affectedRows: 1 }, []];
      }
      if (normalized.startsWith("SELECT * FROM model_deployments WHERE deployment_id")) {
        return [[rows[0]], []];
      }
      if (normalized.includes("WHERE lifecycle_status = 'active'")) {
        return [rows, []];
      }
      throw new Error(`Unexpected SQL: ${normalized}`);
    },
  };
  const repository = createModelDeploymentRepository(executor);

  await repository.registerCandidate(candidate({
    deploymentId: "scheme-alpha-model:1.0.0",
    modelId: "scheme-alpha-model",
    modelVersion: "1.0.0",
    displayName: "Alpha model",
    ownerType: "scheme",
    ownerOrganisationId: "org-alpha",
  }));
  const selectable = await repository.listSelectableForOrganisation("org-alpha");

  assert.deepEqual(
    selectable.map((model) => model.deploymentId),
    ["scheme-alpha-model:1.0.0"],
  );
  assert.deepEqual(calls.at(-1).params, ["org-alpha"]);
});

test("registration rejects unsafe ownership, digests, and adverse action", async () => {
  const repository = createModelDeploymentRepository({
    async execute() {
      throw new Error("Invalid input must fail before database access.");
    },
  });

  await assert.rejects(
    () => repository.registerCandidate(candidate({
      ownerType: "scheme",
      ownerOrganisationId: null,
    })),
    /ownership/,
  );
  await assert.rejects(
    () => repository.registerCandidate(candidate({
      artifactSha256: "not-a-digest",
    })),
    /SHA-256/,
  );
  await assert.rejects(
    () => repository.registerCandidate(candidate({
      automaticAdverseAction: true,
    })),
    /not permitted/,
  );
});

test("activation verifies the governed candidate and retires only prior ClaimGuard models", async () => {
  const deploymentId = "claimguard-claim-fraud-ensemble:2.1.1";
  const candidateImage = `registry.example/model@sha256:${"b".repeat(64)}`;
  const releaseImage = `registry.example/model@sha256:${"c".repeat(64)}`;
  const candidateRow = rowFrom([
    deploymentId,
    "claimguard-claim-fraud-ensemble",
    "2.1.1",
    "ClaimGuard fraud ensemble 2.1.1",
    "claimguard",
    null,
    "claimguard.claim-screening-request.v3",
    "claimguard.claim-screening-response.v3",
    "claim-feature-schema-2026.2",
    "PROSPECTIVE_CLAIM_SCREENING",
    0.049236234887246655,
    "CLAIMGUARD_CLAIM_FRAUD_ENSEMBLE_2_1_1_E0652D762C0E",
    "a".repeat(64),
    candidateImage,
    JSON.stringify({ prospectiveClaimScreening: true }),
    "platform-admin-1",
  ]);
  const calls = [];
  const executor = {
    async execute(sql, params = []) {
      const normalized = String(sql).replace(/\s+/g, " ").trim();
      calls.push({ sql: normalized, params });
      if (
        normalized.startsWith("SELECT * FROM model_deployments")
        && normalized.endsWith("FOR UPDATE")
      ) {
        return [[candidateRow], []];
      }
      if (normalized.startsWith("SELECT deployment_id FROM model_deployments")) {
        return [[{
          deployment_id: "claimguard-claim-fraud-baseline:1.0.0",
        }], []];
      }
      if (
        normalized.startsWith("UPDATE model_deployments")
        && normalized.includes("SET lifecycle_status = 'retired'")
      ) {
        return [{ affectedRows: 1 }, []];
      }
      if (
        normalized.startsWith("UPDATE model_deployments")
        && normalized.includes("SET lifecycle_status = 'active'")
      ) {
        candidateRow.lifecycle_status = "active";
        candidateRow.container_image_digest = params[0];
        candidateRow.validated_at = new Date("2026-07-28T10:00:00Z");
        candidateRow.activated_at = new Date("2026-07-28T10:00:00Z");
        return [{ affectedRows: 1 }, []];
      }
      if (normalized.startsWith("SELECT * FROM model_deployments WHERE deployment_id")) {
        return [[candidateRow], []];
      }
      throw new Error(`Unexpected SQL: ${normalized}`);
    },
  };

  const result = await createModelDeploymentRepository(executor)
    .activateClaimGuardCandidate({
      deploymentId,
      expectedArtifactSha256: "a".repeat(64),
      expectedCandidateImageDigest: candidateImage,
      releaseImageDigest: releaseImage,
    });

  assert.equal(result.alreadyActive, false);
  assert.equal(result.model.lifecycleStatus, "active");
  assert.equal(result.model.containerImageDigest, releaseImage);
  assert.deepEqual(result.retiredDeploymentIds, [
    "claimguard-claim-fraud-baseline:1.0.0",
  ]);
  assert.equal(
    calls.filter((call) =>
      call.sql.includes("SET lifecycle_status = 'retired'")).length,
    1,
  );
});

test("activation stops before mutation when candidate evidence differs", async () => {
  const deploymentId = "claimguard-claim-fraud-ensemble:2.1.1";
  const candidateRow = rowFrom([
    deploymentId,
    "claimguard-claim-fraud-ensemble",
    "2.1.1",
    "ClaimGuard fraud ensemble 2.1.1",
    "claimguard",
    null,
    "claimguard.claim-screening-request.v3",
    "claimguard.claim-screening-response.v3",
    "claim-feature-schema-2026.2",
    "PROSPECTIVE_CLAIM_SCREENING",
    0.049236234887246655,
    "CLAIMGUARD_CLAIM_FRAUD_ENSEMBLE_2_1_1_E0652D762C0E",
    "a".repeat(64),
    `registry.example/model@sha256:${"b".repeat(64)}`,
    JSON.stringify({ prospectiveClaimScreening: true }),
    "platform-admin-1",
  ]);
  let calls = 0;
  const repository = createModelDeploymentRepository({
    async execute(sql) {
      calls += 1;
      assert.match(String(sql), /FOR UPDATE/);
      return [[candidateRow], []];
    },
  });

  await assert.rejects(
    () => repository.activateClaimGuardCandidate({
      deploymentId,
      expectedArtifactSha256: "d".repeat(64),
      expectedCandidateImageDigest:
        `registry.example/model@sha256:${"b".repeat(64)}`,
      releaseImageDigest:
        `registry.example/model@sha256:${"c".repeat(64)}`,
    }),
    (error) => error.code === "MODEL_DEPLOYMENT_RELEASE_MISMATCH",
  );
  assert.equal(calls, 1);
});
