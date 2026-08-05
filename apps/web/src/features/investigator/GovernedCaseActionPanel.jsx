import React, { useCallback, useEffect, useMemo, useState } from "react";

import { apiRequest } from "../../lib/apiClient";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import {
  FormField,
  SectionCard,
  StatusIndicator,
  WorkspaceNotice,
  formatEnumLabel,
} from "./InvestigatorUI";

const DEFERRED_ACTIONS = new Set([
  "activate-network-notice",
  "publish-registry",
  "network-notice-active",
  "correct-or-withdraw",
  "expire-or-supersede",
]);

function idempotencyKey() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return `case-action-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function references(value) {
  return String(value || "")
    .split(/[\n,]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function actionPayload(action, form, stateVersion) {
  const payload = {
    expectedStateVersion: stateVersion,
    reasonCode: form.reasonCode.trim(),
    reasonSummary: form.reasonSummary.trim(),
  };
  const evidenceReferences = references(form.evidenceReferences);
  const processCheckReferences = references(form.processCheckReferences);
  if (evidenceReferences.length) payload.evidenceReferences = evidenceReferences;
  if (processCheckReferences.length) payload.processCheckReferences = processCheckReferences;

  if (action === "open-investigation" && form.assignedInvestigatorId.trim()) {
    payload.assignedInvestigatorId = form.assignedInvestigatorId.trim();
  }
  if (action === "complete-investigation-report") {
    if (form.reportReference.trim()) payload.reportReference = form.reportReference.trim();
    if (form.noEvidenceReason.trim()) payload.noEvidenceReason = form.noEvidenceReason.trim();
    payload.completionReason = form.completionReason.trim();
  }
  if (action === "approve-outcome") {
    payload.outcomeCode = form.outcomeCode.trim();
    payload.recordedReasons = references(form.recordedReasons);
    payload.identityMatchReviewResult = {
      reviewed: true,
      resultCode: form.identityResultCode.trim(),
      reviewReference: form.identityReviewReference.trim(),
      ...(form.identitySummary.trim() ? { summary: form.identitySummary.trim() } : {}),
    };
    payload.supportingReportReference = form.supportingReportReference.trim();
    payload.evidenceSetReference = form.evidenceSetReference.trim();
    payload.processCheckComplete = true;
  }
  return payload;
}

function initialForm() {
  return {
    reasonCode: "REVIEWED_ACTION",
    reasonSummary: "",
    evidenceReferences: "",
    processCheckReferences: "",
    assignedInvestigatorId: "",
    reportReference: "",
    noEvidenceReason: "",
    completionReason: "REPORT_COMPLETE",
    outcomeCode: "",
    recordedReasons: "",
    identityResultCode: "REVIEWED_MATCH",
    identityReviewReference: "",
    identitySummary: "",
    supportingReportReference: "",
    evidenceSetReference: "",
  };
}

export function GovernedCaseActionPanel({ legacyInvestigationId, historicalStatus }) {
  const [detail, setDetail] = useState({ status: "loading", case: null, allowedActions: [], error: null });
  const [selectedAction, setSelectedAction] = useState("");
  const [form, setForm] = useState(initialForm);
  const [message, setMessage] = useState(null);
  const [submitting, setSubmitting] = useState(false);

  const load = useCallback(async ({ preserveMessage = false } = {}) => {
    if (!preserveMessage) setMessage(null);
    setDetail((previous) => ({ ...previous, status: "loading" }));
    try {
      const response = await apiRequest(`/api/v1/cases/by-legacy-investigation/${encodeURIComponent(legacyInvestigationId)}`);
      const body = await response.json();
      if (!response.ok || !body.available) {
        setDetail({ status: "error", case: null, allowedActions: [], error: body.message || "Governed case unavailable." });
        return;
      }
      const safeActions = Array.isArray(body.allowedActions)
        ? body.allowedActions.filter((action) => typeof action === "string" && !DEFERRED_ACTIONS.has(action))
        : [];
      setDetail({ status: "ready", case: body.case, allowedActions: safeActions, error: null });
      setSelectedAction((current) => safeActions.includes(current) ? current : (safeActions[0] || ""));
    } catch (error) {
      setDetail({ status: "error", case: null, allowedActions: [], error: error.message || "Governed case request failed." });
    }
  }, [legacyInvestigationId]);

  useEffect(() => {
    load();
  }, [load]);

  const requiresProcessChecks = ["submit-outcome-review", "approve-outcome"].includes(selectedAction);
  const formValid = useMemo(() => {
    if (!selectedAction || !detail.case || !form.reasonCode.trim() || !form.reasonSummary.trim()) return false;
    if (selectedAction === "complete-investigation-report") {
      return Boolean(form.completionReason.trim()
        && form.reportReference.trim()
        && (references(form.evidenceReferences).length || form.noEvidenceReason.trim()));
    }
    if (selectedAction === "submit-outcome-review") return references(form.processCheckReferences).length > 0;
    if (selectedAction === "approve-outcome") {
      return Boolean(
        form.outcomeCode.trim()
        && references(form.recordedReasons).length
        && form.identityResultCode.trim()
        && form.identityReviewReference.trim()
        && form.supportingReportReference.trim()
        && form.evidenceSetReference.trim()
        && references(form.processCheckReferences).length
      );
    }
    return true;
  }, [detail.case, form, selectedAction]);

  async function submit() {
    if (!formValid || !detail.case) return;
    setSubmitting(true);
    setMessage(null);
    try {
      const response = await apiRequest(
        `/api/v1/cases/${encodeURIComponent(detail.case.caseId)}/actions/${encodeURIComponent(selectedAction)}`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "idempotency-key": idempotencyKey(),
          },
          body: JSON.stringify(actionPayload(selectedAction, form, detail.case.stateVersion)),
        },
      );
      const body = await response.json();
      if (response.status === 409 && body.code === "CASE_STATE_VERSION_CONFLICT") {
        setMessage({ tone: "warning", text: "The case changed after it was loaded. The authoritative case has been refreshed; review it before deciding again." });
        await load({ preserveMessage: true });
        return;
      }
      if (!response.ok) {
        setMessage({ tone: "danger", text: body.message || "The governed action was rejected." });
        return;
      }
      setMessage({ tone: "success", text: body.replayed ? "The original governed action result was returned." : "The governed action was recorded." });
      setForm(initialForm());
      await load({ preserveMessage: true });
    } catch (error) {
      setMessage({ tone: "danger", text: error.message || "The governed action request failed." });
    } finally {
      setSubmitting(false);
    }
  }

  if (detail.status === "loading" && !detail.case) {
    return <SectionCard title="Governed case" description="Resolving the authoritative Sequrin case..." />;
  }

  if (detail.status === "error") {
    return (
      <SectionCard title="Governed case unavailable" description={detail.error}>
        <Button variant="outline" onClick={() => load()}>Retry</Button>
      </SectionCard>
    );
  }

  return (
    <SectionCard
      title="Governed case"
      description="The server is authoritative for case state and available actions. Historical investigation status remains read-only audit data."
    >
      {message ? (
        <WorkspaceNotice title={message.tone === "success" ? "Case updated" : "Case action not applied"} tone={message.tone}>
          {message.text}
        </WorkspaceNotice>
      ) : null}

      <div className="mt-3 grid gap-3 md:grid-cols-3">
        <div className="rounded-xl border border-border/70 px-4 py-3">
          <p className="text-xs uppercase tracking-[0.16em] text-muted-foreground">Governed state</p>
          <div className="mt-2"><StatusIndicator variant="badge">{detail.case.currentState}</StatusIndicator></div>
        </div>
        <div className="rounded-xl border border-border/70 px-4 py-3">
          <p className="text-xs uppercase tracking-[0.16em] text-muted-foreground">State version</p>
          <p className="mt-1 font-data text-sm font-semibold">{detail.case.stateVersion}</p>
        </div>
        <div className="rounded-xl border border-border/70 px-4 py-3">
          <p className="text-xs uppercase tracking-[0.16em] text-muted-foreground">Historical status</p>
          <p className="mt-1 text-sm font-semibold">{formatEnumLabel(historicalStatus || detail.case.legacyStatus || "Not recorded")}</p>
          <p className="mt-1 text-xs text-muted-foreground">Read-only compatibility data</p>
        </div>
      </div>

      {detail.allowedActions.length === 0 ? (
        <p className="mt-4 text-sm text-muted-foreground">No governed actions are currently authorised for this actor and case state.</p>
      ) : (
        <div className="mt-4 space-y-4 rounded-xl border border-border/70 p-4">
          <FormField label="Server-authorised action" htmlFor="governed-case-action">
            <select
              id="governed-case-action"
              value={selectedAction}
              onChange={(event) => setSelectedAction(event.target.value)}
              className="h-9 rounded-md border border-input bg-background px-3 text-sm"
            >
              {detail.allowedActions.map((action) => <option key={action} value={action}>{formatEnumLabel(action)}</option>)}
            </select>
          </FormField>

          <div className="grid gap-3 md:grid-cols-2">
            <FormField label="Reason code" htmlFor="case-reason-code">
              <Input id="case-reason-code" value={form.reasonCode} onChange={(event) => setForm((value) => ({ ...value, reasonCode: event.target.value }))} />
            </FormField>
            <FormField label="Reason summary" htmlFor="case-reason-summary">
              <Input id="case-reason-summary" value={form.reasonSummary} onChange={(event) => setForm((value) => ({ ...value, reasonSummary: event.target.value }))} placeholder="Explain the governed decision." />
            </FormField>
          </div>

          {selectedAction === "open-investigation" ? (
            <FormField label="Assigned investigator ID" htmlFor="case-assignee">
              <Input id="case-assignee" value={form.assignedInvestigatorId} onChange={(event) => setForm((value) => ({ ...value, assignedInvestigatorId: event.target.value }))} />
            </FormField>
          ) : null}

          {["complete-investigation-report", "submit-outcome-review", "approve-outcome"].includes(selectedAction) ? (
            <div className="grid gap-3 md:grid-cols-2">
              <FormField label="Evidence references" htmlFor="case-evidence-references" hint="Comma- or line-separated persisted references.">
                <Input id="case-evidence-references" value={form.evidenceReferences} onChange={(event) => setForm((value) => ({ ...value, evidenceReferences: event.target.value }))} />
              </FormField>
              <FormField label="Process-check references" htmlFor="case-process-references" hint={requiresProcessChecks ? "Required for this action." : undefined}>
                <Input id="case-process-references" value={form.processCheckReferences} onChange={(event) => setForm((value) => ({ ...value, processCheckReferences: event.target.value }))} />
              </FormField>
            </div>
          ) : null}

          {selectedAction === "complete-investigation-report" ? (
            <div className="grid gap-3 md:grid-cols-3">
              <FormField label="Report reference" htmlFor="case-report-reference"><Input id="case-report-reference" value={form.reportReference} onChange={(event) => setForm((value) => ({ ...value, reportReference: event.target.value }))} /></FormField>
              <FormField label="No-evidence reason" htmlFor="case-no-evidence"><Input id="case-no-evidence" value={form.noEvidenceReason} onChange={(event) => setForm((value) => ({ ...value, noEvidenceReason: event.target.value }))} /></FormField>
              <FormField label="Completion reason" htmlFor="case-completion-reason"><Input id="case-completion-reason" value={form.completionReason} onChange={(event) => setForm((value) => ({ ...value, completionReason: event.target.value }))} /></FormField>
            </div>
          ) : null}

          {selectedAction === "approve-outcome" ? (
            <div className="grid gap-3 md:grid-cols-2">
              <FormField label="Configured outcome code" htmlFor="case-outcome-code"><Input id="case-outcome-code" value={form.outcomeCode} onChange={(event) => setForm((value) => ({ ...value, outcomeCode: event.target.value }))} /></FormField>
              <FormField label="Recorded reasons" htmlFor="case-recorded-reasons"><Input id="case-recorded-reasons" value={form.recordedReasons} onChange={(event) => setForm((value) => ({ ...value, recordedReasons: event.target.value }))} /></FormField>
              <FormField label="Identity result code" htmlFor="case-identity-result"><Input id="case-identity-result" value={form.identityResultCode} onChange={(event) => setForm((value) => ({ ...value, identityResultCode: event.target.value }))} /></FormField>
              <FormField label="Identity review reference" htmlFor="case-identity-reference"><Input id="case-identity-reference" value={form.identityReviewReference} onChange={(event) => setForm((value) => ({ ...value, identityReviewReference: event.target.value }))} /></FormField>
              <FormField label="Supporting report reference" htmlFor="case-supporting-report"><Input id="case-supporting-report" value={form.supportingReportReference} onChange={(event) => setForm((value) => ({ ...value, supportingReportReference: event.target.value }))} /></FormField>
              <FormField label="Evidence-set reference" htmlFor="case-evidence-set"><Input id="case-evidence-set" value={form.evidenceSetReference} onChange={(event) => setForm((value) => ({ ...value, evidenceSetReference: event.target.value }))} /></FormField>
            </div>
          ) : null}

          <div className="flex flex-wrap items-center gap-3">
            <Button disabled={!formValid || submitting} onClick={submit}>{submitting ? "Applying..." : "Apply governed action"}</Button>
            <Button variant="outline" disabled={submitting} onClick={() => load()}>Refresh case</Button>
            <p className="text-xs text-muted-foreground">Outcome approval remains separate from registry publication.</p>
          </div>
        </div>
      )}
    </SectionCard>
  );
}
