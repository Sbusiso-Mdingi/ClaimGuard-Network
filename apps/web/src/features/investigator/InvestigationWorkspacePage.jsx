import React, { useCallback, useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useRole } from "../../context/RoleContext";
import { apiRequest } from "../../lib/apiClient";
import { hasCapability } from "../../lib/capabilities";
import {
  FormField,
  PageFrame,
  SectionCard,
  MetricPill,
  StatusIndicator,
  WorkspaceNotice,
  formatEnumLabel,
} from "./InvestigatorUI";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";

const NEXT_STATUS_OPTIONS = Object.freeze({
  OPEN: ["UNDER_REVIEW", "AWAITING_EVIDENCE", "CLOSED"],
  UNDER_REVIEW: ["AWAITING_EVIDENCE", "CONFIRMED_FRAUD", "NO_FRAUD_FOUND", "CLOSED"],
  AWAITING_EVIDENCE: ["UNDER_REVIEW", "CLOSED"],
  CONFIRMED_FRAUD: ["CLOSED"],
  REVERSED: ["CLOSED"],
  NO_FRAUD_FOUND: ["CLOSED"],
  CLOSED: [],
});

export function InvestigationWorkspacePage() {
  const { investigationId } = useParams();
  const { identity } = useRole();
  const [state, setState] = useState({ status: "loading", investigation: null, error: null });
  const [noteText, setNoteText] = useState("");
  const [evidenceForm, setEvidenceForm] = useState({ filename: "", description: "", evidenceType: "" });
  const [decisionReason, setDecisionReason] = useState("");
  const [actionMessage, setActionMessage] = useState(null);

  const load = useCallback(async () => {
    setState((prev) => ({ ...prev, status: "loading" }));
    try {
      const response = await apiRequest(`/investigations/${encodeURIComponent(investigationId)}`);
      const json = await response.json();
      if (!response.ok || !json.available) {
        setState({ status: "error", investigation: null, error: json.message || "Investigation unavailable." });
        return;
      }
      setState({ status: "ready", investigation: json.investigation, error: null });
    } catch (error) {
      setState({ status: "error", investigation: null, error: error.message || "Request failed." });
    }
  }, [investigationId]);

  useEffect(() => {
    load();
  }, [load]);

  async function callAction(path, body, method = "POST") {
    setActionMessage(null);
    try {
      const response = await apiRequest(path, {
        method,
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const json = await response.json();
      if (!response.ok || json.available === false) {
        setActionMessage({ tone: "error", text: json.message || "Action failed." });
        return false;
      }
      setActionMessage({ tone: "success", text: "The investigation was updated." });
      await load();
      return true;
    } catch (error) {
      setActionMessage({ tone: "error", text: error.message || "Request failed." });
      return false;
    }
  }

  if (state.status === "loading") {
    return <SectionCard title="Loading investigation" description="Fetching investigation details..." />;
  }

  if (state.status === "error") {
    return (
      <SectionCard title="Investigation unavailable" description={state.error}>
        <Button variant="outline" onClick={load}>Retry</Button>
      </SectionCard>
    );
  }

  const investigation = state.investigation;
  const canUpdateStatus = hasCapability(identity, "investigations.update_status");
  const canChangePriority = hasCapability(identity, "investigations.change_priority");
  const canAddNote = hasCapability(identity, "investigations.add_note");
  const canUploadEvidence = hasCapability(identity, "investigations.upload_evidence");
  const canConfirmFraud = hasCapability(identity, "investigations.confirm_fraud")
    && investigation.status === "CONFIRMED_FRAUD"
    && !investigation.fraudConfirmedAt;
  const canReverseFraud = hasCapability(identity, "investigations.confirm_fraud")
    && Boolean(investigation.fraudConfirmedAt)
    && !investigation.reversedAt;
  const nextStatuses = NEXT_STATUS_OPTIONS[investigation.status] || [];
  const tenantLabel = identity.tenantLabel || identity.tenantId || "active scheme";
  const canonicalDecisionReason = decisionReason.trim();

  return (
    <PageFrame
      eyebrow="Investigation Workspace"
      title={investigation.investigationId}
      description={`Claim ${investigation.claimId} · ${tenantLabel}`}
      actions={[
        hasCapability(identity, "claims.view_own") ? (
          <Link key="claim" to={`/claims/${encodeURIComponent(investigation.claimId)}`} className="text-sm font-semibold text-primary hover:underline">
            Open claim
          </Link>
        ) : null,
        <MetricPill key="status" label="Status" value={investigation.status} />,
        <MetricPill key="priority" label="Priority" value={investigation.priority} />,
      ].filter(Boolean)}
    >
      {actionMessage ? (
        <WorkspaceNotice title={actionMessage.tone === "error" ? "Action failed" : "Investigation updated"} tone={actionMessage.tone === "error" ? "danger" : "success"}>
          {actionMessage.text}
        </WorkspaceNotice>
      ) : null}

      <div className="grid gap-4 xl:grid-cols-[1.4fr_1fr]">
        <SectionCard title="Case details" description="Assignment, status, and priority for this investigation.">
          <div className="grid gap-3 md:grid-cols-2">
            <div className="rounded-xl border border-border/70 px-4 py-3">
              <p className="text-xs uppercase tracking-[0.16em] text-muted-foreground">Assigned investigator</p>
              <p className="mt-1 text-sm font-semibold">{investigation.assignedInvestigator || "Unassigned"}</p>
            </div>
            <div className="rounded-xl border border-border/70 px-4 py-3">
              <p className="text-xs uppercase tracking-[0.16em] text-muted-foreground">Assigned by</p>
              <p className="mt-1 text-sm font-semibold">{investigation.assignedBy || "Not recorded"}</p>
            </div>
          </div>

          {canUpdateStatus && nextStatuses.length > 0 && (
            <div className="mt-4 rounded-xl border border-border/70 p-4">
              <p className="text-xs uppercase tracking-[0.16em] text-muted-foreground">Update status</p>
              <div className="mt-2 flex flex-wrap gap-2">
                {nextStatuses.map((option) => (
                  <Button
                    key={option}
                    size="sm"
                    variant="outline"
                    onClick={() => callAction(`/investigations/${investigation.investigationId}`, { status: option }, "PATCH")}
                  >
                    {formatEnumLabel(option)}
                  </Button>
                ))}
              </div>
            </div>
          )}

          {canChangePriority && (
            <div className="mt-4 rounded-xl border border-border/70 p-4">
              <p className="text-xs uppercase tracking-[0.16em] text-muted-foreground">Change priority</p>
              <div className="mt-2 flex flex-wrap gap-2">
                {["LOW", "NORMAL", "HIGH", "CRITICAL"].map((option) => (
                  <Button
                    key={option}
                    size="sm"
                    variant={option === investigation.priority ? "default" : "outline"}
                    disabled={option === investigation.priority}
                    onClick={() => callAction(`/investigations/${investigation.investigationId}`, { priority: option }, "PATCH")}
                  >
                    {formatEnumLabel(option)}
                  </Button>
                ))}
              </div>
            </div>
          )}

          {(canConfirmFraud || canReverseFraud) ? (
            <div className="mt-4 space-y-3 rounded-xl border border-rose-500/25 bg-rose-500/5 p-4">
              <FormField
                label={canReverseFraud ? "Reason for reversal" : "Reason for fraud decision"}
                htmlFor="fraud-decision-reason"
                hint="Required for the immutable audit trail. Use specific, non-sensitive case reasoning."
              >
                <textarea
                  id="fraud-decision-reason"
                  value={decisionReason}
                  maxLength={500}
                  onChange={(event) => setDecisionReason(event.target.value)}
                  className="min-h-[96px] rounded-md border border-border bg-background p-3 text-sm"
                  placeholder={canReverseFraud ? "Explain why the confirmed finding must be reversed." : "Summarise the evidence supporting the confirmed fraud decision."}
                />
              </FormField>
              <div className="flex flex-wrap gap-3">
                {canConfirmFraud ? <Button
                  variant="destructive"
                  disabled={!canonicalDecisionReason}
                  onClick={async () => {
                    const updated = await callAction("/investigations/confirm-fraud", {
                      investigationId: investigation.investigationId,
                      claimId: investigation.claimId,
                      reason: canonicalDecisionReason,
                    });
                    if (updated) setDecisionReason("");
                  }}
                >
                  Confirm fraud
                </Button> : null}
                {canReverseFraud ? <Button
                  variant="outline"
                  disabled={!canonicalDecisionReason}
                  onClick={async () => {
                    const updated = await callAction("/investigations/reverse-fraud", {
                      investigationId: investigation.investigationId,
                      claimId: investigation.claimId,
                      reason: canonicalDecisionReason,
                    });
                    if (updated) setDecisionReason("");
                  }}
                >
                  Reverse fraud finding
                </Button> : null}
              </div>
            </div>
          ) : null}
        </SectionCard>

        <SectionCard title="Timeline" description="Notes and evidence recorded against this investigation.">
          <div className="space-y-3">
            {(investigation.notes || []).length === 0 && (investigation.evidence || []).length === 0 ? (
              <p className="text-sm text-muted-foreground">No notes or evidence yet.</p>
            ) : (
              <>
                {(investigation.notes || []).map((note) => (
                  <div key={note.noteId} className="rounded-lg border border-border/70 bg-secondary/30 px-3 py-3 text-sm">
                    <div className="flex items-center justify-between text-xs text-muted-foreground">
                      <span>{note.author}</span>
                      <span>{new Date(note.timestamp).toLocaleString()}</span>
                    </div>
                    <p className="mt-1">{note.text}</p>
                    <StatusIndicator variant="badge">{note.noteType}</StatusIndicator>
                  </div>
                ))}
                {(investigation.evidence || []).map((item) => (
                  <div key={item.evidenceId} className="rounded-lg border border-border/70 bg-secondary/30 px-3 py-3 text-sm">
                    <div className="flex items-center justify-between text-xs text-muted-foreground">
                      <span>{item.uploadedBy}</span>
                      <span>{new Date(item.uploadedAt).toLocaleString()}</span>
                    </div>
                    <p className="mt-1 font-medium">{item.filename}</p>
                    {item.description && <p className="text-muted-foreground">{item.description}</p>}
                    <StatusIndicator variant="badge">{item.evidenceType}</StatusIndicator>
                  </div>
                ))}
              </>
            )}
          </div>
        </SectionCard>
      </div>

      {canAddNote && (
        <SectionCard title="Add note" description="Attach an internal note to the tenant-scoped investigation history.">
          <div className="flex flex-col gap-3">
            <FormField label="Investigation note" htmlFor="investigation-note">
              <textarea
                id="investigation-note"
                value={noteText}
                onChange={(event) => setNoteText(event.target.value)}
                className="min-h-[90px] rounded-md border border-border bg-background p-3 text-sm"
                placeholder="Describe the finding..."
              />
            </FormField>
            <Button
              className="self-start"
              disabled={!noteText.trim()}
              onClick={async () => {
                const ok = await callAction(`/investigations/${investigation.investigationId}/notes`, {
                  text: noteText,
                  noteType: "INTERNAL_NOTE",
                });
                if (ok) setNoteText("");
              }}
            >
              Add note
            </Button>
          </div>
        </SectionCard>
      )}

      {canUploadEvidence && (
        <SectionCard title="Register evidence reference" description="Record evidence metadata. The current workflow does not upload or store the file itself.">
          <div className="grid gap-3 md:grid-cols-3">
            <FormField label="Filename or reference" htmlFor="evidence-filename">
              <Input id="evidence-filename" placeholder="claim-review.pdf" value={evidenceForm.filename} onChange={(event) => setEvidenceForm((previous) => ({ ...previous, filename: event.target.value }))} />
            </FormField>
            <FormField label="Description" htmlFor="evidence-description">
              <Input id="evidence-description" placeholder="What this evidence establishes" value={evidenceForm.description} onChange={(event) => setEvidenceForm((previous) => ({ ...previous, description: event.target.value }))} />
            </FormField>
            <FormField label="Evidence type" htmlFor="evidence-type">
              <select
                id="evidence-type"
                className="h-9 rounded-md border border-input bg-background px-3 text-sm"
                value={evidenceForm.evidenceType}
                onChange={(event) => setEvidenceForm((previous) => ({ ...previous, evidenceType: event.target.value }))}
              >
                <option value="">Choose a type</option>
                {["CLAIM_RECORD", "PROVIDER_RECORD", "MEMBER_STATEMENT", "MEDICAL_REVIEW", "IMAGE", "OTHER"].map((type) => (
                  <option key={type} value={type}>{formatEnumLabel(type)}</option>
                ))}
              </select>
            </FormField>
          </div>
          <Button
            className="mt-3"
            disabled={!evidenceForm.filename.trim() || !evidenceForm.evidenceType.trim()}
            onClick={async () => {
              const ok = await callAction(`/investigations/${investigation.investigationId}/evidence`, {
                filename: evidenceForm.filename,
                description: evidenceForm.description || null,
                evidenceType: evidenceForm.evidenceType,
              });
              if (ok) setEvidenceForm({ filename: "", description: "", evidenceType: "" });
            }}
          >
            Register evidence reference
          </Button>
        </SectionCard>
      )}
    </PageFrame>
  );
}
