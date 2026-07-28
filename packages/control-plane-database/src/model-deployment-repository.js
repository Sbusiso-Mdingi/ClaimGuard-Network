import crypto from "node:crypto";

import {
  ControlPlaneConflictError,
  ControlPlaneNotFoundError,
  ControlPlaneValidationError,
} from "./errors.js";
import { executorOr } from "./transaction.js";
import { assertNoPlaintextPassword } from "./validation.js";

const DEPLOYMENT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const MODEL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const VERSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const IMAGE_DIGEST_PATTERN = /(?:^|@)sha256:[a-f0-9]{64}$/;

function requiredText(value, field, maximum) {
  const rendered = String(value || "").trim();
  if (!rendered || rendered.length > maximum) {
    throw new ControlPlaneValidationError(
      `${field} is required and must not exceed ${maximum} characters.`,
      "INVALID_MODEL_DEPLOYMENT",
    );
  }
  return rendered;
}

function identifier(value, field, pattern, maximum) {
  const rendered = requiredText(value, field, maximum);
  if (!pattern.test(rendered)) {
    throw new ControlPlaneValidationError(
      `${field} has an unsupported format.`,
      "INVALID_MODEL_DEPLOYMENT",
    );
  }
  return rendered;
}

function requiredDigest(value, field, pattern) {
  const rendered = String(value || "").trim().toLowerCase();
  if (!pattern.test(rendered)) {
    throw new ControlPlaneValidationError(
      `${field} must contain an immutable SHA-256 digest.`,
      "INVALID_MODEL_DEPLOYMENT_DIGEST",
    );
  }
  return rendered;
}

function threshold(value) {
  if (typeof value === "boolean") {
    throw new ControlPlaneValidationError(
      "decisionThreshold must be a probability.",
      "INVALID_MODEL_DEPLOYMENT_THRESHOLD",
    );
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
    throw new ControlPlaneValidationError(
      "decisionThreshold must be between 0 and 1.",
      "INVALID_MODEL_DEPLOYMENT_THRESHOLD",
    );
  }
  return parsed;
}

function capabilities(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ControlPlaneValidationError(
      "capabilities must be an object.",
      "INVALID_MODEL_DEPLOYMENT_CAPABILITIES",
    );
  }
  return value;
}

export function modelDeploymentRuntimeConfigKey(deploymentId) {
  const canonical = identifier(
    deploymentId,
    "deploymentId",
    DEPLOYMENT_ID_PATTERN,
    128,
  );
  const readable = canonical
    .replace(/[^A-Za-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toUpperCase()
    .slice(0, 64);
  const digest = crypto
    .createHash("sha256")
    .update(canonical)
    .digest("hex")
    .slice(0, 12)
    .toUpperCase();
  return `${readable}_${digest}`;
}

export function projectModelDeployment(row) {
  if (!row) return null;
  const rawCapabilities = row.capabilities;
  return {
    deploymentId: row.deployment_id,
    modelId: row.model_id,
    modelVersion: row.model_version,
    displayName: row.display_name,
    ownerType: row.owner_type,
    ownerOrganisationId: row.owner_organisation_id || null,
    lifecycleStatus: row.lifecycle_status,
    requestSchemaVersion: row.request_schema_version,
    responseSchemaVersion: row.response_schema_version,
    featureSchemaVersion: row.feature_schema_version,
    analysisMode: row.analysis_mode,
    decisionThreshold: Number(row.decision_threshold),
    runtimeConfigKey: row.runtime_config_key,
    artifactSha256: row.artifact_sha256 || null,
    containerImageDigest: row.container_image_digest || null,
    capabilities: typeof rawCapabilities === "string"
      ? JSON.parse(rawCapabilities)
      : rawCapabilities,
    automaticAdverseAction: Boolean(row.automatic_adverse_action),
    registeredBy: row.registered_by,
    validatedAt: row.validated_at || null,
    activatedAt: row.activated_at || null,
    retiredAt: row.retired_at || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function createModelDeploymentRepository(defaultExecutor) {
  return {
    async registerCandidate(input, { executor } = {}) {
      assertNoPlaintextPassword(input);
      const db = executorOr(defaultExecutor, executor);
      const deploymentId = identifier(
        input.deploymentId,
        "deploymentId",
        DEPLOYMENT_ID_PATTERN,
        128,
      );
      const modelId = identifier(
        input.modelId,
        "modelId",
        MODEL_ID_PATTERN,
        128,
      );
      const modelVersion = identifier(
        input.modelVersion,
        "modelVersion",
        VERSION_PATTERN,
        64,
      );
      const ownerType = String(input.ownerType || "").trim();
      const ownerOrganisationId = input.ownerOrganisationId
        ? String(input.ownerOrganisationId).trim()
        : null;
      if (
        (ownerType === "claimguard" && ownerOrganisationId)
        || (ownerType === "scheme" && !ownerOrganisationId)
        || !["claimguard", "scheme"].includes(ownerType)
      ) {
        throw new ControlPlaneValidationError(
          "Model ownership must be ClaimGuard-wide or identify one scheme.",
          "INVALID_MODEL_DEPLOYMENT_OWNER",
        );
      }
      if (ownerOrganisationId) {
        const [organisations] = await db.execute(
          `SELECT organisation_type FROM organisations
           WHERE organisation_id = ? LIMIT 1`,
          [ownerOrganisationId],
        );
        if (organisations?.[0]?.organisation_type !== "medical_scheme") {
          throw new ControlPlaneValidationError(
            "A scheme-owned deployment requires an existing medical scheme.",
            "MODEL_DEPLOYMENT_SCHEME_REQUIRED",
          );
        }
      }
      if (input.automaticAdverseAction === true) {
        throw new ControlPlaneValidationError(
          "Automatic adverse action is not permitted.",
          "MODEL_AUTOMATIC_ADVERSE_ACTION_FORBIDDEN",
        );
      }

      const row = {
        deploymentId,
        modelId,
        modelVersion,
        displayName: requiredText(input.displayName, "displayName", 255),
        ownerType,
        ownerOrganisationId,
        requestSchemaVersion: requiredText(
          input.requestSchemaVersion,
          "requestSchemaVersion",
          128,
        ),
        responseSchemaVersion: requiredText(
          input.responseSchemaVersion,
          "responseSchemaVersion",
          128,
        ),
        featureSchemaVersion: requiredText(
          input.featureSchemaVersion,
          "featureSchemaVersion",
          128,
        ),
        analysisMode: requiredText(input.analysisMode, "analysisMode", 128),
        decisionThreshold: threshold(input.decisionThreshold),
        runtimeConfigKey: modelDeploymentRuntimeConfigKey(deploymentId),
        artifactSha256: requiredDigest(
          input.artifactSha256,
          "artifactSha256",
          SHA256_PATTERN,
        ),
        containerImageDigest: requiredDigest(
          input.containerImageDigest,
          "containerImageDigest",
          IMAGE_DIGEST_PATTERN,
        ),
        capabilities: capabilities(input.capabilities),
        registeredBy: requiredText(input.registeredBy, "registeredBy", 255),
      };

      await db.execute(
        `INSERT INTO model_deployments
          (deployment_id, model_id, model_version, display_name, owner_type,
           owner_organisation_id, lifecycle_status, request_schema_version,
           response_schema_version, feature_schema_version, analysis_mode,
           decision_threshold, runtime_config_key, artifact_sha256,
           container_image_digest, capabilities, automatic_adverse_action,
           registered_by)
         VALUES (?, ?, ?, ?, ?, ?, 'candidate', ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`,
        [
          row.deploymentId,
          row.modelId,
          row.modelVersion,
          row.displayName,
          row.ownerType,
          row.ownerOrganisationId,
          row.requestSchemaVersion,
          row.responseSchemaVersion,
          row.featureSchemaVersion,
          row.analysisMode,
          row.decisionThreshold,
          row.runtimeConfigKey,
          row.artifactSha256,
          row.containerImageDigest,
          JSON.stringify(row.capabilities),
          row.registeredBy,
        ],
      );
      const [storedRows] = await db.execute(
        "SELECT * FROM model_deployments WHERE deployment_id = ? LIMIT 1",
        [deploymentId],
      );
      return projectModelDeployment(storedRows?.[0]);
    },

    async getById(deploymentId, { executor } = {}) {
      const canonical = identifier(
        deploymentId,
        "deploymentId",
        DEPLOYMENT_ID_PATTERN,
        128,
      );
      const [rows] = await executorOr(defaultExecutor, executor).execute(
        "SELECT * FROM model_deployments WHERE deployment_id = ? LIMIT 1",
        [canonical],
      );
      return projectModelDeployment(rows?.[0]);
    },

    async activateClaimGuardCandidate(input, { executor } = {}) {
      assertNoPlaintextPassword(input);
      const db = executorOr(defaultExecutor, executor);
      const deploymentId = identifier(
        input.deploymentId,
        "deploymentId",
        DEPLOYMENT_ID_PATTERN,
        128,
      );
      const expectedArtifactSha256 = requiredDigest(
        input.expectedArtifactSha256,
        "expectedArtifactSha256",
        SHA256_PATTERN,
      );
      const expectedCandidateImageDigest = requiredDigest(
        input.expectedCandidateImageDigest,
        "expectedCandidateImageDigest",
        IMAGE_DIGEST_PATTERN,
      );
      const releaseImageDigest = requiredDigest(
        input.releaseImageDigest,
        "releaseImageDigest",
        IMAGE_DIGEST_PATTERN,
      );

      const [rows] = await db.execute(
        `SELECT * FROM model_deployments
         WHERE deployment_id = ? LIMIT 1 FOR UPDATE`,
        [deploymentId],
      );
      const current = projectModelDeployment(rows?.[0]);
      if (!current) {
        throw new ControlPlaneNotFoundError(
          "The governed model deployment was not found.",
          "MODEL_DEPLOYMENT_NOT_FOUND",
        );
      }
      if (
        current.ownerType !== "claimguard"
        || current.ownerOrganisationId !== null
        || current.automaticAdverseAction
        || current.artifactSha256 !== expectedArtifactSha256
      ) {
        throw new ControlPlaneConflictError(
          "The governed model candidate does not match the approved release.",
          "MODEL_DEPLOYMENT_RELEASE_MISMATCH",
        );
      }
      if (
        current.lifecycleStatus === "active"
        && current.containerImageDigest === releaseImageDigest
        && current.validatedAt
        && current.activatedAt
        && !current.retiredAt
      ) {
        return {
          model: current,
          previous: current,
          retiredDeploymentIds: [],
          alreadyActive: true,
        };
      }
      if (
        current.lifecycleStatus !== "candidate"
        || current.containerImageDigest !== expectedCandidateImageDigest
        || current.validatedAt
        || current.activatedAt
        || current.retiredAt
      ) {
        throw new ControlPlaneConflictError(
          "The model deployment is not in the exact releasable candidate state.",
          "MODEL_DEPLOYMENT_NOT_RELEASABLE",
        );
      }

      const [activeRows] = await db.execute(
        `SELECT deployment_id FROM model_deployments
         WHERE owner_type = 'claimguard'
           AND owner_organisation_id IS NULL
           AND lifecycle_status = 'active'
           AND deployment_id <> ?
         FOR UPDATE`,
        [deploymentId],
      );
      const retiredDeploymentIds = (activeRows || [])
        .map((row) => row.deployment_id)
        .sort();

      await db.execute(
        `UPDATE model_deployments
         SET lifecycle_status = 'retired',
             retired_at = CURRENT_TIMESTAMP(3)
         WHERE owner_type = 'claimguard'
           AND owner_organisation_id IS NULL
           AND lifecycle_status = 'active'
           AND deployment_id <> ?`,
        [deploymentId],
      );
      await db.execute(
        `UPDATE model_deployments
         SET lifecycle_status = 'active',
             container_image_digest = ?,
             validated_at = CURRENT_TIMESTAMP(3),
             activated_at = CURRENT_TIMESTAMP(3),
             retired_at = NULL
         WHERE deployment_id = ?`,
        [releaseImageDigest, deploymentId],
      );
      const [storedRows] = await db.execute(
        "SELECT * FROM model_deployments WHERE deployment_id = ? LIMIT 1",
        [deploymentId],
      );
      const model = projectModelDeployment(storedRows?.[0]);
      if (
        !model
        || model.lifecycleStatus !== "active"
        || model.containerImageDigest !== releaseImageDigest
      ) {
        throw new ControlPlaneConflictError(
          "The model deployment activation could not be verified.",
          "MODEL_DEPLOYMENT_ACTIVATION_UNVERIFIED",
        );
      }
      return {
        model,
        previous: current,
        retiredDeploymentIds,
        alreadyActive: false,
      };
    },

    async listAll({ executor } = {}) {
      const [rows] = await executorOr(defaultExecutor, executor).execute(
        `SELECT * FROM model_deployments
         ORDER BY created_at DESC, deployment_id`,
      );
      return (rows || []).map(projectModelDeployment);
    },

    async listSelectableForOrganisation(organisationId, { executor } = {}) {
      const canonicalOrganisationId = requiredText(
        organisationId,
        "organisationId",
        36,
      );
      const [rows] = await executorOr(defaultExecutor, executor).execute(
        `SELECT * FROM model_deployments
         WHERE lifecycle_status = 'active'
           AND (
             owner_type = 'claimguard'
             OR (owner_type = 'scheme' AND owner_organisation_id = ?)
           )
         ORDER BY owner_type, display_name, deployment_id`,
        [canonicalOrganisationId],
      );
      return (rows || []).map(projectModelDeployment);
    },
  };
}
