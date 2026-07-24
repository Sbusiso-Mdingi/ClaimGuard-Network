import React, { useEffect, useState } from "react";

import { apiJson } from "../../lib/apiClient";
import "./DetectionEngineSettings.css";

const MODEL_SELECTIONS = new Set([
  "claimguard_managed",
  "scheme_managed",
]);

const DEPLOYMENT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

function normaliseSelection(strategy) {
  const strategyType = String(strategy?.strategyType || "").trim();

  if (strategyType === "selection_required") {
    return {
      strategyType: "",
      modelDeploymentId: "",
      requiresSelection: true,
      message: strategy?.message || "Choose the ML model that ClaimGuard should use for this scheme.",
    };
  }

  if (!MODEL_SELECTIONS.has(strategyType)) {
    throw new Error("The API returned an unsupported detection-model selection.");
  }

  const modelDeploymentId = String(strategy?.modelDeploymentId || "").trim();
  if (modelDeploymentId && !DEPLOYMENT_ID_PATTERN.test(modelDeploymentId)) {
    throw new Error("The API returned an invalid model deployment identifier.");
  }

  return {
    strategyType,
    modelDeploymentId,
    requiresSelection: false,
    message: null,
  };
}

function sameSelection(left, right) {
  return left.strategyType === right.strategyType
    && left.modelDeploymentId === right.modelDeploymentId;
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
  const [savedSelection, setSavedSelection] = useState({
    strategyType: "",
    modelDeploymentId: "",
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
        if (!mounted) return;

        setStrategyType(selection.strategyType);
        setProprietaryDeploymentId(
          selection.strategyType === "scheme_managed"
            ? selection.modelDeploymentId
            : "",
        );
        setSavedSelection({
          strategyType: selection.strategyType,
          modelDeploymentId: selection.modelDeploymentId,
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
  const customDeploymentValid = strategyType !== "scheme_managed"
    || (Boolean(canonicalProprietaryDeploymentId)
      && DEPLOYMENT_ID_PATTERN.test(canonicalProprietaryDeploymentId));
  const canSave = !loading
    && !saving
    && MODEL_SELECTIONS.has(strategyType)
    && (configurationChanged || Boolean(selectionRequiredMessage))
    && reasonValid
    && customDeploymentValid;

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
      setError("Choose ClaimGuard's managed model or a registered proprietary model.");
      return;
    }
    if (!customDeploymentValid) {
      setError("Enter a valid registered proprietary model deployment ID.");
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
        strategyType: saved.strategyType,
        modelDeploymentId: saved.modelDeploymentId,
      });
      setSelectionRequiredMessage("");
      setChangeReason("");
      setNotice("Detection model selection saved.");
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
        <h3 className="settings-title">Detection Model</h3>
        <p className="settings-description">
          Choose which machine-learning model scores prospective claims for this scheme.
          Deterministic rules are not available as a substitute for model scoring.
        </p>
      </div>

      {selectionRequiredMessage ? (
        <div className="error-message" role="status">
          {selectionRequiredMessage}
        </div>
      ) : null}

      <div className="strategy-toggle-group" role="radiogroup" aria-label="Detection model">
        <ModelChoice
          title="ClaimGuard Managed Model"
          description="Use ClaimGuard's currently approved fraud-detection model. ClaimGuard manages validated upgrades, monitoring and rollback."
          badge="Managed by ClaimGuard"
          selected={strategyType === "claimguard_managed"}
          disabled={saving}
          onSelect={() => select("claimguard_managed")}
        />

        <ModelChoice
          title="Custom Proprietary Model"
          description="Use a deployment registered, approved and owned by this medical scheme."
          badge="Scheme managed"
          selected={strategyType === "scheme_managed"}
          disabled={saving}
          onSelect={() => select("scheme_managed")}
        />
      </div>

      {strategyType === "claimguard_managed" && savedSelection.strategyType === "claimguard_managed" && savedSelection.modelDeploymentId ? (
        <div className="url-input-container">
          <p className="url-input-label">Current ClaimGuard deployment</p>
          <code className="block break-all rounded-lg bg-background p-3 text-sm">{savedSelection.modelDeploymentId}</code>
        </div>
      ) : null}

      {strategyType === "scheme_managed" ? (
        <div className="url-input-container">
          <label className="url-input-label" htmlFor="model-deployment-id">
            Registered proprietary model deployment ID
          </label>
          <input
            id="model-deployment-id"
            className="url-input"
            type="text"
            placeholder="ubuntu-fraud-model:production"
            value={proprietaryDeploymentId}
            maxLength={128}
            autoComplete="off"
            spellCheck={false}
            disabled={saving}
            onChange={(event) => {
              setProprietaryDeploymentId(event.target.value);
              setError(null);
              setNotice(null);
            }}
          />
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
          placeholder="Explain why this model selection is being activated."
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
        {saving ? "Saving Model Selection..." : "Save Model Selection"}
      </button>
    </div>
  );
}
