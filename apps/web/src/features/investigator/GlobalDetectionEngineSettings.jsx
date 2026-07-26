import React, { useCallback, useEffect, useState } from "react";
import { Button } from "../../components/ui/button";
import { ApiError, apiJson } from "../../lib/apiClient";
import {
  DefinitionList,
  StatusIndicator,
  WorkspaceNotice,
} from "./InvestigatorUI";

export function GlobalDetectionEngineSettings() {
  const [strategy, setStrategy] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const loadStrategy = useCallback(() => {
    setLoading(true);
    setError("");
    return apiJson("/admin/platform/global-detection-engine")
      .then((payload) => setStrategy(payload.strategy || null))
      .catch((requestError) => setError(requestError instanceof ApiError ? requestError.message : "Failed to load global detection configuration."))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    loadStrategy();
  }, [loadStrategy]);

  if (loading) {
    return <WorkspaceNotice title="Loading managed model configuration">ClaimGuard is reading the deployment-authoritative setting.</WorkspaceNotice>;
  }

  return (
    <div className="grid gap-4">
      {error ? <WorkspaceNotice title="Global configuration unavailable" tone="danger">{error}</WorkspaceNotice> : null}
      {strategy ? (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <StatusIndicator
              variant="badge"
              tone={strategy.approved ? "success" : "warning"}
            >
              {strategy.approved ? "Approved deployment" : "Configuration attention required"}
            </StatusIndicator>
            <StatusIndicator variant="badge" tone="info">Deployment controlled</StatusIndicator>
          </div>
          <DefinitionList
            columns={3}
            items={[
              {
                label: "Fleet-managed deployment",
                value: strategy.modelDeploymentId || "Not configured",
                mono: true,
              },
              {
                label: "Configuration source",
                value: "Validated API deployment",
              },
              {
                label: "Scheme activation",
                value: "Audited prospective transition",
              },
            ]}
          />
          <WorkspaceNotice
            title="Promotion is intentionally deployment-controlled"
            actions={<Button type="button" variant="outline" size="sm" onClick={loadStrategy}>Refresh</Button>}
          >
            A platform deployment promotes the fleet-managed model. Each managed scheme then adopts it through its audited model-policy operation. Existing claims and historical outbox jobs are never rewritten.
          </WorkspaceNotice>
        </>
      ) : null}
    </div>
  );
}
