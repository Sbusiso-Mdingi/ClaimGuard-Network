const DEPLOYMENT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const PUBLIC_SELECTION_TYPES = new Set([
  "claimguard_managed",
  "scheme_managed",
]);

export class DetectionModelSelectionError extends Error {
  constructor(message, code, status = 400) {
    super(message);
    this.name = "DetectionModelSelectionError";
    this.code = code;
    this.status = status;
  }
}

function selectionError(message, code, status = 400) {
  return new DetectionModelSelectionError(message, code, status);
}

function deploymentId(value) {
  const rendered = String(value || "").trim();
  return rendered && DEPLOYMENT_ID_PATTERN.test(rendered) ? rendered : null;
}

function approvedDeployments(environment = process.env) {
  return new Set(
    String(environment.APPROVED_MODEL_DEPLOYMENT_IDS || "")
      .split(",")
      .map((value) => value.trim())
      .filter((value) => DEPLOYMENT_ID_PATTERN.test(value)),
  );
}

function managedDeployment(environment = process.env) {
  const id = deploymentId(environment.CLAIMGUARD_MANAGED_MODEL_DEPLOYMENT_ID);
  if (!id || !approvedDeployments(environment).has(id)) {
    throw selectionError(
      "The ClaimGuard-managed model is not configured for this environment.",
      "CLAIMGUARD_MANAGED_MODEL_UNAVAILABLE",
      503,
    );
  }
  return id;
}

function schemeDeploymentMap(environment = process.env) {
  const raw = String(environment.SCHEME_MODEL_DEPLOYMENTS_JSON || "{}").trim();
  let parsed;
  try {
    parsed = JSON.parse(raw || "{}");
  } catch {
    throw selectionError(
      "Scheme model ownership configuration is invalid.",
      "SCHEME_MODEL_CONFIGURATION_INVALID",
      503,
    );
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw selectionError(
      "Scheme model ownership configuration is invalid.",
      "SCHEME_MODEL_CONFIGURATION_INVALID",
      503,
    );
  }

  const result = new Map();
  for (const [tenantId, values] of Object.entries(parsed)) {
    if (!Array.isArray(values)) {
      throw selectionError(
        "Scheme model ownership configuration is invalid.",
        "SCHEME_MODEL_CONFIGURATION_INVALID",
        503,
      );
    }
    result.set(
      tenantId,
      new Set(values.map(deploymentId).filter(Boolean)),
    );
  }
  return result;
}

function tenantIdFrom(tenantContext) {
  const tenantId = String(tenantContext?.tenant_id || "").trim();
  if (!tenantId) {
    throw selectionError(
      "A verified tenant context is required for model selection.",
      "DETECTION_MODEL_TENANT_REQUIRED",
      503,
    );
  }
  return tenantId;
}

function schemeDeployments(tenantContext, environment = process.env) {
  const tenantId = tenantIdFrom(tenantContext);
  return schemeDeploymentMap(environment).get(tenantId) || new Set();
}

function allSchemeDeploymentIds(environment = process.env) {
  return new Set(
    [...schemeDeploymentMap(environment).values()]
      .flatMap((deployments) => [...deployments]),
  );
}

export function listApprovedSchemeModelDeployments(
  tenantContext,
  environment = process.env,
  registeredModels = null,
) {
  const approved = approvedDeployments(environment);
  const registeredById = Array.isArray(registeredModels)
    ? new Map(registeredModels
      .filter((model) =>
        model?.ownerType === "scheme"
        && model?.lifecycleStatus === "active"
        && approved.has(model?.deploymentId))
      .map((model) => [model.deploymentId, model]))
    : null;
  const deploymentIds = registeredById
    ? [...registeredById.keys()]
    : [...schemeDeployments(tenantContext, environment)]
      .filter((id) => approved.has(id));
  return deploymentIds
    .sort((left, right) => left.localeCompare(right))
    .map((id) => {
      const registered = registeredById?.get(id);
      return Object.freeze({
        deploymentId: id,
        displayName: registered?.displayName || id,
        modelId: registered?.modelId || null,
        modelVersion: registered?.modelVersion || null,
        featureSchemaVersion: registered?.featureSchemaVersion || null,
        ownership: "scheme",
      });
    });
}

export function projectDetectionModelSelection(
  storedStrategy,
  tenantContext,
  environment = process.env,
  registeredModels = null,
) {
  const storedType = String(storedStrategy?.strategyType || "").trim();
  const storedDeploymentId = deploymentId(storedStrategy?.modelDeploymentId);

  if (storedType === "deterministic_rules") {
    return {
      strategyType: "selection_required",
      modelDeploymentId: null,
      requiresSelection: true,
      legacyStrategyType: "deterministic_rules",
      message: "Deterministic scoring is no longer selectable. Choose a managed ML model.",
    };
  }

  if (storedType !== "approved_model" || !storedDeploymentId) {
    return {
      strategyType: "selection_required",
      modelDeploymentId: null,
      requiresSelection: true,
      legacyStrategyType: storedType || null,
      message: "The stored detection configuration must be replaced with a supported ML model selection.",
    };
  }

  let configuredManagedId = null;
  try {
    configuredManagedId = managedDeployment(environment);
  } catch (error) {
    if (!(error instanceof DetectionModelSelectionError)) throw error;
  }
  const catalogueModel = Array.isArray(registeredModels)
    ? registeredModels.find((model) =>
      model?.deploymentId === storedDeploymentId
      && model?.lifecycleStatus === "active")
    : null;
  const catalogueConfigured = Array.isArray(registeredModels);

  if (
    configuredManagedId
    && storedDeploymentId === configuredManagedId
    && (!catalogueConfigured || catalogueModel?.ownerType === "claimguard")
  ) {
    return {
      strategyType: "claimguard_managed",
      modelDeploymentId: storedDeploymentId,
      requiresSelection: false,
      managedBy: "claimguard",
      updateAvailable: false,
      recommendedModelDeploymentId: configuredManagedId,
    };
  }

  if (
    catalogueConfigured
      ? catalogueModel?.ownerType === "scheme"
      : schemeDeployments(tenantContext, environment).has(storedDeploymentId)
  ) {
    return {
      strategyType: "scheme_managed",
      modelDeploymentId: storedDeploymentId,
      requiresSelection: false,
      managedBy: "scheme",
      updateAvailable: false,
      recommendedModelDeploymentId: null,
    };
  }

  if (
    configuredManagedId
    && approvedDeployments(environment).has(storedDeploymentId)
    && (
      catalogueConfigured
        ? catalogueModel?.ownerType === "claimguard"
        : !allSchemeDeploymentIds(environment).has(storedDeploymentId)
    )
  ) {
    return {
      strategyType: "claimguard_managed",
      modelDeploymentId: storedDeploymentId,
      requiresSelection: false,
      managedBy: "claimguard",
      updateAvailable: true,
      recommendedModelDeploymentId: configuredManagedId,
    };
  }

  return {
    strategyType: "selection_required",
    modelDeploymentId: null,
    requiresSelection: true,
    legacyStrategyType: "approved_model",
    message: "The stored model is not registered as the ClaimGuard-managed model or as this scheme's proprietary model.",
  };
}

export function resolveDetectionModelSelection(
  input,
  tenantContext,
  environment = process.env,
  registeredModels = null,
) {
  const strategyType = String(input?.strategyType || "").trim();
  if (!PUBLIC_SELECTION_TYPES.has(strategyType)) {
    throw selectionError(
      "strategyType must be claimguard_managed or scheme_managed.",
      "DETECTION_MODEL_SELECTION_INVALID",
    );
  }

  const submittedDeploymentId = deploymentId(input?.modelDeploymentId);

  if (strategyType === "claimguard_managed") {
    if (String(input?.modelDeploymentId || "").trim()) {
      throw selectionError(
        "ClaimGuard-managed selection cannot pin a scheme-supplied deployment ID.",
        "MANAGED_MODEL_DEPLOYMENT_FORBIDDEN",
      );
    }

    const resolvedDeploymentId = managedDeployment(environment);
    if (
      Array.isArray(registeredModels)
      && !registeredModels.some((model) =>
        model?.deploymentId === resolvedDeploymentId
        && model?.ownerType === "claimguard"
        && model?.lifecycleStatus === "active")
    ) {
      throw selectionError(
        "The ClaimGuard-managed runtime deployment is not active in the model catalogue.",
        "CLAIMGUARD_MANAGED_MODEL_CATALOGUE_MISMATCH",
        503,
      );
    }
    return {
      publicSelection: {
        strategyType,
        modelDeploymentId: resolvedDeploymentId,
        requiresSelection: false,
        managedBy: "claimguard",
        updateAvailable: false,
        recommendedModelDeploymentId: resolvedDeploymentId,
      },
      repositoryChange: {
        strategyType: "approved_model",
        modelDeploymentId: resolvedDeploymentId,
      },
    };
  }

  if (!submittedDeploymentId) {
    throw selectionError(
      "A registered proprietary model deployment ID is required.",
      "SCHEME_MODEL_DEPLOYMENT_REQUIRED",
    );
  }

  const tenantDeploymentApproved = Array.isArray(registeredModels)
    ? registeredModels.some((model) =>
      model?.deploymentId === submittedDeploymentId
      && model?.ownerType === "scheme"
      && model?.lifecycleStatus === "active")
    : schemeDeployments(tenantContext, environment).has(submittedDeploymentId);
  if (
    !tenantDeploymentApproved
    || !approvedDeployments(environment).has(submittedDeploymentId)
  ) {
    throw selectionError(
      "The proprietary model deployment is not registered and approved for this scheme.",
      "SCHEME_MODEL_DEPLOYMENT_NOT_APPROVED",
    );
  }

  return {
    publicSelection: {
      strategyType,
      modelDeploymentId: submittedDeploymentId,
      requiresSelection: false,
      managedBy: "scheme",
      updateAvailable: false,
      recommendedModelDeploymentId: null,
    },
    repositoryChange: {
      strategyType: "approved_model",
      modelDeploymentId: submittedDeploymentId,
    },
  };
}
