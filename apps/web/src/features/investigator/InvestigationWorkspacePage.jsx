import React, { useCallback, useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { useRole } from "../../context/RoleContext";
import { CLAIMGUARD_ROLES } from "../../lib/claimguardRoles";
import { PageFrame, SectionCard, MetricPill, StatusIndicator } from "./InvestigatorUI";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";

const STATUS_OPTIONS = ["OPEN", "UNDER_REVIEW", "AWAITING_EVIDENCE", "CONFIRMED_FRAUD", "NO_FRAUD_FOUND", "CLOSED"];

// UI-only convenience gating. The API independently enforces every one of
// these actions via authorization-policy.js and will 401/403 regardless.
const canConfirmOrReverse = (role) => role === CLAIMGUARD_ROLES.INVESTIGATOR;
const canUpdateStatus = (role) => role === CLAIMGUARD_ROLES.INVESTIGATOR;
const canChangePriority = (role) => role === CLAIMGUARD_ROLES.INVESTIGATOR || role === CLAIMGUARD_ROLES.FRAUD_ANALYST;
const canAddNote = (role) => role === CLAIMGUARD_ROLES.INVESTIGATOR || role === CLAIMGUARD_ROLES.FRAUD_ANALYST;
const canUploadEvidence = (role) => role === CLAIMGUARD_ROLES.INVESTIGATOR;

export function InvestigationWorkspacePage() {
  const { investigationId } = useParams();
  const { authHeaders, identity } = useRole();
  const [state, setState] = useState({ status: "loading", investigation: null, error: null });
  const [noteText, setNoteText] = useState("");
  const [evidenceForm, setEvidenceForm] = useState({ filename: "", description: "", evidenceType: "" });
  const [actionMessage, setActionMessage] = useState(null);

  const load = useCallback(async () => {
    setState((prev) => ({ ...prev, status: "loading" }));
    try {
      const response = await fetch(`/api/investigations/${encodeURIComponent(investigationId)}`, { headers: authHeaders });
      const json = await response.json();
      if (!response.ok || !json.available) {
        setState({ status: "error", investigation: null, error: json.message || "Investigation unavailable." });
        return;
      }
      setState({ status: "ready", investigation: json.investigation, error: null });
    } catch (error) {
      setState({ status: "error", investigation: null, error: error.message || "Request failed." });
    }
  }, [investigationId, authHeaders]);

  useEffect(() => {
    load();
  }, [load]);

  async function callAction(path, body, method = "POST") {
    setActionMessage(null);
    try {
      const response = await fetch(`/api${path}`, {
        method,
        headers: { "content-type": "application/json", ...authHeaders },
        body: JSON.stringify(body),
      });
      const json = await response.json();
      if (!response.ok || json.available === false) {
        setActionMessage({ tone: "error", text: json.message || "Action failed." });
        return false;
      }
      setActionMessage({ tone: "success", text: "Updated." });
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

  return (
    <PageFrame
      eyebrow="Investigation Workspace"
      title={investigation.investigationId}
      description={`Claim ${investigation.claimId} · tenant ${investigation.tenantId}`}
      actions={[
        <MetricPill key="status" label="Status" value={investigation.status} />,
        <MetricPill key="priority" label="Priority" value={investigation.priority} />,
      ]}
    >
      {actionMessage && (
        <div className={`rounded-xl border px-4 py-3 text-sm ${actionMessage.tone === "error" ? "border-destructive/40 text-destructive" : "border-emerald-500/40 text-emerald-600"}`}>
          {actionMessage.text}
        </div>
      )}

      <div className="grid gap-4 xl:grid-cols-[1.4fr_1fr]">
        <SectionCard title="Case details" description="Assignment, status, and priority for this investigation.">
          <div className="grid gap-3 md:grid-cols-2">
            <div className="rounded-xl border border-border/70 px-4 py-3">
              <p className="text-xs uppercase tracking-[0.16em] text-muted-foreground">Assigned investigator</p>
              <p className="mt-1 text-sm font-semibold">{investigation.assignedInvestigator || "Unassigned"}</p>
            </div>
            <div className="rounded-xl border border-border/70 px-4 py-3">
              <p className="text-xs uppercase tracking-[0.16em] text-muted-foreground">Assigned by</p>
              <p className="mt-1 text-sm font-semibold">{investigation.assignedBy}</p>
            </div>
          </div>

          {canUpdateStatus(identity.role) && (
            <div className="mt-4 rounded-xl border border-border/70 p-4">
              <p className="text-xs uppercase tracking-[0.16em] text-muted-foreground">Update status</p>
              <div className="mt-2 flex flex-wrap gap-2">
                {STATUS_OPTIONS.map((option) => (
                  <Button
                    key={option}
                    size="sm"
                    variant={option === investigation.status ? "default" : "outline"}
                    onClick={() => callAction(`/investigations/${investigation.investigationId}`, { status: option }, "PATCH")}
                  >
                    {option.replace(/_/g, " ")}
                  </Button>
                ))}
              </div>
            </div>
          )}

          {canChangePriority(identity.role) && (
            <div className="mt-4 rounded-xl border border-border/70 p-4">
              <p className="text-xs uppercase tracking-[0.16em] text-muted-foreground">Change priority</p>
              <div className="mt-2 flex flex-wrap gap-2">
                {["LOW", "NORMAL", "HIGH", "CRITICAL"].map((option) => (
                  <Button
                    key={option}
                    size="sm"
                    variant={option === investigation.priority ? "default" : "outline"}
                    onClick={() => callAction(`/investigations/${investigation.investigationId}`, { priority: option }, "PATCH")}
                  >
                    {option}
                  </Button>
                ))}
              </div>
            </div>
          )}

          {canConfirmOrReverse(identity.role) && (
            <div className="mt-4 flex flex-wrap gap-3">
              <Button
                variant="destructive"
                onClick={() =>
                  callAction("/investigations/confirm-fraud", {
                    investigationId: investigation.investigationId,
                    claimId: investigation.claimId,
                    investigatorId: identity.userId,
                    reason: "Confirmed via investigator workspace.",
                  })
                }
              >
                Confirm fraud
              </Button>
              <Button
                variant="outline"
                onClick={() =>
                  callAction("/investigations/reverse-fraud", {
                    investigationId: investigation.investigationId,
                    claimId: investigation.claimId,
                    investigatorId: identity.userId,
                    reason: "Reversed via investigator workspace.",
                  })
                }
              >
                Reverse fraud finding
              </Button>
            </div>
          )}
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

      {canAddNote(identity.role) && (
        <SectionCard title="Add note" description="Attach an investigation note.">
          <div className="flex flex-col gap-3">
            <textarea
              value={noteText}
              onChange={(e) => setNoteText(e.target.value)}
              className="min-h-[90px] rounded-md border border-border bg-background p-3 text-sm"
              placeholder="Describe the finding..."
            />
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

      {canUploadEvidence(identity.role) && (
        <SectionCard title="Register evidence" description="Record evidence metadata (no file upload — filename and description only).">
          <div className="grid gap-3 md:grid-cols-3">
            <Input placeholder="filename.pdf" value={evidenceForm.filename} onChange={(e) => setEvidenceForm((prev) => ({ ...prev, filename: e.target.value }))} />
            <Input placeholder="description" value={evidenceForm.description} onChange={(e) => setEvidenceForm((prev) => ({ ...prev, description: e.target.value }))} />
            <Input placeholder="evidence type" value={evidenceForm.evidenceType} onChange={(e) => setEvidenceForm((prev) => ({ ...prev, evidenceType: e.target.value }))} />
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
            Register evidence
          </Button>
        </SectionCard>
      )}
    </PageFrame>
  );
}