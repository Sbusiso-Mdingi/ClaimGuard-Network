import React, { useEffect, useState } from "react";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { ApiError, apiJson } from "../../lib/apiClient";
import { FormField, WorkspaceNotice } from "./InvestigatorUI";

export function GlobalDetectionEngineSettings() {
  const [modelDeploymentId, setModelDeploymentId] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");

  useEffect(() => {
    apiJson("/admin/platform/global-detection-engine")
      .then((payload) => setModelDeploymentId(payload.strategy?.modelDeploymentId || ""))
      .catch((requestError) => setError(requestError instanceof ApiError ? requestError.message : "Failed to load global detection configuration."))
      .finally(() => setLoading(false));
  }, []);

  async function handleSave(event) {
    event.preventDefault();
    setSaving(true);
    setError("");
    setMessage("");
    try {
      await apiJson("/admin/platform/global-detection-engine", {
        method: "PUT",
        body: JSON.stringify({ modelDeploymentId: modelDeploymentId || null }),
      });
      setMessage("Global detection engine configuration updated successfully.");
    } catch (requestError) {
      setError(requestError instanceof ApiError ? requestError.message : "Failed to update global detection configuration.");
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return <WorkspaceNotice title="Loading global engine configuration">ClaimGuard is reading the active platform default.</WorkspaceNotice>;
  }

  return (
    <form onSubmit={handleSave} className="grid gap-4">
      {error ? <WorkspaceNotice title="Global configuration unavailable" tone="danger">{error}</WorkspaceNotice> : null}
      {message ? <WorkspaceNotice title={message} tone="success" /> : null}
      <FormField label="Approved model deployment ID" hint="Use an approved deployment identifier; model endpoints and secrets are never accepted here.">
        <Input required placeholder="claimguard-claim-fraud-ensemble-1.1.0" value={modelDeploymentId} onChange={(event) => setModelDeploymentId(event.target.value)} />
      </FormField>
      <Button type="submit" className="w-fit" disabled={saving || !modelDeploymentId}>{saving ? "Saving..." : "Save configuration"}</Button>
    </form>
  );
}
