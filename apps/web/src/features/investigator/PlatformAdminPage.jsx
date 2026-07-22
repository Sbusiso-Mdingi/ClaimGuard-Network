import React, { useEffect, useMemo, useState } from "react";
import { PageFrame, SectionCard, StatusIndicator } from "./InvestigatorUI";
import { apiJson, ApiError } from "../../lib/apiClient";

function WizardField({ label, children }) {
  return (
    <label className="grid gap-2">
      <span className="text-xs uppercase tracking-[0.16em] text-muted-foreground">{label}</span>
      {children}
    </label>
  );
}

function ReadOnlyRow({ label, value }) {
  return (
    <div className="rounded-xl border border-border/70 px-4 py-3">
      <p className="text-xs uppercase tracking-[0.16em] text-muted-foreground">{label}</p>
      <p className="mt-1 text-sm font-semibold text-foreground">{value || "-"}</p>
    </div>
  );
}

export function GlobalDetectionEngineSettings() {
  const [endpointUrl, setEndpointUrl] = useState("");
  const [customModelSecret, setCustomModelSecret] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [message, setMessage] = useState("");

  useEffect(() => {
    async function fetchConfig() {
      try {
        const payload = await apiJson("/admin/platform/global-detection-engine");
        if (payload.strategy) {
          setEndpointUrl(payload.strategy.endpointUrl || "");
          setCustomModelSecret(payload.strategy.customModelImageSecret || "");
        }
      } catch (err) {
        setError(err instanceof ApiError ? err.message : "Failed to load global detection config");
      } finally {
        setLoading(false);
      }
    }
    fetchConfig();
  }, []);

  async function handleSave(event) {
    event.preventDefault();
    setSaving(true);
    setError(null);
    setMessage("");
    try {
      await apiJson("/admin/platform/global-detection-engine", {
        method: "PUT",
        body: JSON.stringify({
          endpointUrl: endpointUrl || null,
          customModelImageSecret: customModelSecret || null,
        }),
      });
      setMessage("Global detection engine configuration updated successfully.");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to update global detection config");
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return <div className="p-4 text-sm text-muted-foreground">Loading configuration...</div>;
  }

  return (
    <form onSubmit={handleSave} className="space-y-4">
      {error && <div className="rounded border border-red-200 bg-red-50 p-3 text-sm text-red-600">{error}</div>}
      {message && <div className="rounded border border-green-200 bg-green-50 p-3 text-sm text-green-700">{message}</div>}
      <WizardField label="Custom Model Endpoint URL">
        <input
          type="url"
          required
          className="rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
          placeholder="https://your-custom-engine.com/evaluate"
          value={endpointUrl}
          onChange={(e) => setEndpointUrl(e.target.value)}
        />
      </WizardField>
      <WizardField label="Key Vault Secret Name">
        <input
          type="text"
          className="rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
          placeholder="my-custom-model-secret"
          value={customModelSecret}
          onChange={(e) => setCustomModelSecret(e.target.value)}
        />
      </WizardField>
      <button type="submit" disabled={saving || !endpointUrl} className="rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground">
        {saving ? "Saving..." : "Save Configuration"}
      </button>
    </form>
  );
}

export function PlatformAdminPage() {
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [organisation, setOrganisation] = useState(null);
  const [organisations, setOrganisations] = useState([]);
  const [operation, setOperation] = useState(null);
  const [integration, setIntegration] = useState(null);
  const [oneTimeToken, setOneTimeToken] = useState("");
  const [integrationForm, setIntegrationForm] = useState({ displayName: "Claims server", serviceActorId: "", expiresInDays: "90" });
  const [health, setHealth] = useState(null);
  const [form, setForm] = useState({
    displayName: "",
    canonicalSlug: "",
    deploymentClass: "demo",
    adminDisplayName: "",
    adminEmail: "",
  });

  const review = useMemo(() => {
    if (!organisation) return null;
    return {
      region: organisation?.provisioningReview?.region,
      server: organisation?.provisioningReview?.flexibleServerName,
      db: organisation?.provisioningReview?.generatedLogicalDatabaseName,
      reportPartition: organisation?.provisioningReview?.reportPartitionStrategy,
      schemaVersion: organisation?.provisioningReview?.schemaVersion,
    };
  }, [organisation]);

  async function refreshOrganisations() {
    const payload = await apiJson("/admin/platform/organisations", { cache: "no-store" });
    const items = payload.organisations || [];
    setOrganisations(items);
    return items;
  }

  async function loadOrganisation(organisationId) {
    setLoading(true);
    setError("");
    setOneTimeToken("");
    try {
      const payload = await apiJson(`/admin/platform/organisations/${encodeURIComponent(organisationId)}`, { cache: "no-store" });
      setOrganisation({ organisation: payload.organisation, provisioningReview: null });
      const latest = payload.operations?.[0] || null;
      if (latest?.operationId) await refreshOperation(latest.operationId);
      else setOperation(null);
      if (payload.organisation?.status === "active") {
        const integrationPayload = await apiJson(`/admin/platform/organisations/${encodeURIComponent(organisationId)}/integration`, { cache: "no-store" });
        setIntegration(integrationPayload);
      } else {
        setIntegration(null);
      }
      setIntegrationForm((previous) => ({
        ...previous,
        serviceActorId: `${payload.organisation.canonicalSlug}-claims-server`,
      }));
    } catch (requestError) {
      setError(requestError instanceof ApiError ? requestError.message : "Medical aid could not be loaded.");
    } finally {
      setLoading(false);
    }
  }

  async function refreshOperation(operationId) {
    if (!operationId) return;
    const payload = await apiJson(`/admin/platform/provisioning/${encodeURIComponent(operationId)}`, { cache: "no-store" });
    setOperation(payload.operation || null);
  }

  async function handleCreateDraft(event) {
    event.preventDefault();
    setLoading(true);
    setError("");
    setMessage("");
    try {
      const payload = await apiJson("/admin/platform/organisations", {
        method: "POST",
        body: JSON.stringify({
          displayName: form.displayName,
          canonicalSlug: form.canonicalSlug,
          deploymentClass: form.deploymentClass,
          organisationType: "medical_scheme",
          initialAdministrator: {
            displayName: form.adminDisplayName,
            email: form.adminEmail,
          },
        }),
      });
      setOrganisation(payload);
      await refreshOrganisations();
      setMessage("Draft organisation created. No infrastructure has been provisioned yet.");
    } catch (requestError) {
      const summary = requestError instanceof ApiError ? `${requestError.message} (${requestError.code || requestError.status})` : "Draft creation failed.";
      setError(summary);
    } finally {
      setLoading(false);
    }
  }

  async function handleProvision() {
    if (!organisation?.organisation?.organisationId) return;
    setLoading(true);
    setError("");
    setMessage("");
    try {
      const payload = await apiJson(`/admin/platform/organisations/${encodeURIComponent(organisation.organisation.organisationId)}/provision`, {
        method: "POST",
      });
      setOperation(payload.operation || null);
      setMessage("Provisioning requested asynchronously. Polling status...");
    } catch (requestError) {
      const summary = requestError instanceof ApiError ? `${requestError.message} (${requestError.code || requestError.status})` : "Provisioning request failed.";
      setError(summary);
    } finally {
      setLoading(false);
    }
  }

  async function handleRetry() {
    if (!operation?.operationId) return;
    setLoading(true);
    setError("");
    try {
      await apiJson(`/admin/platform/provisioning/${encodeURIComponent(operation.operationId)}/retry`, { method: "POST" });
      await refreshOperation(operation.operationId);
      setMessage("Retry requested.");
    } catch (requestError) {
      setError(requestError instanceof ApiError ? requestError.message : "Retry failed.");
    } finally {
      setLoading(false);
    }
  }

  async function handleActivate() {
    if (!organisation?.organisation?.organisationId) return;
    setLoading(true);
    setError("");
    try {
      const payload = await apiJson(`/admin/platform/organisations/${encodeURIComponent(organisation.organisation.organisationId)}/activate`, { method: "POST" });
      setMessage(payload.message || "Activation request submitted.");
      await refreshOrganisations();
      await loadOrganisation(organisation.organisation.organisationId);
    } catch (requestError) {
      setError(requestError instanceof ApiError ? requestError.message : "Activation request failed.");
    } finally {
      setLoading(false);
    }
  }

  async function handleUpgrade() {
    const organisationId = organisation?.organisation?.organisationId;
    if (!organisationId) return;
    setLoading(true);
    setError("");
    try {
      const payload = await apiJson(`/admin/platform/organisations/${encodeURIComponent(organisationId)}/upgrade`, { method: "POST" });
      setOperation(payload.operation || null);
      setMessage("Schema upgrade queued. ClaimGuard will keep the current route until verification succeeds.");
    } catch (requestError) {
      setError(requestError instanceof ApiError ? requestError.message : "Upgrade request failed.");
    } finally {
      setLoading(false);
    }
  }

  async function handleCreateIntegrationCredential() {
    const organisationId = organisation?.organisation?.organisationId;
    if (!organisationId) return;
    setLoading(true);
    setError("");
    setOneTimeToken("");
    try {
      const payload = await apiJson(`/admin/platform/organisations/${encodeURIComponent(organisationId)}/integration-credentials`, {
        method: "POST",
        body: JSON.stringify(integrationForm),
      });
      setOneTimeToken(payload.bearerToken || "");
      setIntegration((previous) => ({
        ...(previous || {}),
        guide: payload.guide,
        credentials: [payload.credential, ...(previous?.credentials || [])],
      }));
      setMessage("Claims-server credential created. Copy the token now; ClaimGuard will not show it again.");
    } catch (requestError) {
      setError(requestError instanceof ApiError ? requestError.message : "Credential creation failed.");
    } finally {
      setLoading(false);
    }
  }

  async function handleRevokeCredential(credentialId) {
    const organisationId = organisation?.organisation?.organisationId;
    if (!organisationId) return;
    setLoading(true);
    setError("");
    try {
      await apiJson(`/admin/platform/organisations/${encodeURIComponent(organisationId)}/integration-credentials/${encodeURIComponent(credentialId)}/revoke`, { method: "POST" });
      await loadOrganisation(organisationId);
      setMessage("Claims-server credential revoked.");
    } catch (requestError) {
      setError(requestError instanceof ApiError ? requestError.message : "Credential revocation failed.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    const timer = window.setInterval(() => {
      if (operation?.operationId) {
        refreshOperation(operation.operationId).catch(() => undefined);
      }
    }, 4000);
    return () => window.clearInterval(timer);
  }, [operation?.operationId]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [healthResponse, readyResponse] = await Promise.all([
          apiJson("/health", { cache: "no-store" }),
          apiJson("/ready", { cache: "no-store" }),
        ]);
        if (!cancelled) {
          setHealth({ health: healthResponse, ready: readyResponse });
        }
      } catch {
        if (!cancelled) setHealth({ health: { status: "unreachable" }, ready: { status: "unreachable", ready: false } });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    refreshOrganisations().catch(() => setError("Medical-aid inventory could not be loaded."));
  }, []);

  const canProvision = Boolean(organisation?.organisation?.organisationId);
  const canRetry = Boolean(operation?.operationId && ["failed", "quarantined", "compensated"].includes(operation.status));
  const canActivate = Boolean(organisation?.organisation?.status === "ready_for_activation");
  const canUpgrade = Boolean(["active", "suspended", "ready_for_activation"].includes(organisation?.organisation?.status));
  const isActive = organisation?.organisation?.status === "active";

  return (
    <PageFrame
      eyebrow="Platform Administration"
      title="Medical scheme onboarding"
      description="Platform administrators create DRAFT organisations and request asynchronous provisioning. Browser clients never call Azure Resource Manager directly."
    >
      <SectionCard title="Medical aids" description="Select an existing medical aid or create a new one. ClaimGuard remains a separate platform organisation and is never given a claims database.">
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {organisations.map((item) => (
            <button
              key={item.organisationId}
              type="button"
              className="rounded-xl border border-border px-4 py-3 text-left hover:bg-muted/40 disabled:opacity-50"
              disabled={loading}
              onClick={() => loadOrganisation(item.organisationId)}
            >
              <p className="font-semibold">{item.displayName}</p>
              <p className="text-sm text-muted-foreground">{item.canonicalSlug}</p>
              <p className="mt-2 text-xs uppercase tracking-[0.14em]">{item.status}</p>
            </button>
          ))}
          {organisations.length === 0 ? <p className="text-sm text-muted-foreground">No medical aids have been registered yet.</p> : null}
        </div>
      </SectionCard>

      <SectionCard title="Step 1-3: Organisation and Initial Admin" description="Create a DRAFT organisation without provisioning infrastructure.">
        <form className="grid gap-4" onSubmit={handleCreateDraft}>
          <div className="grid gap-4 md:grid-cols-2">
            <WizardField label="Organisation Name">
              <input className="rounded-xl border border-border bg-background px-3 py-2" value={form.displayName} onChange={(event) => setForm((prev) => ({ ...prev, displayName: event.target.value }))} required />
            </WizardField>
            <WizardField label="Canonical Slug">
              <input className="rounded-xl border border-border bg-background px-3 py-2" value={form.canonicalSlug} onChange={(event) => setForm((prev) => ({ ...prev, canonicalSlug: event.target.value }))} required />
            </WizardField>
            <WizardField label="Deployment Class">
              <select className="rounded-xl border border-border bg-background px-3 py-2" value={form.deploymentClass} onChange={(event) => setForm((prev) => ({ ...prev, deploymentClass: event.target.value }))}>
                <option value="demo">demo</option>
                <option value="pilot">pilot</option>
              </select>
            </WizardField>
            <WizardField label="Initial Admin Display Name">
              <input className="rounded-xl border border-border bg-background px-3 py-2" value={form.adminDisplayName} onChange={(event) => setForm((prev) => ({ ...prev, adminDisplayName: event.target.value }))} required />
            </WizardField>
            <WizardField label="Initial Admin Username/Email">
              <input className="rounded-xl border border-border bg-background px-3 py-2" value={form.adminEmail} onChange={(event) => setForm((prev) => ({ ...prev, adminEmail: event.target.value }))} required />
            </WizardField>
          </div>
          <div className="flex flex-wrap gap-2">
            <button type="submit" className="rounded-xl bg-primary px-4 py-2 text-primary-foreground disabled:opacity-50" disabled={loading}>Create Draft</button>
            <button type="button" className="rounded-xl border border-border px-4 py-2 disabled:opacity-50" disabled={!canProvision || loading} onClick={handleProvision}>Request Provisioning</button>
            <button type="button" className="rounded-xl border border-border px-4 py-2 disabled:opacity-50" disabled={!canRetry || loading} onClick={handleRetry}>Retry Failed Operation</button>
            <button type="button" className="rounded-xl border border-border px-4 py-2 disabled:opacity-50" disabled={!canUpgrade || loading} onClick={handleUpgrade}>Upgrade Data Plane</button>
            <button type="button" className="rounded-xl border border-border px-4 py-2 disabled:opacity-50" disabled={!canActivate || loading} onClick={handleActivate}>Activate (Explicit)</button>
          </div>
          {message ? <p className="text-sm text-emerald-600">{message}</p> : null}
          {error ? <p className="text-sm text-red-600">{error}</p> : null}
        </form>
      </SectionCard>

      <SectionCard title="Connect the medical aid's claims server" description="Create a separate, revocable credential for each sending server. Tokens are shown once and stored by ClaimGuard only as hashes.">
        {!isActive ? <p className="text-sm text-muted-foreground">Activate the medical aid before issuing a claims-server credential.</p> : (
          <div className="grid gap-5">
            <div className="grid gap-4 md:grid-cols-3">
              <WizardField label="Connection name">
                <input className="rounded-xl border border-border bg-background px-3 py-2" value={integrationForm.displayName} onChange={(event) => setIntegrationForm((previous) => ({ ...previous, displayName: event.target.value }))} />
              </WizardField>
              <WizardField label="Stable server ID">
                <input className="rounded-xl border border-border bg-background px-3 py-2" value={integrationForm.serviceActorId} onChange={(event) => setIntegrationForm((previous) => ({ ...previous, serviceActorId: event.target.value.toLowerCase() }))} />
              </WizardField>
              <WizardField label="Expires in days">
                <input type="number" min="1" max="365" className="rounded-xl border border-border bg-background px-3 py-2" value={integrationForm.expiresInDays} onChange={(event) => setIntegrationForm((previous) => ({ ...previous, expiresInDays: event.target.value }))} />
              </WizardField>
            </div>
            <button type="button" className="w-fit rounded-xl bg-primary px-4 py-2 text-primary-foreground disabled:opacity-50" disabled={loading || !integrationForm.serviceActorId} onClick={handleCreateIntegrationCredential}>Create Claims-Server Credential</button>
            {oneTimeToken ? (
              <div className="rounded-xl border border-amber-500/50 bg-amber-500/10 p-4">
                <p className="font-semibold">Copy this token now — it will not be shown again</p>
                <code className="mt-2 block break-all rounded-lg bg-background p-3 text-sm">{oneTimeToken}</code>
              </div>
            ) : null}
            <div className="grid gap-3 md:grid-cols-2">
              <ReadOnlyRow label="Claims endpoint" value={integration?.guide?.endpoint} />
              <ReadOnlyRow label="Successful response" value={integration?.guide?.successStatus ? `HTTP ${integration.guide.successStatus}` : null} />
            </div>
            <ol className="list-decimal space-y-2 pl-5 text-sm text-muted-foreground">
              {(integration?.guide?.steps || []).map((step) => <li key={step}>{step}</li>)}
            </ol>
            <div className="space-y-2">
              {(integration?.credentials || []).map((credential) => (
                <div key={credential.integrationCredentialId} className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border/70 px-4 py-3 text-sm">
                  <div>
                    <p className="font-semibold">{credential.displayName}</p>
                    <p className="text-muted-foreground">{credential.serviceActorId} · {credential.tokenPrefix}… · {credential.status}</p>
                  </div>
                  {credential.status === "active" ? <button type="button" className="rounded-lg border border-border px-3 py-1.5" disabled={loading} onClick={() => handleRevokeCredential(credential.integrationCredentialId)}>Revoke</button> : null}
                </div>
              ))}
            </div>
          </div>
        )}
      </SectionCard>

      <SectionCard title="Step 4: Provisioning Review" description="Server-derived, trusted deployment choices only.">
        <div className="grid gap-3 md:grid-cols-2">
          <ReadOnlyRow label="Approved Azure Region" value={review?.region} />
          <ReadOnlyRow label="Approved Flexible Server" value={review?.server} />
          <ReadOnlyRow label="Generated Logical Database Name" value={review?.db} />
          <ReadOnlyRow label="Report Partition Strategy" value={review?.reportPartition} />
          <ReadOnlyRow label="Intended Schema Version" value={review?.schemaVersion} />
          <ReadOnlyRow label="Organisation Status" value={organisation?.organisation?.status} />
        </div>
      </SectionCard>

      <SectionCard title="Step 5-6: Provisioning Progress and Activation" description="Asynchronous operation tracking with safe summaries.">
        <div className="grid gap-3 md:grid-cols-2">
          <ReadOnlyRow label="Provisioning Operation ID" value={operation?.operationId} />
          <ReadOnlyRow label="Overall State" value={operation?.status} />
          <ReadOnlyRow label="Current Step" value={operation?.steps?.find((step) => step.status === "running")?.stepKey || "-"} />
          <ReadOnlyRow label="Ready for Activation" value={organisation?.organisation?.status === "ready_for_activation" ? "yes" : "no"} />
        </div>
        <div className="mt-4 space-y-2">
          {(operation?.steps || []).map((step) => (
            <div key={step.stepKey} className="rounded-xl border border-border/70 px-3 py-2 text-sm">
              <p className="font-semibold">{step.stepKey}</p>
              <p className="text-muted-foreground">status={step.status}, attempts={step.attemptCount}, compensation={step.compensationStatus}</p>
              {step.safeErrorSummary ? <p className="text-red-600">{step.safeErrorSummary}</p> : null}
            </div>
          ))}
        </div>
      </SectionCard>

      <SectionCard title="Global ClaimGuard Engine Configuration" description="Configure the default 'ClaimGuard Detection Engine' model used by schemes that have not opted into a custom engine.">
        <GlobalDetectionEngineSettings />
      </SectionCard>

      <SectionCard title="API health" description="Live read from the API's existing /health and /ready endpoints.">
        <div className="flex flex-wrap gap-3">
          <StatusIndicator variant="badge" tone={health?.health?.status === "ok" ? "success" : "info"}>
            /health: {health?.health?.status || "checking..."}
          </StatusIndicator>
          <StatusIndicator variant="badge" tone={health?.ready?.ready ? "success" : "info"}>
            /ready: {health?.ready?.status || "checking..."}
          </StatusIndicator>
        </div>
      </SectionCard>
    </PageFrame>
  );
}
