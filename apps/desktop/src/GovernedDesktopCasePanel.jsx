import React, { useCallback, useEffect, useMemo, useState } from "react";

import { Button } from "../../web/src/components/ui/button";
import { Input } from "../../web/src/components/ui/input";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../../web/src/components/ui/card";
import { createCaseActionIdempotencyKey, desktopBridge } from "./desktopBridge";

const DEFERRED_ACTIONS = new Set([
  "activate-network-notice",
  "publish-registry",
  "network-notice-active",
  "correct-or-withdraw",
  "expire-or-supersede",
]);

function label(value) {
  return String(value || "")
    .replace(/[-_]+/g, " ")
    .replace(/\b\w/g, (character) => character.toUpperCase());
}

function references(value) {
  return String(value || "")
    .split(/[\n,]/)
    .map((item) => item.trim())
    .filter(Boolean);
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
    payload.reportReference = form.reportReference.trim();
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

export function GovernedDesktopCasePanel({ investigationId, historicalStatus, writesAllowed }) {
  const [detail, setDetail] = useState({ loading: true, case: null, allowedActions: [], error: "" });
  const [selectedAction, setSelectedAction] = useState("");
  const [form, setForm] = useState(initialForm);
  const [submitting, setSubmitting] = useState(false);
  const [notice, setNotice] = useState(null);

  const load = useCallback(async ({ preserveNotice = false } = {}) => {
    if (!preserveNotice) setNotice(null);
    setDetail((previous) => ({ ...previous, loading: true, error: "" }));
    try {
      const result = await desktopBridge.governedCaseDetails(investigationId);
      if (!result?.available || !result.case) throw new Error("Governed case detail is unavailable.");
      const allowedActions = Array.isArray(result.allowedActions)
        ? result.allowedActions.filter((action) => typeof action === "string" && !DEFERRED_ACTIONS.has(action))
        : [];
      setDetail({ loading: false, case: result.case, allowedActions, error: "" });
      setSelectedAction((current) => allowedActions.includes(current) ? current : (allowedActions[0] || ""));
    } catch (error) {
      setDetail({ loading: false, case: null, allowedActions: [], error: error?.message || "Governed case detail is unavailable." });
    }
  }, [investigationId]);

  useEffect(() => {
    if (investigationId) load();
  }, [investigationId, load]);

  const valid = useMemo(() => {
    if (!writesAllowed || !detail.case || !selectedAction || !form.reasonCode.trim() || !form.reasonSummary.trim()) return false;
    if (selectedAction === "complete-investigation-report") {
      return Boolean(form.reportReference.trim() && form.completionReason.trim()
        && (references(form.evidenceReferences).length || form.noEvidenceReason.trim()));
    }
    if (selectedAction === "submit-outcome-review") return references(form.processCheckReferences).length > 0;
    if (selectedAction === "approve-outcome") {
      return Boolean(form.outcomeCode.trim()
        && references(form.recordedReasons).length
        && form.identityResultCode.trim()
        && form.identityReviewReference.trim()
        && form.supportingReportReference.trim()
        && form.evidenceSetReference.trim()
        && references(form.processCheckReferences).length);
    }
    return true;
  }, [detail.case, form, selectedAction, writesAllowed]);

  async function submit() {
    if (!valid || submitting) return;
    setSubmitting(true);
    setNotice(null);
    try {
      const idempotencyKey = createCaseActionIdempotencyKey();
      const result = await desktopBridge.performGovernedCaseAction(
        detail.case.caseId,
        selectedAction,
        idempotencyKey,
        actionPayload(selectedAction, form, detail.case.stateVersion),
      );
      setNotice({ tone: "success", text: result?.replayed ? "The original governed action result was returned." : "The governed action was recorded." });
      setForm(initialForm());
      await load({ preserveNotice: true });
    } catch (error) {
      if (error?.code === "CASE_STATE_VERSION_CONFLICT") {
        setNotice({ tone: "warning", text: "The case changed on the server. Authoritative detail was refreshed; review it before deciding again." });
        await load({ preserveNotice: true });
      } else {
        setNotice({ tone: "danger", text: error?.message || "The governed action was rejected." });
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Card data-testid="governed-desktop-case" className="border-primary/20">
      <CardHeader>
        <CardTitle>Governed case</CardTitle>
        <CardDescription>The server owns case state and authorised actions. Historical investigation status remains read-only.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {detail.loading && !detail.case ? <p role="status" className="text-sm text-muted-foreground">Resolving authoritative case detail…</p> : null}
        {detail.error ? <div role="alert" className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-sm">{detail.error}<div className="mt-3"><Button size="sm" variant="outline" onClick={() => load()}>Retry governed case</Button></div></div> : null}
        {notice ? <div role="status" className="rounded-lg border border-border p-3 text-sm">{notice.text}</div> : null}
        {detail.case ? <>
          <div className="grid gap-3 md:grid-cols-3">
            <div className="rounded-lg border border-border p-3"><p className="text-xs text-muted-foreground">Governed state</p><p className="mt-1 font-semibold">{detail.case.currentState}</p></div>
            <div className="rounded-lg border border-border p-3"><p className="text-xs text-muted-foreground">State version</p><p className="mt-1 font-data font-semibold">{detail.case.stateVersion}</p></div>
            <div className="rounded-lg border border-border p-3"><p className="text-xs text-muted-foreground">Historical status</p><p className="mt-1 font-semibold">{label(historicalStatus || detail.case.legacyStatus || "Not recorded")}</p><p className="mt-1 text-[10px] text-muted-foreground">Read-only compatibility data</p></div>
          </div>
          {detail.case.migrationReviewStatus ? <p className="text-sm text-muted-foreground">Migration review: <strong>{label(detail.case.migrationReviewStatus)}</strong></p> : null}
          {detail.allowedActions.length ? <div className="space-y-3 rounded-xl border border-border p-4">
            <label className="grid gap-2 text-sm font-medium">Server-authorised action<select aria-label="Governed case action" value={selectedAction} onChange={(event) => setSelectedAction(event.target.value)} disabled={submitting || !writesAllowed} className="h-10 rounded-md border border-input bg-background px-3">{detail.allowedActions.map((action) => <option key={action} value={action}>{label(action)}</option>)}</select></label>
            <div className="grid gap-3 md:grid-cols-2"><label className="grid gap-2 text-sm font-medium">Reason code<Input aria-label="Governed reason code" value={form.reasonCode} onChange={(event) => setForm((value) => ({ ...value, reasonCode: event.target.value }))} /></label><label className="grid gap-2 text-sm font-medium">Reason summary<Input aria-label="Governed reason summary" value={form.reasonSummary} onChange={(event) => setForm((value) => ({ ...value, reasonSummary: event.target.value }))} /></label></div>
            {["complete-investigation-report", "submit-outcome-review", "approve-outcome"].includes(selectedAction) ? <div className="grid gap-3 md:grid-cols-2"><label className="grid gap-2 text-sm font-medium">Evidence references<Input aria-label="Governed evidence references" value={form.evidenceReferences} onChange={(event) => setForm((value) => ({ ...value, evidenceReferences: event.target.value }))} /></label><label className="grid gap-2 text-sm font-medium">Process-check references<Input aria-label="Governed process references" value={form.processCheckReferences} onChange={(event) => setForm((value) => ({ ...value, processCheckReferences: event.target.value }))} /></label></div> : null}
            {selectedAction === "open-investigation" ? <label className="grid gap-2 text-sm font-medium">Assigned investigator ID<Input aria-label="Governed assigned investigator" value={form.assignedInvestigatorId} onChange={(event) => setForm((value) => ({ ...value, assignedInvestigatorId: event.target.value }))} /></label> : null}
            {selectedAction === "complete-investigation-report" ? <div className="grid gap-3 md:grid-cols-3"><label className="grid gap-2 text-sm font-medium">Report reference<Input aria-label="Governed report reference" value={form.reportReference} onChange={(event) => setForm((value) => ({ ...value, reportReference: event.target.value }))} /></label><label className="grid gap-2 text-sm font-medium">No-evidence reason<Input aria-label="Governed no-evidence reason" value={form.noEvidenceReason} onChange={(event) => setForm((value) => ({ ...value, noEvidenceReason: event.target.value }))} /></label><label className="grid gap-2 text-sm font-medium">Completion reason<Input aria-label="Governed completion reason" value={form.completionReason} onChange={(event) => setForm((value) => ({ ...value, completionReason: event.target.value }))} /></label></div> : null}
            {selectedAction === "approve-outcome" ? <div className="grid gap-3 md:grid-cols-2"><label className="grid gap-2 text-sm font-medium">Outcome code<Input aria-label="Governed outcome code" value={form.outcomeCode} onChange={(event) => setForm((value) => ({ ...value, outcomeCode: event.target.value }))} /></label><label className="grid gap-2 text-sm font-medium">Recorded reasons<Input aria-label="Governed recorded reasons" value={form.recordedReasons} onChange={(event) => setForm((value) => ({ ...value, recordedReasons: event.target.value }))} /></label><label className="grid gap-2 text-sm font-medium">Identity result code<Input aria-label="Governed identity result" value={form.identityResultCode} onChange={(event) => setForm((value) => ({ ...value, identityResultCode: event.target.value }))} /></label><label className="grid gap-2 text-sm font-medium">Identity review reference<Input aria-label="Governed identity reference" value={form.identityReviewReference} onChange={(event) => setForm((value) => ({ ...value, identityReviewReference: event.target.value }))} /></label><label className="grid gap-2 text-sm font-medium">Supporting report reference<Input aria-label="Governed supporting report" value={form.supportingReportReference} onChange={(event) => setForm((value) => ({ ...value, supportingReportReference: event.target.value }))} /></label><label className="grid gap-2 text-sm font-medium">Evidence-set reference<Input aria-label="Governed evidence set" value={form.evidenceSetReference} onChange={(event) => setForm((value) => ({ ...value, evidenceSetReference: event.target.value }))} /></label></div> : null}
            <div className="flex flex-wrap items-center gap-3"><Button onClick={submit} disabled={!valid || submitting}>{submitting ? "Applying…" : "Apply governed action"}</Button><Button variant="outline" onClick={() => load()} disabled={submitting}>Refresh governed case</Button><p className="text-xs text-muted-foreground">Outcome approval is not registry publication.</p></div>
          </div> : <p className="text-sm text-muted-foreground">No governed actions are currently authorised for this actor and case state.</p>}
        </> : null}
      </CardContent>
    </Card>
  );
}

export { actionPayload };
