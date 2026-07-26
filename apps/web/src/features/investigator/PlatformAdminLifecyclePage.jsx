import React from "react";
import Building2 from "lucide-react/dist/esm/icons/building-2.mjs";
import Server from "lucide-react/dist/esm/icons/server.mjs";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import {
  DefinitionList,
  EmptyState,
  FormField,
  PageFrame,
  SectionCard,
  StatusIndicator,
  WorkspaceNotice,
  formatEnumLabel,
} from "./InvestigatorUI";
import { GlobalDetectionEngineSettings } from "./PlatformAdminPage";
import { usePlatformAdminLifecycle } from "./usePlatformAdminLifecycle";

function LifecycleActions({ lifecycle }) {
  const { permissions, busy } = lifecycle;
  return (
    <div className="flex flex-wrap gap-2">
      <Button type="button" variant="outline" disabled={!permissions.canProvision || busy} onClick={lifecycle.provision}>Request provisioning</Button>
      <Button type="button" variant="outline" disabled={!permissions.canRetry || busy} onClick={lifecycle.retryOperation}>Retry failed operation</Button>
      <Button type="button" variant="outline" disabled={!permissions.canUpgrade || busy} onClick={lifecycle.upgrade}>Upgrade data plane</Button>
      <Button type="button" disabled={!permissions.canActivate || busy} onClick={lifecycle.activate}>Activate organisation</Button>
    </div>
  );
}

export function PlatformAdminLifecyclePage() {
  const lifecycle = usePlatformAdminLifecycle();
  const {
    busy,
    message,
    error,
    organisations,
    selected,
    review,
    operation,
    integration,
    oneTimeToken,
    invitationUrl,
    health,
    draftForm,
    setDraftForm,
    inviteEmail,
    setInviteEmail,
    integrationForm,
    setIntegrationForm,
    permissions,
  } = lifecycle;

  const currentStep = operation?.steps?.find((step) => step.status === "running")?.stepKey || null;

  return (
    <PageFrame
      eyebrow="Platform Administration"
      title="Medical scheme lifecycle console"
      description="Create medical schemes, provision their data planes, manage administrator access, and connect claims servers without exposing infrastructure secrets to the browser."
      actions={[
        <StatusIndicator key="health" variant="badge" tone={health?.health?.status === "ok" ? "success" : "info"}>API {health?.health?.status || "checking"}</StatusIndicator>,
        <StatusIndicator key="ready" variant="badge" tone={health?.ready?.ready ? "success" : "warning"}>Readiness {health?.ready?.status || "checking"}</StatusIndicator>,
      ]}
    >
      {error ? <WorkspaceNotice title="Platform action failed" tone="danger">{error}</WorkspaceNotice> : null}
      {message ? <WorkspaceNotice title={message} tone="success" /> : null}

      <div className="grid gap-5 xl:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)]">
        <SectionCard title="Medical scheme inventory" description="Select an organisation to manage its lifecycle and access configuration.">
          {organisations.length === 0 ? (
            <EmptyState icon={Building2} title="No medical schemes registered" description="Create the first draft organisation using the form alongside this inventory." />
          ) : (
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-1">
              {organisations.map((item) => {
                const active = selected?.organisationId === item.organisationId;
                return (
                  <button
                    key={item.organisationId}
                    type="button"
                    aria-pressed={active}
                    disabled={busy}
                    onClick={() => lifecycle.loadOrganisation(item.organisationId)}
                    className={`rounded-xl border p-4 text-left transition-colors ${active ? "border-primary bg-primary/5" : "border-border/70 hover:bg-muted/40"}`}
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="font-semibold">{item.displayName}</p>
                        <p className="mt-1 break-all text-sm text-muted-foreground">{item.canonicalSlug}</p>
                      </div>
                      <StatusIndicator variant="badge" tone={item.status === "active" ? "success" : item.status === "failed" ? "danger" : "info"}>{formatEnumLabel(item.status)}</StatusIndicator>
                    </div>
                  </button>
                );
              })}
            </div>
          )}
        </SectionCard>

        <SectionCard title="Create draft scheme" description="Create the organisation and initial administrator identity before provisioning infrastructure.">
          <form className="grid gap-4" onSubmit={lifecycle.createDraft}>
            <div className="grid gap-4 md:grid-cols-2">
              <FormField label="Organisation name">
                <Input value={draftForm.displayName} onChange={(event) => setDraftForm((previous) => ({ ...previous, displayName: event.target.value }))} required />
              </FormField>
              <FormField label="Canonical slug">
                <Input value={draftForm.canonicalSlug} onChange={(event) => setDraftForm((previous) => ({ ...previous, canonicalSlug: event.target.value.toLowerCase() }))} required />
              </FormField>
              <FormField label="Deployment class">
                <select className="h-9 rounded-md border border-input bg-background px-3 text-sm" value={draftForm.deploymentClass} onChange={(event) => setDraftForm((previous) => ({ ...previous, deploymentClass: event.target.value }))}>
                  <option value="demo">Demo</option>
                  <option value="pilot">Pilot</option>
                </select>
              </FormField>
              <FormField label="Initial administrator name">
                <Input value={draftForm.adminDisplayName} onChange={(event) => setDraftForm((previous) => ({ ...previous, adminDisplayName: event.target.value }))} required />
              </FormField>
              <FormField label="Initial administrator email">
                <Input type="email" value={draftForm.adminEmail} onChange={(event) => setDraftForm((previous) => ({ ...previous, adminEmail: event.target.value }))} required />
              </FormField>
            </div>
            <Button type="submit" className="w-fit" disabled={busy}>{busy ? "Working..." : "Create draft scheme"}</Button>
          </form>
        </SectionCard>
      </div>

      {!selected ? (
        <SectionCard title="Selected scheme workspace" description="Lifecycle actions appear after selecting or creating an organisation.">
          <EmptyState icon={Building2} title="Select a medical scheme" description="Choose an organisation from the inventory to manage provisioning, activation, access and claims-server integration." />
        </SectionCard>
      ) : (
        <>
          <SectionCard
            title={selected.displayName}
            description={`Lifecycle controls for ${selected.canonicalSlug}.`}
            actions={<StatusIndicator variant="badge" tone={selected.status === "active" ? "success" : "info"}>{formatEnumLabel(selected.status)}</StatusIndicator>}
          >
            <DefinitionList
              items={[
                { label: "Organisation ID", value: selected.organisationId, mono: true },
                { label: "Deployment class", value: formatEnumLabel(selected.deploymentClass) },
                { label: "Current operation", value: operation?.status ? formatEnumLabel(operation.status) : "No active operation" },
                { label: "Current step", value: currentStep ? formatEnumLabel(currentStep) : "No running step" },
                { label: "Ready for activation", value: selected.status === "ready_for_activation" ? "Yes" : "No" },
                { label: "Schema version", value: review?.schemaVersion || "Not available" },
              ]}
            />
            <div className="mt-5"><LifecycleActions lifecycle={lifecycle} /></div>
          </SectionCard>

          <div className="grid gap-5 xl:grid-cols-2">
            <SectionCard title="Scheme administrator access" description="Generate a one-time signup link for the selected scheme administrator.">
              <form className="grid gap-4" onSubmit={lifecycle.inviteAdministrator}>
                <FormField label="Administrator email">
                  <Input type="email" value={inviteEmail} onChange={(event) => setInviteEmail(event.target.value)} required />
                </FormField>
                <Button type="submit" className="w-fit" disabled={busy || !inviteEmail}>Generate invitation</Button>
                {invitationUrl ? <WorkspaceNotice title="Copy this invitation URL" tone="warning"><code className="break-all font-data text-xs">{invitationUrl}</code></WorkspaceNotice> : null}
              </form>
            </SectionCard>

            <SectionCard title="Provisioning review" description="Server-derived deployment choices for the selected organisation.">
              <DefinitionList
                columns={1}
                items={[
                  { label: "Approved Azure region", value: review?.region || "Not available" },
                  { label: "Approved flexible server", value: review?.flexibleServerName || "Not available" },
                  { label: "Logical database", value: review?.generatedLogicalDatabaseName || "Not available", mono: true },
                  { label: "Report partition", value: review?.reportPartitionStrategy || "Not available" },
                ]}
              />
            </SectionCard>
          </div>

          <SectionCard title="Claims-server integration" description="Issue and revoke separate credentials for claims-sending systems. Raw tokens are shown once only.">
            {!permissions.isActive ? (
              <WorkspaceNotice title="Activate the scheme first" tone="warning">Claims-server credentials can only be issued after the organisation is active.</WorkspaceNotice>
            ) : (
              <div className="space-y-5">
                <div className="grid gap-4 md:grid-cols-3">
                  <FormField label="Connection name"><Input value={integrationForm.displayName} onChange={(event) => setIntegrationForm((previous) => ({ ...previous, displayName: event.target.value }))} /></FormField>
                  <FormField label="Stable server ID"><Input value={integrationForm.serviceActorId} onChange={(event) => setIntegrationForm((previous) => ({ ...previous, serviceActorId: event.target.value.toLowerCase() }))} /></FormField>
                  <FormField label="Expires in days"><Input type="number" min="1" max="365" value={integrationForm.expiresInDays} onChange={(event) => setIntegrationForm((previous) => ({ ...previous, expiresInDays: event.target.value }))} /></FormField>
                </div>
                <Button type="button" disabled={busy || !integrationForm.serviceActorId} onClick={lifecycle.createCredential}>Create claims-server credential</Button>
                {oneTimeToken ? <WorkspaceNotice title="Copy this token now" tone="warning"><code className="break-all font-data text-xs">{oneTimeToken}</code></WorkspaceNotice> : null}
                <DefinitionList items={[
                  { label: "Claims endpoint", value: integration?.guide?.endpoint || "Not available", mono: true },
                  { label: "Success response", value: integration?.guide?.successStatus ? `HTTP ${integration.guide.successStatus}` : "Not available" },
                ]} />
                {(integration?.credentials || []).length === 0 ? (
                  <EmptyState icon={Server} title="No integration credentials" description="Create a credential when the claims-sending server is ready to connect." compact />
                ) : (
                  <div className="divide-y divide-border/70 rounded-xl border border-border/70">
                    {integration.credentials.map((credential) => (
                      <div key={credential.integrationCredentialId} className="flex flex-col gap-3 px-4 py-4 sm:flex-row sm:items-center sm:justify-between">
                        <div>
                          <p className="font-semibold">{credential.displayName}</p>
                          <p className="mt-1 text-sm text-muted-foreground">{credential.serviceActorId} · {credential.tokenPrefix}…</p>
                        </div>
                        <div className="flex items-center gap-2">
                          <StatusIndicator variant="badge" tone={credential.status === "active" ? "success" : "info"}>{formatEnumLabel(credential.status)}</StatusIndicator>
                          {credential.status === "active" ? <Button variant="outline" size="sm" disabled={busy} onClick={() => lifecycle.revokeCredential(credential.integrationCredentialId)}>Revoke</Button> : null}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </SectionCard>
        </>
      )}

      <SectionCard title="Global ClaimGuard engine" description="Review the fleet-managed model promoted by the validated API deployment. Managed schemes adopt updates through an audited prospective transition.">
        <GlobalDetectionEngineSettings />
      </SectionCard>
    </PageFrame>
  );
}
