import React, { useCallback, useEffect, useMemo, useState } from "react";
import CheckCircle2 from "lucide-react/dist/esm/icons/check-circle-2.mjs";
import ExternalLink from "lucide-react/dist/esm/icons/external-link.mjs";
import GitCommitHorizontal from "lucide-react/dist/esm/icons/git-commit-horizontal.mjs";
import RefreshCw from "lucide-react/dist/esm/icons/refresh-cw.mjs";
import ShieldCheck from "lucide-react/dist/esm/icons/shield-check.mjs";
import X from "lucide-react/dist/esm/icons/x.mjs";

import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { ApiError, apiJson, safeApiErrorMessage } from "../../lib/apiClient";
import {
  DataTableShell,
  DefinitionList,
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

function requestTone(status) {
  if (status === "deployed") return "success";
  if (status === "failed" || status === "rejected") return "danger";
  if (status === "approved" || status === "deploying") return "warning";
  return "info";
}

function WorkflowLink({ href, children }) {
  if (!href) return children;
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="inline-flex items-center gap-1 text-primary underline-offset-4 hover:underline"
    >
      {children}
      <ExternalLink className="h-3 w-3" aria-hidden="true" />
    </a>
  );
}

function StepUpDialog({
  title,
  description,
  confirmation,
  reasonRequired = false,
  submitting,
  onClose,
  onSubmit,
}) {
  const [password, setPassword] = useState("");
  const [enteredConfirmation, setEnteredConfirmation] = useState("");
  const [reason, setReason] = useState("");
  const ready = password
    && enteredConfirmation === confirmation
    && (!reasonRequired || reason.trim().length >= 12);

  function submit(event) {
    event.preventDefault();
    if (!ready) return;
    onSubmit({
      password,
      confirmation: enteredConfirmation,
      reason: reason.trim(),
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
        aria-labelledby="release-action-title"
        className="w-full max-w-xl rounded-2xl border border-border bg-card shadow-2xl"
      >
        <header className="flex items-start justify-between gap-4 border-b border-border/70 p-5">
          <div>
            <h3 id="release-action-title" className="font-display text-xl font-semibold">{title}</h3>
            <p className="mt-1 text-sm leading-6 text-muted-foreground">{description}</p>
          </div>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label="Close release action"
            disabled={submitting}
            onClick={onClose}
          >
            <X className="h-4 w-4" />
          </Button>
        </header>
        <form className="grid gap-4 p-5" onSubmit={submit}>
          {reasonRequired ? (
            <FormField
              label="Change reason"
              hint="Use at least 12 characters. Do not include claim, member, patient or other private medical information."
            >
              <textarea
                className="min-h-24 rounded-md border border-input bg-background px-3 py-2 text-sm"
                value={reason}
                maxLength={512}
                onChange={(event) => setReason(event.target.value)}
                required
              />
            </FormField>
          ) : null}
          <FormField
            label="Current password"
            hint="Your password is verified for this action and is never stored in the promotion record."
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
            hint={<>Type <code className="font-data">{confirmation}</code> exactly.</>}
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
            <Button type="button" variant="outline" disabled={submitting} onClick={onClose}>Cancel</Button>
            <Button type="submit" disabled={!ready || submitting}>
              {submitting ? "Recording…" : "Record governed action"}
            </Button>
          </div>
        </form>
      </section>
    </div>
  );
}

export function ReleaseGovernancePanel() {
  const [overview, setOverview] = useState(null);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [requestRelease, setRequestRelease] = useState(null);
  const [approvalRequest, setApprovalRequest] = useState(null);

  const loadOverview = useCallback(() => {
    setLoading(true);
    setError("");
    return apiJson("/admin/platform/releases", { cache: "no-store" })
      .then(setOverview)
      .catch((requestError) => setError(safeApiErrorMessage(
        requestError,
        "Release governance could not be loaded.",
      )))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    loadOverview();
  }, [loadOverview]);

  const currentRelease = useMemo(() => {
    const releaseId = overview?.currentDeployment?.releaseId;
    return overview?.releases?.find((release) => release.releaseId === releaseId) || null;
  }, [overview]);

  async function requestPromotion(values) {
    if (!requestRelease) return;
    setSubmitting(true);
    setError("");
    setMessage("");
    try {
      const payload = await apiJson(
        `/admin/platform/releases/${encodeURIComponent(requestRelease.releaseId)}/promotion-requests`,
        {
          method: "POST",
          skipUnauthorizedHandler: true,
          body: JSON.stringify(values),
        },
      );
      setRequestRelease(null);
      setMessage(`${payload.message} Audit event ${payload.auditEventId}.`);
      await loadOverview();
    } catch (requestError) {
      setError(safeApiErrorMessage(
        requestError,
        requestError instanceof ApiError
          ? requestError.message
          : "Promotion could not be requested.",
      ));
    } finally {
      setSubmitting(false);
    }
  }

  async function approvePromotion(values) {
    if (!approvalRequest) return;
    setSubmitting(true);
    setError("");
    setMessage("");
    try {
      const payload = await apiJson(
        `/admin/platform/promotion-requests/${encodeURIComponent(approvalRequest.promotionRequestId)}/approve`,
        {
          method: "POST",
          skipUnauthorizedHandler: true,
          body: JSON.stringify({
            password: values.password,
            confirmation: values.confirmation,
          }),
        },
      );
      setApprovalRequest(null);
      setMessage(`${payload.message} Audit event ${payload.auditEventId}.`);
      await loadOverview();
    } catch (requestError) {
      setError(safeApiErrorMessage(
        requestError,
        requestError instanceof ApiError
          ? requestError.message
          : "Promotion could not be approved.",
      ));
    } finally {
      setSubmitting(false);
    }
  }

  if (loading && !overview) {
    return (
      <WorkspaceNotice title="Loading governed releases">
        ClaimGuard is reading immutable release and deployment records from the control plane.
      </WorkspaceNotice>
    );
  }

  return (
    <div className="grid gap-5">
      {error ? <WorkspaceNotice title="Release governance unavailable" tone="danger">{error}</WorkspaceNotice> : null}
      {message ? <WorkspaceNotice title="Governed action recorded" tone="success">{message}</WorkspaceNotice> : null}

      <SectionCard
        title="Production deployment"
        description="The authoritative source commit and artifact currently serving ClaimGuard."
        actions={(
          <Button type="button" variant="outline" size="sm" disabled={loading} onClick={loadOverview}>
            <RefreshCw className={`mr-2 h-4 w-4 ${loading ? "animate-spin" : ""}`} />
            Refresh releases
          </Button>
        )}
      >
        {overview?.currentDeployment ? (
          <div className="grid gap-4">
            <div className="flex flex-wrap items-center gap-2">
              <StatusIndicator variant="badge" tone="success">Production</StatusIndicator>
              <StatusIndicator variant="badge" tone="info">Digest pinned</StatusIndicator>
              {currentRelease ? <StatusIndicator variant="badge" tone="success">Gates passed</StatusIndicator> : null}
            </div>
            <DefinitionList
              columns={3}
              items={[
                { label: "Git commit", value: overview.currentDeployment.commitSha, mono: true },
                { label: "Release artifact SHA-256", value: overview.currentDeployment.artifactDigest, mono: true },
                { label: "Deployed", value: formatTimestamp(overview.currentDeployment.deployedAt) },
                {
                  label: "Workflow run",
                  value: (
                    <WorkflowLink href={overview.currentDeployment.deploymentWorkflowRunUrl}>
                      Run {overview.currentDeployment.deploymentWorkflowRunId}
                    </WorkflowLink>
                  ),
                },
                { label: "Repository", value: overview.currentDeployment.sourceRepository, mono: true },
                { label: "Promotion request", value: overview.currentDeployment.promotionRequestId, mono: true },
              ]}
            />
          </div>
        ) : (
          <EmptyState
            icon={GitCommitHorizontal}
            title="No governed deployment recorded yet"
            description="The first deployment after this control-plane migration performs a one-time audited bootstrap. Subsequent deployments require an approved promotion request."
            compact
          />
        )}
      </SectionCard>

      <SectionCard
        title="Eligible immutable releases"
        description="Only releases whose CI and security workflows succeeded are available for promotion."
        actions={<StatusIndicator variant="badge" tone="success"><ShieldCheck className="mr-1 h-3 w-3" />Two gates required</StatusIndicator>}
      >
        {(overview?.releases || []).length === 0 ? (
          <EmptyState
            icon={ShieldCheck}
            title="No eligible releases"
            description="The release-catalogue workflow must verify CI, CodeQL and artifact digests before a commit appears here."
            compact
          />
        ) : (
          <div className="grid gap-3 lg:grid-cols-2">
            {overview.releases.map((release) => {
              const unavailable = release.current || release.promotionOpen;
              return (
                <article key={release.releaseId} className="rounded-xl border border-border/70 bg-background/40 p-4">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <GitCommitHorizontal className="h-4 w-4 text-primary" aria-hidden="true" />
                        <code className="font-data text-sm font-semibold">{release.commitSha.slice(0, 12)}</code>
                      </div>
                      <p className="mt-1 break-all font-data text-[10px] text-muted-foreground">{release.commitSha}</p>
                      <p className="mt-1 text-xs text-muted-foreground">{release.sourceRepository} · {release.sourceBranch}</p>
                    </div>
                    <StatusIndicator variant="badge" tone={release.current ? "success" : release.promotionOpen ? "warning" : "info"}>
                      {release.current ? "Current" : release.promotionOpen ? "Promotion open" : "Eligible"}
                    </StatusIndicator>
                  </div>
                  <DefinitionList
                    columns={2}
                    className="mt-4"
                    items={[
                      { label: "Artifact SHA-256", value: release.artifactDigest, mono: true },
                      { label: "Eligible since", value: formatTimestamp(release.eligibleAt) },
                      {
                        label: "CI",
                        value: <WorkflowLink href={release.ciWorkflowRunUrl}>Passed · run {release.ciWorkflowRunId}</WorkflowLink>,
                      },
                      {
                        label: "Security",
                        value: <WorkflowLink href={release.securityWorkflowRunUrl}>Passed · run {release.securityWorkflowRunId}</WorkflowLink>,
                      },
                      {
                        label: "Immutable artifact",
                        value: <WorkflowLink href={release.artifactWorkflowRunUrl}>Run {release.artifactWorkflowRunId}</WorkflowLink>,
                      },
                    ]}
                  />
                  <div className="mt-4 flex items-center justify-between gap-3">
                    <p className="text-xs leading-5 text-muted-foreground">Requesting does not start GitHub Actions.</p>
                    <Button
                      type="button"
                      size="sm"
                      disabled={unavailable || !overview?.actor?.canRequest}
                      onClick={() => setRequestRelease(release)}
                    >
                      Request promotion
                    </Button>
                  </div>
                </article>
              );
            })}
          </div>
        )}
      </SectionCard>

      <SectionCard
        title="Promotion requests"
        description="A separate, reauthenticated platform administrator must approve every production request."
      >
        {(overview?.promotionRequests || []).length === 0 ? (
          <EmptyState
            icon={CheckCircle2}
            title="No promotion requests recorded"
            description="Request history and its audit identifiers will appear here."
            compact
          />
        ) : (
          <DataTableShell ariaLabel="Release promotion requests" minWidth="980px">
            <thead>
              <tr>
                <th scope="col">Release</th>
                <th scope="col">Status</th>
                <th scope="col">Requested by</th>
                <th scope="col">Requested</th>
                <th scope="col">Approved by</th>
                <th scope="col">Action</th>
              </tr>
            </thead>
            <tbody>
              {overview.promotionRequests.map((request) => {
                const ownRequest = request.requestedBy === overview.actor?.userId;
                const canApprove = request.status === "pending_approval"
                  && overview.actor?.canApprove
                  && !ownRequest;
                return (
                  <tr key={request.promotionRequestId}>
                    <td>
                      <code className="font-data text-xs">{request.commitSha?.slice(0, 12)}</code>
                      <p className="mt-1 font-data text-[10px] text-muted-foreground">{request.promotionRequestId.slice(0, 8)}</p>
                    </td>
                    <td>
                      <StatusIndicator variant="badge" tone={requestTone(request.status)}>
                        {formatEnumLabel(request.status)}
                      </StatusIndicator>
                    </td>
                    <td className="font-data text-xs">{request.requestedBy}</td>
                    <td>{formatTimestamp(request.requestedAt)}</td>
                    <td className="font-data text-xs">{request.approvedBy || "Awaiting second administrator"}</td>
                    <td>
                      {request.status === "pending_approval" ? (
                        <Button
                          type="button"
                          size="sm"
                          variant={canApprove ? "default" : "outline"}
                          disabled={!canApprove}
                          title={ownRequest ? "The requester cannot approve their own production promotion." : undefined}
                          onClick={() => setApprovalRequest(request)}
                        >
                          {ownRequest ? "Second approver required" : "Approve"}
                        </Button>
                      ) : request.status === "approved" ? (
                        <span className="text-xs text-muted-foreground">Ready for GitHub Actions</span>
                      ) : (
                        <span className="text-xs text-muted-foreground">No action available</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </DataTableShell>
        )}
      </SectionCard>

      {requestRelease ? (
        <StepUpDialog
          title={`Request ${requestRelease.commitSha.slice(0, 12)} for production`}
          description="This records a pending request only. It neither deploys code nor changes production configuration."
          confirmation={requestRelease.requestConfirmation}
          reasonRequired
          submitting={submitting}
          onClose={() => setRequestRelease(null)}
          onSubmit={requestPromotion}
        />
      ) : null}

      {approvalRequest ? (
        <StepUpDialog
          title={`Approve request ${approvalRequest.promotionRequestId.slice(0, 8)}`}
          description="Your identity must differ from the requester. Approval authorises GitHub Actions to consume this exact commit and artifact."
          confirmation={approvalRequest.approvalConfirmation}
          submitting={submitting}
          onClose={() => setApprovalRequest(null)}
          onSubmit={approvePromotion}
        />
      ) : null}
    </div>
  );
}
