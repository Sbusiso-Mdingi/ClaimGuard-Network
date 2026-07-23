import React, {
  useEffect,
  useState,
} from "react";

import { apiJson } from "../../lib/apiClient";
import "./DetectionEngineSettings.css";


const STRATEGY_TYPES = new Set([
  "deterministic_rules",
  "approved_model",
]);

const DEPLOYMENT_ID_PATTERN =
  /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

const EMPTY_CONFIGURATION = Object.freeze({
  strategyType: "deterministic_rules",
  modelDeploymentId: null,
});


function normaliseStrategy(
  strategy,
) {
  const strategyType = String(
    strategy?.strategyType || "",
  ).trim();

  if (
    !STRATEGY_TYPES.has(
      strategyType,
    )
  ) {
    throw new Error(
      "The API returned an unsupported detection strategy.",
    );
  }

  const modelDeploymentId =
    strategyType === "approved_model"
      ? String(
          strategy?.modelDeploymentId || "",
        ).trim()
      : null;

  if (
    strategyType === "approved_model"
    && (
      !modelDeploymentId
      || !DEPLOYMENT_ID_PATTERN.test(
        modelDeploymentId,
      )
    )
  ) {
    throw new Error(
      "The API returned an invalid approved model deployment.",
    );
  }

  return {
    strategyType,
    modelDeploymentId,
  };
}


function sameConfiguration(
  left,
  right,
) {
  return (
    left.strategyType
      === right.strategyType
    && left.modelDeploymentId
      === right.modelDeploymentId
  );
}


export function DetectionEngineSettings({
  tenantId,
}) {
  const [
    strategyType,
    setStrategyType,
  ] = useState(
    EMPTY_CONFIGURATION.strategyType,
  );

  const [
    modelDeploymentId,
    setModelDeploymentId,
  ] = useState("");

  const [
    savedConfiguration,
    setSavedConfiguration,
  ] = useState(
    EMPTY_CONFIGURATION,
  );

  const [
    changeReason,
    setChangeReason,
  ] = useState("");

  const [
    loading,
    setLoading,
  ] = useState(true);

  const [
    saving,
    setSaving,
  ] = useState(false);

  const [
    error,
    setError,
  ] = useState(null);

  const [
    notice,
    setNotice,
  ] = useState(null);

  useEffect(
    () => {
      let mounted = true;

      async function fetchStrategy() {
        setLoading(true);
        setError(null);
        setNotice(null);

        try {
          const data = await apiJson(
            "/detection/strategy",
            {
              cache: "no-store",
            },
          );

          if (
            !data?.available
            || !data?.strategy
          ) {
            throw new Error(
              data?.message
              || "Detection strategy is unavailable.",
            );
          }

          const configuration =
            normaliseStrategy(
              data.strategy,
            );

          if (!mounted) {
            return;
          }

          setStrategyType(
            configuration.strategyType,
          );

          setModelDeploymentId(
            configuration.modelDeploymentId
            || "",
          );

          setSavedConfiguration(
            configuration,
          );

          setChangeReason("");
        } catch (fetchError) {
          if (!mounted) {
            return;
          }

          setError(
            fetchError?.message
            || "Failed to load the detection strategy.",
          );
        } finally {
          if (mounted) {
            setLoading(false);
          }
        }
      }

      fetchStrategy();

      return () => {
        mounted = false;
      };
    },
    [
      tenantId,
    ],
  );

  const canonicalDeploymentId =
    strategyType === "approved_model"
      ? modelDeploymentId.trim()
      : null;

  const currentConfiguration = {
    strategyType,
    modelDeploymentId:
      canonicalDeploymentId,
  };

  const configurationChanged =
    !sameConfiguration(
      currentConfiguration,
      savedConfiguration,
    );

  const canonicalChangeReason =
    changeReason.trim();

  const changeReasonValid =
    canonicalChangeReason.length >= 1
    && canonicalChangeReason.length
      <= 500;

  const deploymentValid =
    strategyType
      === "deterministic_rules"
    || (
      Boolean(
        canonicalDeploymentId,
      )
      && DEPLOYMENT_ID_PATTERN.test(
        canonicalDeploymentId,
      )
    );

  const canSave =
    !loading
    && !saving
    && configurationChanged
    && changeReasonValid
    && deploymentValid;

  function selectStrategy(
    nextStrategy,
  ) {
    if (
      saving
      || !STRATEGY_TYPES.has(
        nextStrategy,
      )
    ) {
      return;
    }

    setStrategyType(
      nextStrategy,
    );

    setError(null);
    setNotice(null);
  }

  function handleStrategyKeyDown(
    event,
    nextStrategy,
  ) {
    if (
      event.key === "Enter"
      || event.key === " "
    ) {
      event.preventDefault();

      selectStrategy(
        nextStrategy,
      );
    }
  }

  async function handleSave() {
    setError(null);
    setNotice(null);

    if (!configurationChanged) {
      setError(
        "Select a different strategy or model deployment before saving.",
      );

      return;
    }

    if (!deploymentValid) {
      setError(
        "Enter a valid approved model deployment ID.",
      );

      return;
    }

    if (!changeReasonValid) {
      setError(
        "Change reason must contain 1–500 characters.",
      );

      return;
    }

    setSaving(true);

    try {
      const data = await apiJson(
        "/detection/strategy",
        {
          method: "PUT",

          body: JSON.stringify({
            strategyType,

            modelDeploymentId:
              canonicalDeploymentId,

            changeReason:
              canonicalChangeReason,
          }),
        },
      );

      if (
        !data?.available
        || !data?.strategy
      ) {
        throw new Error(
          data?.message
          || "The strategy update was not accepted.",
        );
      }

      const saved =
        normaliseStrategy(
          data.strategy,
        );

      setSavedConfiguration(
        saved,
      );

      setStrategyType(
        saved.strategyType,
      );

      setModelDeploymentId(
        saved.modelDeploymentId
        || "",
      );

      setChangeReason("");

      setNotice(
        "Detection strategy configuration saved.",
      );
    } catch (saveError) {
      setError(
        saveError?.message
        || "Failed to save the detection strategy.",
      );
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return (
      <div
        className="detection-settings-container"
        role="status"
        aria-live="polite"
      >
        <div
          className="loading-spinner"
          aria-hidden="true"
        />

        <span className="sr-only">
          Loading detection strategy
        </span>
      </div>
    );
  }

  return (
    <div className="detection-settings-container">
      <div className="settings-header">
        <h3 className="settings-title">
          <svg
            width="24"
            height="24"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="M12 2v20M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6" />
          </svg>

          Detection Strategy
        </h3>

        <p className="settings-description">
          Select the versioned engine used for
          prospective claim-version scoring.
        </p>
      </div>

      <div
        className="strategy-toggle-group"
        role="radiogroup"
        aria-label="Detection strategy"
      >
        <div
          className={
            `strategy-card ${
              strategyType
                === "deterministic_rules"
                ? "active"
                : ""
            }`
          }
          role="radio"
          aria-checked={
            strategyType
            === "deterministic_rules"
          }
          aria-disabled={saving}
          tabIndex={saving ? -1 : 0}
          onClick={() =>
            selectStrategy(
              "deterministic_rules",
            )
          }
          onKeyDown={(event) =>
            handleStrategyKeyDown(
              event,
              "deterministic_rules",
            )
          }
        >
          <div className="strategy-icon">
            <svg
              width="20"
              height="20"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              aria-hidden="true"
            >
              <rect
                x="3"
                y="3"
                width="18"
                height="18"
                rx="2"
              />

              <path d="M9 3v18M15 3v18M3 9h18M3 15h18" />
            </svg>
          </div>

          <div className="strategy-content">
            <h4 className="strategy-name">
              ClaimGuard Detection Engine
            </h4>

            <p className="strategy-desc">
              Built-in rules, heuristics and
              graph analytics.
            </p>
          </div>

          <div
            className="strategy-status"
            aria-hidden="true"
          />
        </div>

        <div
          className={
            `strategy-card ml-endpoint ${
              strategyType
                === "approved_model"
                ? "active ml-endpoint"
                : ""
            }`
          }
          role="radio"
          aria-checked={
            strategyType
            === "approved_model"
          }
          aria-disabled={saving}
          tabIndex={saving ? -1 : 0}
          onClick={() =>
            selectStrategy(
              "approved_model",
            )
          }
          onKeyDown={(event) =>
            handleStrategyKeyDown(
              event,
              "approved_model",
            )
          }
        >
          <div className="strategy-icon">
            <svg
              width="20"
              height="20"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              aria-hidden="true"
            >
              <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zM12 11c1.66 0 3-1.34 3-3s-1.34-3-3-3-3 1.34-3 3 1.34 3 3zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z" />

              <path d="M16 8l4 4-4 4" />

              <path d="M8 16l-4-4 4-4" />
            </svg>
          </div>

          <div className="strategy-content">
            <h4 className="strategy-name">
              Approved ClaimGuard Model
            </h4>

            <p className="strategy-desc">
              Use an immutable model deployment
              approved for this environment.
            </p>
          </div>

          <div
            className="strategy-status"
            aria-hidden="true"
          />
        </div>
      </div>

      {strategyType === "approved_model" && (
        <div className="url-input-container">
          <label
            className="url-input-label"
            htmlFor="model-deployment-id"
          >
            Approved model deployment ID
          </label>

          <input
            id="model-deployment-id"
            className="url-input"
            type="text"
            placeholder="claimguard-claim-fraud-ensemble:1.1.0"
            value={modelDeploymentId}
            maxLength={128}
            autoComplete="off"
            spellCheck={false}
            disabled={saving}
            onChange={(event) => {
              setModelDeploymentId(
                event.target.value,
              );

              setError(null);
              setNotice(null);
            }}
          />
        </div>
      )}

      <div className="url-input-container">
        <label
          className="url-input-label"
          htmlFor="strategy-change-reason"
        >
          Reason for change
        </label>

        <textarea
          id="strategy-change-reason"
          className="url-input"
          rows={4}
          maxLength={500}
          value={changeReason}
          disabled={saving}
          placeholder={
            "Explain why this strategy or model deployment is being activated."
          }
          onChange={(event) => {
            setChangeReason(
              event.target.value,
            );

            setError(null);
            setNotice(null);
          }}
        />

        <p className="settings-description">
          {changeReason.length}/500 characters
        </p>
      </div>

      {error && (
        <div
          className="error-message"
          role="alert"
        >
          {error}
        </div>
      )}

      {notice && (
        <p
          className="settings-description"
          role="status"
          aria-live="polite"
        >
          {notice}
        </p>
      )}

      <button
        className="save-button"
        type="button"
        onClick={handleSave}
        disabled={!canSave}
      >
        {saving && (
          <div
            className="loading-spinner"
            aria-hidden="true"
          />
        )}

        {saving
          ? "Saving Configuration..."
          : "Save Strategy Configuration"}
      </button>
    </div>
  );
}
