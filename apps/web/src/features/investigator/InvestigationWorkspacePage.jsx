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
import { GovernedCaseActionPanel } from "./GovernedCaseActionPanel";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";

function fileAsBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("The evidence file could not be read."));
    reader.onload = () => {
      const value = String(reader.result || "");
      const separator = value.indexOf(",");
      if (separator < 0) reject(new Error("The evidence file could not be encoded."));
      else resolve(value.slice(separator + 1));
    };
    reader.readAsDataURL(file);
  });
}

function evidenceContentType(file) {
  const extension = String(file?.name || "").split(".").pop()?.toLowerCase();
  return ({ pdf: "application/pdf", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", txt: "text/plain", csv: "text/csv" })[extension] || file?.type || "application/octet-stream";
}

export function InvestigationWorkspacePage() {
  const { investigationId } = useParams();
  const { identity } = useRole();
  const [state, setState] = useState({ status: "loading", investigation: null, error: null });
  const [noteText, setNoteText] = useState("");
  const [evidenceForm, setEvidenceForm] = useState({ file: null, description: "", evidenceType: "" });
  const [fileInputKey, setFileInputKey] = useState(0);
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

  async function callLegacySupportedAction(path, body, method = "POST") {
    setActionMessage(null);
    try {
      const versioned = path.startsWith(`/investigations/${encodeURIComponent(investigationId)}`);
      const response = await apiRequest(path, {
        method,
        headers: {
          "content-type": "application/json",
          ...(versioned ? { "if-match": `W/\"investigation-${state.investigation?.recordVersion || 1}\"` } : {}),
        },
        body: JSON.stringify(body),
      });
      const json = await response.json();
      if (!response.ok || json.available === false) {
        setActionMessage({ tone: "error", text: json.message || "Action failed." });
        return false;
      }
      setActionMessage({ tone: "success", text: "The investigation record was updated." });
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
  const canChangePriority = hasCapability(identity, "investigations.change_priority");
  const canAddNote = hasCapability(identity, "investigations.add_note");
  const canUploadEvidence = hasCapability(identity, "investigations.upload_evidence");
  const tenantLabel = identity.tenantLabel || identity.tenantId || "active scheme";

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
        <MetricPill key="historical-status" label="Historical status" value={investigation.status} />,
        <MetricPill key="priority" label="Priority" value={investigation.priority} />,
      ].filter(Boolean)}
    >
      {actionMessage ? (
        <WorkspaceNotice title={actionMessage.tone === "error" ? "Action failed" : "Investigation updated"} tone={actionMessage.tone === "error" ? "danger" : "success"}>
          {actionMessage.text}
        </WorkspaceNotice>
      ) : null}

      <GovernedCaseActionPanel
        legacyInvestigationId={investigation.investigationId}
        historicalStatus={investigation.status}
      />

      <div className="grid gap-4 xl:grid-cols-[1.4fr_1fr]">
        <SectionCard title="Legacy compatibility details" description="Assignment, priority, and historical status remain available without controlling the governed lifecycle.">
          <div className="grid gap-3 md:grid-cols-3">
            <div className="rounded-xl border border-border/70 px-4 py-3">
              <p className="text-xs uppercase tracking-[0.16em] text-muted-foreground">Assigned investigator</p>
              <p className="mt-1 text-sm font-semibold">{investigation.assignedInvestigator || "Unassigned"}</p>
            </div>
            <div className="rounded-xl border border-border/70 px-4 py-3">
              <p className="text-xs uppercase tracking-[0.16em] text-muted-foreground">Assigned by</p>
              <p className="mt-1 text-sm font-semibold">{investigation.assignedBy || "Not recorded"}</p>
            </div>
            <div className="rounded-xl border border-border/70 px-4 py-3">
              <p className="text-xs uppercase tracking-[0.16em] text-muted-foreground">Historical status</p>
              <p className="mt-1 text-sm font-semibold">{formatEnumLabel(investigation.status)}</p>
              <p className="mt-1 text-xs text-muted-foreground">Read-only audit data</p>
            </div>
          </div>

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
                    onClick={() => callLegacySupportedAction(`/investigations/${investigation.investigationId}`, { priority: option }, "PATCH")}
                  >
                    {formatEnumLabel(option)}
                  </Button>
                ))}
              </div>
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
                    {item.contentSha256 ? <p className="mt-1 font-data text-xs text-muted-foreground">{item.byteSize} bytes · SHA-256 {item.contentSha256.slice(0, 16)}…</p> : null}
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
                const ok = await callLegacySupportedAction(`/investigations/${investigation.investigationId}/notes`, {
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
        <SectionCard title="Upload evidence" description="Files are validated, hashed, and stored in private tenant-scoped evidence storage.">
          <div className="grid gap-3 md:grid-cols-3">
            <FormField label="Evidence file" htmlFor="evidence-file" hint="PDF, PNG, JPEG, TXT, or CSV; maximum 10 MB.">
              <Input key={fileInputKey} id="evidence-file" type="file" accept=".pdf,.png,.jpg,.jpeg,.txt,.csv" onChange={(event) => setEvidenceForm((previous) => ({ ...previous, file: event.target.files?.[0] || null }))} />
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
            disabled={!evidenceForm.file || evidenceForm.file.size > 10 * 1024 * 1024 || !evidenceForm.evidenceType.trim()}
            onClick={async () => {
              const contentBase64 = await fileAsBase64(evidenceForm.file);
              const ok = await callLegacySupportedAction(`/investigations/${investigation.investigationId}/evidence`, {
                filename: evidenceForm.file.name,
                description: evidenceForm.description || null,
                evidenceType: evidenceForm.evidenceType,
                contentType: evidenceContentType(evidenceForm.file),
                contentBase64,
              });
              if (ok) {
                setEvidenceForm({ file: null, description: "", evidenceType: "" });
                setFileInputKey((value) => value + 1);
              }
            }}
          >
            Upload evidence
          </Button>
        </SectionCard>
      )}
    </PageFrame>
  );
}
