import React, { useEffect, useState } from "react";

import { apiJson } from "../../lib/apiClient";
import { PRODUCT_NAME } from "../../lib/productBrand";
import "./DetectionEngineSettings.css";

const MODEL_SELECTIONS = new Set([
  "claimguard_managed",
  "scheme_managed",
]);

const DEPLOYMENT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

function normaliseSelection(strategy) {
  const strategyType = String(strategy?.strategyType || "").trim();
  const strategyId = Number(strategy?.strategyId);
  if (!Number.isSafeInteger(strategyId) || strategyId <= 0) {
    throw new Error("The API returned an invalid detection strategy identifier.");
  }

  if (strategyType === "selection_required") {
    return {
      strategyId,
      strategyType: "",
      modelDeploymentId: "",
      requiresSelection: true,
      message: strategy?.message || `Choose the ML model that ${PRODUCT_NAME} should use for this scheme.`,
    };
  }

  if (!MODEL_SELECTIONS.has(strategyType)) {
    throw new Error("The API returned an unsupported detection-model selection.");
  }

  const modelDeploymentId = String(strategy?.modelDeploymentId || "").trim();
  if (modelDeploymentId && !DEPLOYMENT_ID_PATTERN.test(modelDeploymentId)) {
    throw new Error("The API returned an invalid model deployment identifier.");
  }
  const recommendedModelDeploymentId = String(strategy?.recommendedModelDeploymentId || "").trim();
  if (recommendedModelDeploymentId && !DEPLOYMENT_ID_PATTERN.test(recommendedModelDeploymentId)) {
    throw new Error("The API returned an invalid recommended model deployment identifier.");
  }

  return {
    strategyId,
    strategyType,
    modelDeploymentId,
    updateAvailable: strategyType === "claimguard_managed" && strategy?.updateAvailable === true,
    recommendedModelDeploymentId,
    requiresSelection: false,
    message: null,
  };
}

function sameSelection(left, right) {
  return left.strategyType === right.strategyType
    && left.modelDeploymentId === right.modelDeploymentId;
}

function normaliseSchemeOwnedModels(catalogue) {
  const values = catalogue?.schemeOwned;
  if (!Array.isArray(values)) return [];

  const seen = new Set();
  return values.map((model) => {
    const deploymentId = String(model?.deploymentId || "").trim();
    if (
      !DEPLOYMENT_ID_PATTERN.test(deploymentId)
      || model?.ownership !== "scheme"
      || seen.has(deploymentId)
    ) {
      throw new Error("The API returned an invalid scheme-owned model catalogue.");
    }
    seen.add(deploymentId);
    return {
      deploymentId,
      displayName: String(model?.displayName || deploymentId).trim()
        || deploymentId,
    };
  });
}

function ModelChoice({
  title,
  description,
  selected,
  disabled,
  onSelect,
  badge,
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      disabled={disabled}
      className={`strategy-card ${selected ? "active" : ""}`}
      onClick={onSelect}
    >
      <div className="strategy-content">
        <div className="flex flex-wrap items-center gap-2">
          <h4 className="strategy-name">{title}</h4>
          {badge ? <span className="rounded-full border border-border px-2 py-0.5 text-xs">{badge}</span> : null}
        </div>
        <p className="strategy-desc">{description}</p>
      </div>
      <div className="strategy-status" aria-hidden="true" />
    </button>
  );
}

export function DetectionEngineSettings({ tenantId }) {
  const [strategyType, setStrategyType] = useState("");
  const [proprietaryDeploymentId, setProprietaryDeploymentId] = useState("");
  const [schemeOwnedModels, setSchemeOwnedModels] = useState([]);
  const [savedSelection, setSavedSelection] = useState({
    strategyId: null,
    strategyType: "",
    modelDeploymentId: "",
    updateAvailable: false,
    recommendedModelDeploymentId: "",
  });
  const [selectionRequiredMessage, setSelectionRequiredMessage] = useState("");
  const [changeReason, setChangeReason] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);

  useEffect(() => {
    let mounted = true;

    async function fetchSelection() {
      setLoading(true);
      setError(null);
      setNotice(null);

      try {
        const data = await apiJson("/detection/strategy", { cache: "no-store" });
        if (!data?.available || !data?.strategy) {
          throw new Error(data?.message || "Detection-model selection is unavailable.");
        }

        const selection = normaliseSelection(data.strategy);
        const registeredModels = normaliseSchemeOwnedModels(
          data.modelCatalogue,
        );
        if (!mounted) return;

        setSchemeOwnedModels(registeredModels);
        setStrategyType(selection.strategyType);
        setProprietaryDeploymentId(
          selection.strategyType === "scheme_managed"
            ? selection.modelDeploymentId
            : "",
        );
        setSavedSelection({
          strategyId: selection.strategyId,
          strategyType: selection.strategyType,
          modelDeploymentId: selection.modelDeploymentId,
          updateAvailable: selection.updateAvailable,
          recommendedModelDeploymentId: selection.recommendedModelDeploymentId,
        });
        setSelectionRequiredMessage(selection.requiresSelection ? selection.message : "");
        setChangeReason("");
      } catch (fetchError) {
        if (mounted) {
          setError(fetchError?.message || "Failed to load the detection-model selection.");
        }
      } finally {
        if (mounted) setLoading(false);
      }
    }

    fetchSelection();
    return () => {
      mounted = false;
    };
  }, [tenantId]);

  const canonicalProprietaryDeploymentId = proprietaryDeploymentId.trim();
  const currentSelection = {
    strategyType,
    modelDeploymentId: strategyType === "scheme_managed"
      ? canonicalProprietaryDeploymentId
      : savedSelection.strategyType === "claimguard_managed"
        ? savedSelection.modelDeploymentId
        : "",
  };

  const configurationChanged = !sameSelection(currentSelection, savedSelection);
  const reason = changeReason.trim();
  const reasonValid = reason.length >= 1 && reason.length <= 500;
  const registeredSchemeDeploymentIds = new Set(
    schemeOwnedModels.map((model) => model.deploymentId),
  );
  const customDeploymentValid = strategyType !== "scheme_managed"
    || (Boolean(canonicalProprietaryDeploymentId)
      && registeredSchemeDeploymentIds.has(canonicalProprietaryDeploymentId));
  const canSave = !loading
    && !saving
    && MODEL_SELECTIONS.has(strategyType)
    && (configurationChanged || Boolean(selectionRequiredMessage) || savedSelection.updateAvailable)
    && reasonValid
    && customDeploymentValid;
  const displayedDeploymentId = strategyType === "scheme_managed"
    ? canonicalProprietaryDeploymentId || "Not selected"
    : savedSelection.strategyType === "claimguard_managed"
      ? savedSelection.modelDeploymentId || `Resolved by ${PRODUCT_NAME}`
      : "Resolved when activated";
  const policyLabel = strategyType === "claimguard_managed"
    ? `${PRODUCT_NAME} managed`
    : strategyType === "scheme_managed"
      ? "Scheme-owned pin"
      : "Selection required";
  const updateBehaviour = strategyType === "claimguard_managed"
    ? `Eligible for audited ${PRODUCT_NAME} model rollouts`
    : strategyType === "scheme_managed"
      ? "Remains pinned until a scheme administrator changes it"
      : "No supported model policy is active";

  function select(nextStrategyType) {
    if (saving || !MODEL_SELECTIONS.has(nextStrategyType)) return;
    setStrategyType(nextStrategyType);
    if (nextStrategyType === "claimguard_managed") {
      setProprietaryDeploymentId("");
    } else if (savedSelection.strategyType === "scheme_managed") {
      setProprietaryDeploymentId(savedSelection.modelDeploymentId);
    } else {
      setProprietaryDeploymentId("");
    }
    setError(null);
    setNotice(null);
  }

  async function handleSave() {
    setError(null);
    setNotice(null);

    if (!MODEL_SELECTIONS.has(strategyType)) {
      setError(`Choose ${PRODUCT_NAME}'s managed model or a registered proprietary model.`);
      return;
    }
    if (!customDeploymentValid) {
      setError("Select a registered proprietary model deployment.");
      return;
    }
    if (!reasonValid) {
      setError("Change reason must contain 1–500 characters.");
      return;
    }

    setSaving(true);
    try {
      const data = await apiJson("/detection/strategy", {
        method: "PUT",
        body: JSON.stringify({
          strategyType,
          modelDeploymentId: strategyType === "scheme_managed"
            ? canonicalProprietaryDeploymentId
            : null,
          changeReason: reason,
          expectedActiveStrategyId: savedSelection.strategyId,
        }),
      });

      if (!data?.available || !data?.strategy) {
        throw new Error(data?.message || "The model selection was not accepted.");
      }

      const saved = normaliseSelection(data.strategy);
      setStrategyType(saved.strategyType);
      setProprietaryDeploymentId(
        saved.strategyType === "scheme_managed"
          ? saved.modelDeploymentId
          : "",
      );
      setSavedSelection({
        strategyId: saved.strategyId,
        strategyType: saved.strategyType,
        modelDeploymentId: saved.modelDeploymentId,
        updateAvailable: saved.updateAvailable,
        recommendedModelDeploymentId: saved.recommendedModelDeploymentId,
      });
      setSelectionRequiredMessage("");
      setChangeReason("");
      setNotice("Model update policy saved. New claims will pin the deployment active at ingestion.");
    } catch (saveError) {
      setError(saveError?.message || "Failed to save the detection model selection.");
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return (
      <div className="detection-settings-container" role="status" aria-live="polite">
        <div className="loading-spinner" aria-hidden="true" />
        <span className="sr-only">Loading detection model selection</span>
      </div>
    );
  }

  return (
    <div className="detection-settings-container">
      <div className="settings-header">
        <h3 className="settings-title">Model update policy</h3>
        <p className="settings-description">
          Choose how the approved machine-learning deployment is governed for this scheme.
          The policy applies prospectively: existing claims and historical outbox work are never rewritten.
        </p>
      </div>

      {selectionRequiredMessage ? (
        <div className="error-message" role="status">
          {selectionRequiredMessage}
        </div>
      ) : null}

      {savedSelection.updateAvailable ? (
        <div className="managed-update-notice" role="status">
          <strong>Managed model update available</strong>
          <span>
            {PRODUCT_NAME} recommends <code>{savedSelection.recommendedModelDeploymentId}</code>.
            Save with an auditable reason to activate it for new claims.
          </span>
        </div>
      ) : null}

      <div className="model-policy-summary" aria-label="Current model policy summary">
        <div>
          <span>Policy</span>
          <strong>{policyLabel}</strong>
        </div>
        <div>
          <span>Effective deployment</span>
          <code>{displayedDeploymentId}</code>
        </div>
        <div>
          <span>Update behaviour</span>
          <strong>{updateBehaviour}</strong>
        </div>
      </div>

      <div className="strategy-toggle-group" role="radiogroup" aria-label="Model update policy">
        <ModelChoice
          title={`${PRODUCT_NAME}-managed updates`}
          description={`Use ${PRODUCT_NAME}'s current approved detection model. Validated version changes are applied through audited rollout operations, with monitoring and rollback.`}
          badge={`Managed by ${PRODUCT_NAME}`}
          selected={strategyType === "claimguard_managed"}
          disabled={saving}
          onSelect={() => select("claimguard_managed")}
        />

        <ModelChoice
          title="Scheme-owned model pin"
          description="Pin this scheme to one registered and approved proprietary deployment until an authorised administrator changes it."
          badge="Scheme controlled"
          selected={strategyType === "scheme_managed"}
          disabled={saving}
          onSelect={() => select("scheme_managed")}
        />
      </div>

      {strategyType === "claimguard_managed" && savedSelection.strategyType === "claimguard_managed" && savedSelection.modelDeploymentId ? (
        <div className="url-input-container">
          <p className="url-input-label">Current {PRODUCT_NAME} deployment</p>
          <code className="block break-all rounded-lg bg-background p-3 text-sm">{savedSelection.modelDeploymentId}</code>
        </div>
      ) : null}

      {strategyType === "scheme_managed" ? (
        <div className="url-input-container">
          <label className="url-input-label" htmlFor="model-deployment-id">
            Registered proprietary model
          </label>
          <select
            id="model-deployment-id"
            className="url-input"
            value={proprietaryDeploymentId}
            disabled={saving || schemeOwnedModels.length === 0}
            onChange={(event) => {
              setProprietaryDeploymentId(event.target.value);
              setError(null);
              setNotice(null);
            }}
          >
            <option value="">Choose a registered deployment</option>
            {schemeOwnedModels.map((model) => (
              <option
                key={model.deploymentId}
                value={model.deploymentId}
              >
                {model.displayName}
              </option>
            ))}
          </select>
          {schemeOwnedModels.length === 0 ? (
            <p className="strategy-desc">
              No proprietary model has been registered and approved for this scheme.
            </p>
          ) : null}
        </div>
      ) : null}

      <div className="url-input-container">
        <label className="url-input-label" htmlFor="strategy-change-reason">
          Reason for change
        </label>
        <textarea
          id="strategy-change-reason"
          className="url-input"
          rows={4}
          maxLength={500}
          value={changeReason}
          disabled={saving}
          placeholder="Explain why this model policy is being activated."
          onChange={(event) => {
            setChangeReason(event.target.value);
            setError(null);
            setNotice(null);
          }}
        />
        <p className="settings-description">{changeReason.length}/500 characters</p>
      </div>

      {error ? <div className="error-message" role="alert">{error}</div> : null}
      {notice ? <p className="settings-description" role="status" aria-live="polite">{notice}</p> : null}

      <button
        className="save-button"
        type="button"
        onClick={handleSave}
        disabled={!canSave}
      >
        {saving ? "Saving Model Policy..." : savedSelection.updateAvailable && strategyType === "claimguard_managed" ? "Apply Managed Model Update" : "Save Model Policy"}
      </button>
    </div>
  );
}
