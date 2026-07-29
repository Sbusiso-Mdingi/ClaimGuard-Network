import React, { useCallback, useEffect, useState } from "react";

import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { apiJson, safeApiErrorMessage } from "../../lib/apiClient";
import {
  DefinitionList,
  EmptyState,
  FormField,
  StatusIndicator,
  WorkspaceNotice,
  formatEnumLabel,
} from "./InvestigatorUI";

const DEFAULT_REGISTRATION = Object.freeze({
  deploymentId: "",
  modelId: "",
  modelVersion: "",
  displayName: "",
  ownerType: "claimguard",
  ownerOrganisationId: "",
  decisionThreshold: "",
  artifactSha256: "",
  containerImageDigest: "",
  networkEnrichment: false,
});

function modelTone(model) {
  if (model.fleetManaged) return "success";
  if (model.lifecycleStatus === "rejected") return "danger";
  if (model.lifecycleStatus === "retired") return "warning";
  return model.runtimeApproved ? "info" : "neutral";
}

function digestPreview(value) {
  const rendered = String(value || "");
  if (!rendered) return "Not recorded";
  if (rendered.length <= 30) return rendered;
  return `${rendered.slice(0, 16)}…${rendered.slice(-12)}`;
}

export function GlobalDetectionEngineSettings({ organisations = [] }) {
  const [strategy, setStrategy] = useState(null);
  const [models, setModels] = useState([]);
  const [registration, setRegistration] = useState(DEFAULT_REGISTRATION);
  const [loading, setLoading] = useState(true);
  const [registering, setRegistering] = useState(false);
  const [activatingId, setActivatingId] = useState("");
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [lastUpdatedAt, setLastUpdatedAt] = useState(null);

  const loadConfiguration = useCallback(({ clearMessage = false } = {}) => {
    setLoading(true);
    setError("");
    if (clearMessage) setMessage("");
    return Promise.all([
      apiJson("/admin/platform/global-detection-engine"),
      apiJson("/admin/platform/model-deployments"),
    ])
      .then(([strategyPayload, cataloguePayload]) => {
        setStrategy(strategyPayload.strategy || null);
        setModels(
          Array.isArray(cataloguePayload.models)
            ? cataloguePayload.models
            : [],
        );
        setLastUpdatedAt(new Date());
      })
      .catch((requestError) => setError(
        safeApiErrorMessage(
          requestError,
          "Failed to load the governed model catalogue.",
        ),
      ))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    loadConfiguration();
  }, [loadConfiguration]);

  function updateRegistration(field, value) {
    setRegistration((previous) => ({
      ...previous,
      [field]: value,
      ...(field === "ownerType" && value === "claimguard"
        ? { ownerOrganisationId: "" }
        : {}),
    }));
    setError("");
    setMessage("");
  }

  async function registerCandidate(event) {
    event.preventDefault();
    setRegistering(true);
    setError("");
    setMessage("");
    try {
      await apiJson("/admin/platform/model-deployments", {
        method: "POST",
        body: JSON.stringify({
          deploymentId: registration.deploymentId.trim(),
          modelId: registration.modelId.trim(),
          modelVersion: registration.modelVersion.trim(),
          displayName: registration.displayName.trim(),
          ownerType: registration.ownerType,
          ownerOrganisationId: registration.ownerType === "scheme"
            ? registration.ownerOrganisationId
            : null,
          requestSchemaVersion: "claimguard.claim-screening-request.v3",
          responseSchemaVersion: "claimguard.claim-screening-response.v3",
          featureSchemaVersion: "claim-feature-schema-2026.2",
          analysisMode: "PROSPECTIVE_CLAIM_SCREENING",
          decisionThreshold: Number(registration.decisionThreshold),
          artifactSha256: registration.artifactSha256.trim(),
          containerImageDigest: registration.containerImageDigest.trim(),
          capabilities: {
            prospectiveClaimScreening: true,
            networkEnrichment: registration.networkEnrichment,
          },
          automaticAdverseAction: false,
        }),
      });
      setRegistration(DEFAULT_REGISTRATION);
      setMessage("Candidate registered. It remains inactive until validation and deployment approval are complete.");
      await loadConfiguration();
    } catch (requestError) {
      setError(
        safeApiErrorMessage(
          requestError,
          "Failed to register the model candidate.",
        ),
      );
    } finally {
      setRegistering(false);
    }
  }

  async function activateStagedRelease(model) {
    const confirmed = window.confirm(
      `Activate ${model.deploymentId} in the governed catalogue? `
      + "This retires the prior ClaimGuard-managed catalogue entry. "
      + "Runtime selection remains a separate deployment-controlled step.",
    );
    if (!confirmed) return;
    setActivatingId(model.deploymentId);
    setError("");
    setMessage("");
    try {
      const result = await apiJson(
        `/admin/platform/model-deployments/${encodeURIComponent(model.deploymentId)}/activate`,
        {
          method: "POST",
          body: JSON.stringify({
            confirmation: `ACTIVATE ${model.deploymentId}`,
          }),
        },
      );
      setMessage(
        result.runtimeActivationPending === false
          ? `Activation ${result.auditEventId} is active in the governed catalogue and runtime selection.`
          : `Catalogue activation recorded as ${result.auditEventId}. `
            + "Runtime traffic remains unchanged until guarded finalization succeeds.",
      );
      await loadConfiguration();
    } catch (requestError) {
      setError(
        safeApiErrorMessage(
          requestError,
          "Failed to activate the staged model release.",
        ),
      );
    } finally {
      setActivatingId("");
    }
  }

  if (loading && !strategy && models.length === 0) {
    return (
      <WorkspaceNotice title="Loading managed model configuration">
        ClaimGuard is reading the deployment-authoritative setting and model catalogue.
      </WorkspaceNotice>
    );
  }

  return (
    <div className="grid gap-5">
      {error ? <WorkspaceNotice title="Model governance unavailable" tone="danger">{error}</WorkspaceNotice> : null}
      {message ? <WorkspaceNotice title="Model governance updated" tone="success">{message}</WorkspaceNotice> : null}

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
            title="Promotion remains deployment-controlled"
            actions={(
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={loading}
                onClick={() => loadConfiguration({ clearMessage: true })}
              >
                {loading ? "Refreshing…" : "Refresh"}
              </Button>
            )}
          >
            Registration records an immutable candidate; it does not activate it. Promotion occurs only after contract validation, worker configuration, canary evidence, and an audited release. Existing claims and historical jobs are never rewritten.
            {lastUpdatedAt ? (
              <span className="mt-2 block text-xs text-muted-foreground">
                Last checked {lastUpdatedAt.toLocaleTimeString()}.
              </span>
            ) : null}
          </WorkspaceNotice>
        </>
      ) : null}

      <div className="grid gap-3">
        <div>
          <h4 className="font-semibold">Registered model deployments</h4>
          <p className="mt-1 text-sm text-muted-foreground">
            Runtime approval and lifecycle status are deliberately separate.
          </p>
        </div>
        {models.length === 0 ? (
          <EmptyState
            title="No model deployments registered"
            description="Register a checksum-pinned candidate before beginning validation."
            compact
          />
        ) : (
          <div className="grid gap-3 lg:grid-cols-2">
            {models.map((model) => (
              <article
                key={model.deploymentId}
                className="rounded-xl border border-border/70 bg-card/50 p-4"
              >
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="font-semibold">{model.displayName}</p>
                    <code className="mt-1 block break-all text-xs text-muted-foreground">
                      {model.deploymentId}
                    </code>
                  </div>
                  <StatusIndicator variant="badge" tone={modelTone(model)}>
                    {model.fleetManaged
                      ? "Fleet managed"
                      : formatEnumLabel(model.lifecycleStatus)}
                  </StatusIndicator>
                </div>
                <DefinitionList
                  columns={2}
                  items={[
                    {
                      label: "Owner",
                      value: model.ownerType === "scheme"
                        ? model.ownerOrganisationId
                        : "ClaimGuard",
                      mono: model.ownerType === "scheme",
                    },
                    {
                      label: "Runtime",
                      value: model.runtimeApproved ? "Approved" : "Not approved",
                    },
                    {
                      label: "Feature contract",
                      value: model.featureSchemaVersion,
                      mono: true,
                    },
                    {
                      label: "Threshold",
                      value: String(model.decisionThreshold),
                    },
                    {
                      label: "Artifact",
                      value: digestPreview(model.artifactSha256),
                      mono: true,
                    },
                    {
                      label: "Container",
                      value: digestPreview(model.containerImageDigest),
                      mono: true,
                    },
                  ]}
                />
                {model.ownerType === "claimguard"
                  && model.lifecycleStatus === "candidate"
                  && model.artifactSha256
                  && model.containerImageDigest ? (
                    <div className="mt-4 border-t border-border/70 pt-4">
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        disabled={Boolean(activatingId)}
                        onClick={() => activateStagedRelease(model)}
                      >
                        {activatingId === model.deploymentId
                          ? "Recording activation…"
                          : "Activate staged release"}
                      </Button>
                      <p className="mt-2 text-xs text-muted-foreground">
                        Available only when the deployed release evidence exactly
                        matches this candidate. Runtime traffic changes separately.
                      </p>
                    </div>
                  ) : null}
              </article>
            ))}
          </div>
        )}
      </div>

      <details className="rounded-xl border border-border/70 bg-muted/20 p-4">
        <summary className="cursor-pointer font-semibold">
          Register an immutable model candidate
        </summary>
        <form className="mt-5 grid gap-4" onSubmit={registerCandidate}>
          <div className="grid gap-4 md:grid-cols-2">
            <FormField label="Display name">
              <Input
                value={registration.displayName}
                onChange={(event) => updateRegistration("displayName", event.target.value)}
                required
              />
            </FormField>
            <FormField label="Deployment ID">
              <Input
                value={registration.deploymentId}
                onChange={(event) => updateRegistration("deploymentId", event.target.value)}
                placeholder="model-name:version"
                pattern="[A-Za-z0-9][A-Za-z0-9._:-]{0,127}"
                required
              />
            </FormField>
            <FormField label="Model ID">
              <Input
                value={registration.modelId}
                onChange={(event) => updateRegistration("modelId", event.target.value)}
                required
              />
            </FormField>
            <FormField label="Model version">
              <Input
                value={registration.modelVersion}
                onChange={(event) => updateRegistration("modelVersion", event.target.value)}
                required
              />
            </FormField>
            <FormField label="Owner">
              <select
                className="h-9 rounded-md border border-input bg-background px-3 text-sm"
                value={registration.ownerType}
                onChange={(event) => updateRegistration("ownerType", event.target.value)}
              >
                <option value="claimguard">ClaimGuard</option>
                <option value="scheme">Medical scheme</option>
              </select>
            </FormField>
            {registration.ownerType === "scheme" ? (
              <FormField label="Owning medical scheme">
                <select
                  className="h-9 rounded-md border border-input bg-background px-3 text-sm"
                  value={registration.ownerOrganisationId}
                  onChange={(event) => updateRegistration("ownerOrganisationId", event.target.value)}
                  required
                >
                  <option value="">Choose a medical scheme</option>
                  {organisations.map((organisation) => (
                    <option
                      key={organisation.organisationId}
                      value={organisation.organisationId}
                    >
                      {organisation.displayName}
                    </option>
                  ))}
                </select>
              </FormField>
            ) : null}
            <FormField label="Decision threshold">
              <Input
                type="number"
                min="0"
                max="1"
                step="any"
                value={registration.decisionThreshold}
                onChange={(event) => updateRegistration("decisionThreshold", event.target.value)}
                required
              />
            </FormField>
            <FormField label="Artifact SHA-256">
              <Input
                value={registration.artifactSha256}
                onChange={(event) => updateRegistration("artifactSha256", event.target.value)}
                pattern="[a-fA-F0-9]{64}"
                required
              />
            </FormField>
            <FormField label="Immutable container digest">
              <Input
                value={registration.containerImageDigest}
                onChange={(event) => updateRegistration("containerImageDigest", event.target.value)}
                placeholder="registry/repository@sha256:…"
                required
              />
            </FormField>
          </div>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={registration.networkEnrichment}
              onChange={(event) => updateRegistration("networkEnrichment", event.target.checked)}
            />
            Candidate also exposes delayed network-enrichment capability
          </label>
          <div className="flex flex-wrap items-center gap-3">
            <Button type="submit" disabled={registering}>
              {registering ? "Registering..." : "Register candidate"}
            </Button>
            <p className="text-xs text-muted-foreground">
              Registration never approves runtime access or changes a scheme policy.
            </p>
          </div>
        </form>
      </details>
    </div>
  );
}
