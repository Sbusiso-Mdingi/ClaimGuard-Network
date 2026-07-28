import { useEffect, useMemo, useState } from "react";
import { apiJson, ApiError } from "../../lib/apiClient";

function requestMessage(error, fallback) {
  return error instanceof ApiError ? error.message : fallback;
}

export function usePlatformAdminLifecycle() {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [organisations, setOrganisations] = useState([]);
  const [organisation, setOrganisation] = useState(null);
  const [operation, setOperation] = useState(null);
  const [integration, setIntegration] = useState(null);
  const [oneTimeToken, setOneTimeToken] = useState("");
  const [invitationUrl, setInvitationUrl] = useState("");
  const [health, setHealth] = useState(null);

  const [draftForm, setDraftForm] = useState({
    displayName: "",
    canonicalSlug: "",
    adminDisplayName: "",
    adminEmail: "",
  });
  const [inviteEmail, setInviteEmail] = useState("");
  const [integrationForm, setIntegrationForm] = useState({
    displayName: "Claims server",
    serviceActorId: "",
    expiresInDays: "90",
  });

  const selected = organisation?.organisation || null;
  const review = organisation?.provisioningReview || null;
  const permissions = useMemo(() => ({
    canProvision: Boolean(selected?.organisationId),
    canRetry: Boolean(operation?.operationId && ["failed", "quarantined", "compensated"].includes(operation.status)),
    canActivate: selected?.status === "ready_for_activation",
    canUpgrade: ["active", "suspended", "ready_for_activation"].includes(selected?.status),
    isActive: selected?.status === "active",
  }), [operation?.operationId, operation?.status, selected?.organisationId, selected?.status]);

  function clearFeedback() {
    setError("");
    setMessage("");
  }

  async function refreshOrganisations() {
    const payload = await apiJson("/admin/platform/organisations", { cache: "no-store" });
    const items = payload.organisations || [];
    setOrganisations(items);
    return items;
  }

  async function refreshOperation(operationId) {
    if (!operationId) return;
    const payload = await apiJson(`/admin/platform/provisioning/${encodeURIComponent(operationId)}`, { cache: "no-store" });
    setOperation(payload.operation || null);
  }

  async function loadOrganisation(organisationId) {
    setBusy(true);
    clearFeedback();
    setOneTimeToken("");
    setInvitationUrl("");
    try {
      const payload = await apiJson(`/admin/platform/organisations/${encodeURIComponent(organisationId)}`, { cache: "no-store" });
      const organisationRecord = payload.organisation || null;
      setOrganisation({ organisation: organisationRecord, provisioningReview: payload.provisioningReview || null });
      const latest = payload.operations?.[0] || null;
      if (latest?.operationId) await refreshOperation(latest.operationId);
      else setOperation(null);
      if (organisationRecord?.status === "active") {
        setIntegration(await apiJson(`/admin/platform/organisations/${encodeURIComponent(organisationId)}/integration`, { cache: "no-store" }));
      } else {
        setIntegration(null);
      }
      setIntegrationForm((previous) => ({ ...previous, serviceActorId: `${organisationRecord?.canonicalSlug || "scheme"}-claims-server` }));
    } catch (requestError) {
      setError(requestMessage(requestError, "Medical aid could not be loaded."));
    } finally {
      setBusy(false);
    }
  }

  async function createDraft(event) {
    event.preventDefault();
    setBusy(true);
    clearFeedback();
    try {
      const payload = await apiJson("/admin/platform/organisations", {
        method: "POST",
        body: JSON.stringify({
          displayName: draftForm.displayName,
          canonicalSlug: draftForm.canonicalSlug,
          deploymentClass: "production",
          organisationType: "medical_scheme",
          initialAdministrator: { displayName: draftForm.adminDisplayName, email: draftForm.adminEmail },
        }),
      });
      setOrganisation(payload);
      await refreshOrganisations();
      setMessage("Draft organisation created. No infrastructure has been provisioned yet.");
    } catch (requestError) {
      setError(requestMessage(requestError, "Draft creation failed."));
    } finally {
      setBusy(false);
    }
  }

  async function runOrganisationAction(action, successMessage) {
    if (!selected?.organisationId) return;
    setBusy(true);
    clearFeedback();
    try {
      const payload = await apiJson(`/admin/platform/organisations/${encodeURIComponent(selected.organisationId)}/${action}`, { method: "POST" });
      if (payload.operation) setOperation(payload.operation);
      setMessage(payload.message || successMessage);
      if (action === "activate") {
        await refreshOrganisations();
        await loadOrganisation(selected.organisationId);
      }
    } catch (requestError) {
      setError(requestMessage(requestError, `${action} request failed.`));
    } finally {
      setBusy(false);
    }
  }

  async function retryOperation() {
    if (!operation?.operationId) return;
    setBusy(true);
    clearFeedback();
    try {
      await apiJson(`/admin/platform/provisioning/${encodeURIComponent(operation.operationId)}/retry`, { method: "POST" });
      await refreshOperation(operation.operationId);
      setMessage("Retry requested.");
    } catch (requestError) {
      setError(requestMessage(requestError, "Retry failed."));
    } finally {
      setBusy(false);
    }
  }

  async function inviteAdministrator(event) {
    event.preventDefault();
    if (!selected?.organisationId || !inviteEmail) return;
    setBusy(true);
    clearFeedback();
    setInvitationUrl("");
    try {
      const payload = await apiJson(`/admin/platform/organisations/${encodeURIComponent(selected.organisationId)}/invite-admin`, {
        method: "POST",
        body: JSON.stringify({ email: inviteEmail }),
      });
      setInvitationUrl(`${window.location.origin}/auth/signup?token=${payload.token}`);
      setInviteEmail("");
      setMessage("Invitation created successfully.");
    } catch (requestError) {
      setError(requestMessage(requestError, "Failed to create invitation."));
    } finally {
      setBusy(false);
    }
  }

  async function createCredential() {
    if (!selected?.organisationId) return;
    setBusy(true);
    clearFeedback();
    setOneTimeToken("");
    try {
      const payload = await apiJson(`/admin/platform/organisations/${encodeURIComponent(selected.organisationId)}/integration-credentials`, {
        method: "POST",
        body: JSON.stringify(integrationForm),
      });
      setOneTimeToken(payload.bearerToken || "");
      setIntegration((previous) => ({ ...(previous || {}), guide: payload.guide, credentials: [payload.credential, ...(previous?.credentials || [])] }));
      setMessage("Claims-server credential created. Copy the token now.");
    } catch (requestError) {
      setError(requestMessage(requestError, "Credential creation failed."));
    } finally {
      setBusy(false);
    }
  }

  async function revokeCredential(credentialId) {
    if (!selected?.organisationId) return;
    setBusy(true);
    clearFeedback();
    try {
      await apiJson(`/admin/platform/organisations/${encodeURIComponent(selected.organisationId)}/integration-credentials/${encodeURIComponent(credentialId)}/revoke`, { method: "POST" });
      await loadOrganisation(selected.organisationId);
      setMessage("Claims-server credential revoked.");
    } catch (requestError) {
      setError(requestMessage(requestError, "Credential revocation failed."));
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    refreshOrganisations().catch(() => setError("Medical-aid inventory could not be loaded."));
    Promise.all([apiJson("/health", { cache: "no-store" }), apiJson("/ready", { cache: "no-store" })])
      .then(([healthResponse, readyResponse]) => setHealth({ health: healthResponse, ready: readyResponse }))
      .catch(() => setHealth({ health: { status: "unreachable" }, ready: { status: "unreachable", ready: false } }));
  }, []);

  useEffect(() => {
    const timer = window.setInterval(() => {
      if (operation?.operationId) refreshOperation(operation.operationId).catch(() => undefined);
    }, 4000);
    return () => window.clearInterval(timer);
  }, [operation?.operationId]);

  return {
    busy, message, error, organisations, organisation, selected, review, operation, integration,
    oneTimeToken, invitationUrl, health, draftForm, setDraftForm, inviteEmail, setInviteEmail,
    integrationForm, setIntegrationForm, permissions, loadOrganisation, createDraft,
    provision: () => runOrganisationAction("provision", "Provisioning requested asynchronously."),
    activate: () => runOrganisationAction("activate", "Activation request submitted."),
    upgrade: () => runOrganisationAction("upgrade", "Schema upgrade queued."),
    retryOperation, inviteAdministrator, createCredential, revokeCredential,
  };
}
