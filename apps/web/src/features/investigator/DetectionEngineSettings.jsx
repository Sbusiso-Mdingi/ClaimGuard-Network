import React, { useState, useEffect } from "react";
import "./DetectionEngineSettings.css";

export function DetectionEngineSettings({ tenantId }) {
  const [strategyType, setStrategyType] = useState("deterministic_rules");
  const [modelDeploymentId, setModelDeploymentId] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    async function fetchStrategy() {
      try {
        const response = await fetch("/api/detection/strategy");
        if (!response.ok) throw new Error("Failed to load strategy");
        const data = await response.json();
        if (data.strategy) {
          setStrategyType(data.strategy.strategyType);
          setModelDeploymentId(data.strategy.modelDeploymentId || "");
        }
      } catch (err) {
        setError(err.message);
      } finally {
        setLoading(false);
      }
    }
    fetchStrategy();
  }, [tenantId]);

  async function handleSave() {
    setSaving(true);
    setError(null);
    try {
      const response = await fetch("/api/detection/strategy", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          strategyType,
          modelDeploymentId: modelDeploymentId || null,
        }),
      });
      if (!response.ok) {
        const errData = await response.json().catch(() => ({}));
        throw new Error(errData.message || "Failed to save strategy");
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return <div className="detection-settings-container"><div className="loading-spinner" /></div>;
  }

  return (
    <div className="detection-settings-container">
      <div className="settings-header">
        <h3 className="settings-title">
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 2v20M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6" />
          </svg>
          Slot the Brains of ClaimGuard
        </h3>
        <p className="settings-description">
          Choose the core engine used for evaluating fraud detection strategies and risk models.
        </p>
      </div>

      <div className="strategy-toggle-group">
        <div 
          className={`strategy-card ${strategyType === "deterministic_rules" ? "active" : ""}`}
          onClick={() => setStrategyType("deterministic_rules")}
        >
          <div className="strategy-icon">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <rect x="3" y="3" width="18" height="18" rx="2" />
              <path d="M9 3v18M15 3v18M3 9h18M3 15h18" />
            </svg>
          </div>
          <div className="strategy-content">
            <h4 className="strategy-name">ClaimGuard's Detection Engine</h4>
            <p className="strategy-desc">ClaimGuard's built-in rules, heuristics, and graph analytics.</p>
          </div>
          <div className="strategy-status" />
        </div>

        <div 
          className={`strategy-card ml-endpoint ${strategyType === "approved_model" ? "active ml-endpoint" : ""}`}
          onClick={() => setStrategyType("approved_model")}
        >
          <div className="strategy-icon">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zM12 11c1.66 0 3-1.34 3-3s-1.34-3-3-3-3 1.34-3 3 1.34 3 3 3zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z" />
              <path d="M16 8l4 4-4 4" />
              <path d="M8 16l-4-4 4-4" />
            </svg>
          </div>
          <div className="strategy-content">
            <h4 className="strategy-name">Approved ClaimGuard Model</h4>
            <p className="strategy-desc">Use a versioned model deployment approved by the ClaimGuard environment.</p>
          </div>
          <div className="strategy-status" />
        </div>
      </div>

      {strategyType === "approved_model" && (
        <div className="url-input-container">
          <label className="url-input-label" htmlFor="model-deployment-id">
            Approved Model Deployment ID
          </label>
          <input
            id="model-deployment-id"
            className="url-input"
            type="text"
            placeholder="claimguard-claim-fraud-ensemble-1.1.0"
            value={modelDeploymentId}
            onChange={(e) => setModelDeploymentId(e.target.value)}
          />
        </div>
      )}

      {error && <div className="error-message">{error}</div>}

      <button 
        className="save-button" 
        onClick={handleSave} 
        disabled={saving || (strategyType === "approved_model" && !modelDeploymentId)}
      >
        {saving && <div className="loading-spinner" />}
        {saving ? "Saving Configuration..." : "Save Strategy Configuration"}
      </button>
    </div>
  );
}
