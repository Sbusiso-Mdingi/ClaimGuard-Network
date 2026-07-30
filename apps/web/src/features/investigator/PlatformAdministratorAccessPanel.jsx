import React, { useCallback, useEffect, useMemo, useState } from "react";
import RefreshCw from "lucide-react/dist/esm/icons/refresh-cw.mjs";
import ShieldCheck from "lucide-react/dist/esm/icons/shield-check.mjs";
import UserPlus from "lucide-react/dist/esm/icons/user-plus.mjs";
import X from "lucide-react/dist/esm/icons/x.mjs";

import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { ApiError, apiJson, safeApiErrorMessage } from "../../lib/apiClient";
import {
  DataTableShell,
  EmptyState,
  FormField,
  SectionCard,
  StatusIndicator,
  WorkspaceNotice,
  formatEnumLabel,
} from "./InvestigatorUI";

function formatTimestamp(value) {
  if (!value) return "Not recorded";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return "Not recorded";
  return parsed.toLocaleString("en-ZA", {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

function invitationConfirmation(email) {
  return `INVITE ${String(email || "").trim().toLowerCase()} AS PLATFORM ADMINISTRATOR`;
}

function invitationTone(status) {
  if (status === "consumed") return "success";
  if (status === "pending") return "warning";
  return "info";
}

function AdministratorStepUpDialog({
  title,
  description,
  confirmation,
  submitLabel,
  submitting,
  onClose,
  onSubmit,
}) {
  const [password, setPassword] = useState("");
  const [enteredConfirmation, setEnteredConfirmation] = useState("");
  const ready = Boolean(
    password
    && enteredConfirmation === confirmation,
  );

  function submit(event) {
    event.preventDefault();
    if (!ready) return;
    onSubmit({
      password,
      confirmation: enteredConfirmation,
    });
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/70 p-4 backdrop-blur-sm"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !submitting) onClose();
      }}
    >
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby="platform-administrator-action-title"
        className="w-full max-w-xl rounded-2xl border border-border bg-card shadow-2xl"
      >
        <header className="flex items-start justify-between gap-4 border-b border-border/70 p-5">
          <div>
            <h3
              id="platform-administrator-action-title"
              className="font-display text-xl font-semibold"
            >
              {title}
            </h3>
            <p className="mt-1 text-sm leading-6 text-muted-foreground">
              {description}
            </p>
          </div>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label="Close platform administrator action"
            disabled={submitting}
            onClick={onClose}
          >
            <X className="h-4 w-4" />
          </Button>
        </header>
        <form className="grid gap-4 p-5" onSubmit={submit}>
          <FormField
            label="Current password"
            hint="ClaimGuard verifies your current credential for this action. It is never written to an invitation or audit record."
          >
            <Input
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              required
            />
          </FormField>
          <FormField
            label="Confirmation"
            hint={(
              <>
                Type <code className="font-data">{confirmation}</code> exactly.
              </>
            )}
          >
            <Input
              className="font-data"
              value={enteredConfirmation}
              autoComplete="off"
              spellCheck={false}
              onChange={(event) => setEnteredConfirmation(event.target.value)}
              required
            />
          </FormField>
          <div className="flex flex-wrap justify-end gap-2 border-t border-border/70 pt-4">
            <Button
              type="button"
              variant="outline"
              disabled={submitting}
              onClick={onClose}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={!ready || submitting}>
              {submitting ? "Recording…" : submitLabel}
            </Button>
          </div>
        </form>
      </section>
    </div>
  );
}

export function PlatformAdministratorAccessPanel() {
  const [access, setAccess] = useState(null);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [inviteEmail, setInviteEmail] = useState("");
  const [reviewedEmail, setReviewedEmail] = useState("");
  const [invitationUrl, setInvitationUrl] = useState("");
  const [revocation, setRevocation] = useState(null);

  const loadAccess = useCallback(() => {
    setLoading(true);
    setError("");
    return apiJson("/admin/platform/administrators", { cache: "no-store" })
      .then(setAccess)
      .catch((requestError) => setError(safeApiErrorMessage(
        requestError,
        "Platform administrator access could not be loaded.",
      )))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    loadAccess();
  }, [loadAccess]);

  const normalizedInviteEmail = useMemo(
    () => inviteEmail.trim().toLowerCase(),
    [inviteEmail],
  );

  async function createInvitation(values) {
    if (!reviewedEmail) return;
    setSubmitting(true);
    setError("");
    setMessage("");
    setInvitationUrl("");
    try {
      const payload = await apiJson(
        "/admin/platform/administrators/invitations",
        {
          method: "POST",
          skipUnauthorizedHandler: true,
          body: JSON.stringify({
            email: reviewedEmail,
            password: values.password,
            confirmation: values.confirmation,
          }),
        },
      );
      setInvitationUrl(
        `${window.location.origin}/auth/signup?token=${payload.token}`,
      );
      setReviewedEmail("");
      setInviteEmail("");
      setMessage(`${payload.message} Audit event ${payload.auditEventId}.`);
      await loadAccess();
    } catch (requestError) {
      setError(safeApiErrorMessage(
        requestError,
        requestError instanceof ApiError
          ? requestError.message
          : "Platform administrator invitation could not be created.",
      ));
    } finally {
      setSubmitting(false);
    }
  }

  async function revokeInvitation(values) {
    if (!revocation) return;
    setSubmitting(true);
    setError("");
    setMessage("");
    try {
      const payload = await apiJson(
        `/admin/platform/administrators/invitations/${encodeURIComponent(revocation.invitationId)}/revoke`,
        {
          method: "POST",
          skipUnauthorizedHandler: true,
          body: JSON.stringify({
            password: values.password,
            confirmation: values.confirmation,
          }),
        },
      );
      setRevocation(null);
      setMessage(`${payload.message} Audit event ${payload.auditEventId}.`);
      await loadAccess();
    } catch (requestError) {
      setError(safeApiErrorMessage(
        requestError,
        requestError instanceof ApiError
          ? requestError.message
          : "Platform administrator invitation could not be revoked.",
      ));
    } finally {
      setSubmitting(false);
    }
  }

  if (loading && !access) {
    return (
      <WorkspaceNotice title="Loading platform administrator access">
        ClaimGuard is reading safe user, membership, role and invitation records
        from the control plane.
      </WorkspaceNotice>
    );
  }

  if (!access) {
    return (
      <SectionCard
        title="Platform administrator access"
        description="Invite the separate administrator required for two-person production approvals. Azure access is not required."
        actions={(
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={loading}
            onClick={loadAccess}
          >
            <RefreshCw className={`mr-2 h-4 w-4 ${loading ? "animate-spin" : ""}`} />
            Retry access
          </Button>
        )}
      >
        <WorkspaceNotice title="Platform administrator access unavailable" tone="danger">
          {error || "Platform administrator access could not be loaded."}
        </WorkspaceNotice>
      </SectionCard>
    );
  }

  return (
    <SectionCard
      title="Platform administrator access"
      description="Invite the separate administrator required for two-person production approvals. Azure access is not required."
      actions={(
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={loading}
          onClick={loadAccess}
        >
          <RefreshCw className={`mr-2 h-4 w-4 ${loading ? "animate-spin" : ""}`} />
          Refresh access
        </Button>
      )}
    >
      <div className="grid gap-5">
        {error ? (
          <WorkspaceNotice title="Platform access action failed" tone="danger">
            {error}
          </WorkspaceNotice>
        ) : null}
        {message ? (
          <WorkspaceNotice title="Audited access action recorded" tone="success">
            {message}
          </WorkspaceNotice>
        ) : null}
        {invitationUrl ? (
          <WorkspaceNotice title="Copy this one-time invitation URL now" tone="warning">
            <p className="mb-2">
              ClaimGuard stores only the token hash. This URL cannot be recovered
              after you leave or refresh this page.
            </p>
            <code className="break-all font-data text-xs">{invitationUrl}</code>
          </WorkspaceNotice>
        ) : null}

        <div className="grid gap-5 xl:grid-cols-[minmax(0,0.8fr)_minmax(0,1.2fr)]">
          <form
            className="grid content-start gap-4 rounded-xl border border-border/70 bg-background/40 p-4"
            onSubmit={(event) => {
              event.preventDefault();
              if (normalizedInviteEmail) setReviewedEmail(normalizedInviteEmail);
            }}
          >
            <div>
              <div className="flex items-center gap-2">
                <UserPlus className="h-4 w-4 text-primary" aria-hidden="true" />
                <h3 className="font-semibold">Invite another administrator</h3>
              </div>
              <p className="mt-1 text-sm leading-6 text-muted-foreground">
                The recipient chooses their own username and password. The link
                expires after 24 hours and can be used once.
              </p>
            </div>
            <FormField label="Administrator email">
              <Input
                type="email"
                autoComplete="email"
                value={inviteEmail}
                onChange={(event) => setInviteEmail(event.target.value)}
                required
              />
            </FormField>
            <Button
              type="submit"
              className="w-fit"
              disabled={!normalizedInviteEmail || submitting}
            >
              Review invitation
            </Button>
          </form>

          <div className="grid gap-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h3 className="font-semibold">Active platform administrators</h3>
              <StatusIndicator variant="badge" tone="info">
                {(access?.administrators || []).length} active
              </StatusIndicator>
            </div>
            {(access?.administrators || []).length === 0 ? (
              <EmptyState
                icon={ShieldCheck}
                title="No platform administrators found"
                description="Access data is inconsistent. Do not create a production promotion request."
                compact
              />
            ) : (
              <div className="divide-y divide-border/70 rounded-xl border border-border/70">
                {access.administrators.map((administrator) => (
                  <div
                    key={administrator.userId}
                    className="flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-center sm:justify-between"
                  >
                    <div>
                      <p className="font-semibold">{administrator.displayName}</p>
                      <p className="mt-1 text-xs text-muted-foreground">
                        {administrator.canonicalContact}
                      </p>
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      <StatusIndicator
                        variant="badge"
                        tone={administrator.userStatus === "active" ? "success" : "warning"}
                      >
                        {formatEnumLabel(administrator.userStatus)}
                      </StatusIndicator>
                      <code className="font-data text-[10px] text-muted-foreground">
                        {String(administrator.userId || "").slice(0, 8)}
                      </code>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        <div className="grid gap-3">
          <div>
            <h3 className="font-semibold">Invitation history</h3>
            <p className="mt-1 text-sm text-muted-foreground">
              Tokens are never returned by this history endpoint.
            </p>
          </div>
          {(access?.invitations || []).length === 0 ? (
            <EmptyState
              icon={UserPlus}
              title="No platform administrator invitations"
              description="The first audited invitation will appear here after it is created."
              compact
            />
          ) : (
            <DataTableShell
              ariaLabel="Platform administrator invitation history"
              minWidth="860px"
            >
              <thead>
                <tr>
                  <th scope="col">Email</th>
                  <th scope="col">Status</th>
                  <th scope="col">Invited</th>
                  <th scope="col">Expires</th>
                  <th scope="col">Invited by</th>
                  <th scope="col">Action</th>
                </tr>
              </thead>
              <tbody>
                {access.invitations.map((invitation) => (
                  <tr key={invitation.invitationId}>
                    <td>{invitation.email}</td>
                    <td>
                      <StatusIndicator
                        variant="badge"
                        tone={invitationTone(invitation.status)}
                      >
                        {formatEnumLabel(invitation.status)}
                      </StatusIndicator>
                    </td>
                    <td>{formatTimestamp(invitation.createdAt)}</td>
                    <td>{formatTimestamp(invitation.expiresAt)}</td>
                    <td className="font-data text-xs">
                      {invitation.invitedBy || "Not recorded"}
                    </td>
                    <td>
                      {invitation.status === "pending" ? (
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          onClick={() => setRevocation(invitation)}
                        >
                          Revoke
                        </Button>
                      ) : (
                        <span className="text-xs text-muted-foreground">
                          No action available
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </DataTableShell>
          )}
        </div>
      </div>

      {reviewedEmail ? (
        <AdministratorStepUpDialog
          title={`Invite ${reviewedEmail}`}
          description="This creates privileged, persistent ClaimGuard access. Confirm the recipient is a separate trusted person before continuing."
          confirmation={invitationConfirmation(reviewedEmail)}
          submitLabel="Create audited invitation"
          submitting={submitting}
          onClose={() => setReviewedEmail("")}
          onSubmit={createInvitation}
        />
      ) : null}

      {revocation ? (
        <AdministratorStepUpDialog
          title={`Revoke invitation ${revocation.invitationId.slice(0, 8)}`}
          description={`This prevents ${revocation.email} from using the pending one-time link.`}
          confirmation={revocation.revocationConfirmation}
          submitLabel="Revoke invitation"
          submitting={submitting}
          onClose={() => setRevocation(null)}
          onSubmit={revokeInvitation}
        />
      ) : null}
    </SectionCard>
  );
}
