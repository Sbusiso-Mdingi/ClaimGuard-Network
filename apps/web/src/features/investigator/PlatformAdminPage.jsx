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

export function PlatformAdminPage() {
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [organisation, setOrganisation] = useState(null);
  const [operation, setOperation] = useState(null);
  const [health, setHealth] = useState(null);
  const [form, setForm] = useState({
    displayName: "",
    canonicalSlug: "",
    deploymentClass: "demo",
    adminDisplayName: "",
    adminEmail: "",
    loadDemoBootstrapData: true,
    createDemoUsers: true,
    simulatorEnabled: false,
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
    return payload.organisations || [];
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
          demoOptions: {
            loadDemoBootstrapData: form.loadDemoBootstrapData,
            createDemoUsers: form.createDemoUsers,
            simulatorEnabled: form.simulatorEnabled,
          },
        }),
      });
      setOrganisation(payload);
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
      const organisations = await refreshOrganisations();
      const current = organisations.find((item) => item.organisationId === organisation.organisation.organisationId);
      if (current) setOrganisation((previous) => ({ ...previous, organisation: current }));
    } catch (requestError) {
      setError(requestError instanceof ApiError ? requestError.message : "Activation request failed.");
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

  const canProvision = Boolean(organisation?.organisation?.organisationId);
  const canRetry = Boolean(operation?.operationId && ["failed", "quarantined", "compensated"].includes(operation.status));
  const canActivate = Boolean(organisation?.organisation?.status === "ready_for_activation");

  return (
    <PageFrame
      eyebrow="Platform Administration"
      title="Medical scheme onboarding"
      description="Platform administrators create DRAFT organisations and request asynchronous provisioning. Browser clients never call Azure Resource Manager directly."
    >
      <SectionCard title="Step 1-3: Organisation, Initial Admin, Demo Options" description="Create a DRAFT organisation without provisioning infrastructure.">
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
          <div className="grid gap-2 md:grid-cols-3">
            <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={form.loadDemoBootstrapData} onChange={(event) => setForm((prev) => ({ ...prev, loadDemoBootstrapData: event.target.checked }))} />Load demo bootstrap data</label>
            <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={form.createDemoUsers} onChange={(event) => setForm((prev) => ({ ...prev, createDemoUsers: event.target.checked }))} />Create demo users</label>
            <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={form.simulatorEnabled} onChange={(event) => setForm((prev) => ({ ...prev, simulatorEnabled: event.target.checked }))} />Enable simulator</label>
          </div>
          <div className="flex flex-wrap gap-2">
            <button type="submit" className="rounded-xl bg-primary px-4 py-2 text-primary-foreground disabled:opacity-50" disabled={loading}>Create Draft</button>
            <button type="button" className="rounded-xl border border-border px-4 py-2 disabled:opacity-50" disabled={!canProvision || loading} onClick={handleProvision}>Request Provisioning</button>
            <button type="button" className="rounded-xl border border-border px-4 py-2 disabled:opacity-50" disabled={!canRetry || loading} onClick={handleRetry}>Retry Failed Operation</button>
            <button type="button" className="rounded-xl border border-border px-4 py-2 disabled:opacity-50" disabled={!canActivate || loading} onClick={handleActivate}>Activate (Explicit)</button>
          </div>
          {message ? <p className="text-sm text-emerald-600">{message}</p> : null}
          {error ? <p className="text-sm text-red-600">{error}</p> : null}
        </form>
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
