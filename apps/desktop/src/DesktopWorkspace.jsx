import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import Activity from "lucide-react/dist/esm/icons/activity.mjs";
import AlertTriangle from "lucide-react/dist/esm/icons/alert-triangle.mjs";
import BarChart3 from "lucide-react/dist/esm/icons/bar-chart-3.mjs";
import Clock3 from "lucide-react/dist/esm/icons/clock-3.mjs";
import FileSearch from "lucide-react/dist/esm/icons/file-search.mjs";
import LockKeyhole from "lucide-react/dist/esm/icons/lock-keyhole.mjs";
import LogOut from "lucide-react/dist/esm/icons/log-out.mjs";
import Network from "lucide-react/dist/esm/icons/network.mjs";
import RefreshCw from "lucide-react/dist/esm/icons/refresh-cw.mjs";
import RotateCcw from "lucide-react/dist/esm/icons/rotate-ccw.mjs";
import Search from "lucide-react/dist/esm/icons/search.mjs";
import ShieldAlert from "lucide-react/dist/esm/icons/shield-alert.mjs";
import ShieldCheck from "lucide-react/dist/esm/icons/shield-check.mjs";
import WifiOff from "lucide-react/dist/esm/icons/wifi-off.mjs";
import X from "lucide-react/dist/esm/icons/x.mjs";

import { Button } from "../../web/src/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../../web/src/components/ui/card";
import { Input } from "../../web/src/components/ui/input";
import { desktopBridge, nextBackoff, operationalWriteAllowed } from "./desktopBridge";
import { GovernedDesktopCasePanel } from "./GovernedDesktopCasePanel";
import { enumLabel } from "./presentation";

const AUTO_LOCK_MS = 15 * 60_000;
const PRIORITIES = ["LOW", "NORMAL", "HIGH", "CRITICAL"];
const NOTE_TYPES = ["INTERNAL_NOTE", "EVIDENCE", "INTERVIEW", "MEDICAL_REVIEW", "PROVIDER_REVIEW"];
const EVIDENCE_TYPES = ["DOCUMENT", "PROVIDER_INVOICE", "MEDICAL_RECORD", "CORRESPONDENCE", "IMAGE", "OTHER"];
const EVIDENCE_ACCEPT = ".pdf,.png,.jpg,.jpeg,.txt,.csv";
const STATUS_TRANSITIONS = Object.freeze({
  OPEN: ["OPEN", "UNDER_REVIEW", "AWAITING_EVIDENCE", "CLOSED"],
  UNDER_REVIEW: ["UNDER_REVIEW", "AWAITING_EVIDENCE", "CONFIRMED_FRAUD", "NO_FRAUD_FOUND", "CLOSED"],
  AWAITING_EVIDENCE: ["AWAITING_EVIDENCE", "UNDER_REVIEW", "CLOSED"],
  CONFIRMED_FRAUD: ["CONFIRMED_FRAUD", "CLOSED"],
  REVERSED: ["REVERSED", "CLOSED"],
  NO_FRAUD_FOUND: ["NO_FRAUD_FOUND", "CLOSED"],
  CLOSED: ["CLOSED"],
});

function displayDate(value, options = {}) {
  if (!value) return "Never";
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? "Unknown" : parsed.toLocaleString("en-ZA", options);
}

function money(value) {
  return Number.isFinite(Number(value))
    ? new Intl.NumberFormat("en-ZA", { style: "currency", currency: "ZAR" }).format(Number(value))
    : "Not available";
}

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

function freshnessClasses(freshness) {
  if (freshness === "Fresh") return "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300";
  if (freshness === "Synchronizing") return "border-sky-500/30 bg-sky-500/10 text-sky-700 dark:text-sky-300";
  if (freshness === "Offline") return "border-rose-500/30 bg-rose-500/10 text-rose-700 dark:text-rose-300";
  return "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300";
}

function toneClasses(tone) {
  if (tone === "danger") return "border-rose-500/25 bg-rose-500/10 text-rose-700 dark:text-rose-300";
  if (tone === "warning") return "border-amber-500/25 bg-amber-500/10 text-amber-700 dark:text-amber-300";
  if (tone === "success") return "border-emerald-500/25 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300";
  if (tone === "info") return "border-sky-500/25 bg-sky-500/10 text-sky-700 dark:text-sky-300";
  return "border-border bg-secondary/50 text-muted-foreground";
}

function statusTone(status) {
  if (["CONFIRMED_FRAUD", "CRITICAL", "PROCESSING_FAILED"].includes(status)) return "danger";
  if (["AWAITING_EVIDENCE", "HIGH", "FLAGGED"].includes(status)) return "warning";
  if (["NO_FRAUD_FOUND", "CLOSED", "LOW", "SCORED"].includes(status)) return "success";
  if (["UNDER_REVIEW", "OPEN", "NORMAL"].includes(status)) return "info";
  return "neutral";
}

function StatusPill({ value, tone = statusTone(value) }) {
  return <span className={`inline-flex rounded-full border px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.1em] ${toneClasses(tone)}`}>{enumLabel(value)}</span>;
}

function RiskLabel({ score }) {
  const value = Number(score);
  const tone = value >= 70 ? "danger" : value >= 40 ? "warning" : Number.isFinite(value) ? "success" : "neutral";
  return <span className={`inline-flex rounded-md border px-2 py-1 font-data text-xs font-semibold ${toneClasses(tone)}`}>{Number.isFinite(value) ? `${value.toFixed(1)} risk` : "Unscored"}</span>;
}

function WorkspaceBrand() {
  return (
    <div className="flex items-center gap-3">
      <span className="grid h-10 w-10 place-items-center rounded-xl bg-primary text-primary-foreground shadow-sm"><ShieldCheck className="h-5 w-5" /></span>
      <div><p className="font-display text-base font-semibold">ClaimGuard</p><p className="font-data text-[10px] uppercase tracking-[0.18em] text-muted-foreground">Scheme operations</p></div>
    </div>
  );
}

function StatCard({ title, value, description, icon: Icon }) {
  return (
    <Card>
      <CardHeader className="flex-row items-start justify-between gap-3 pb-2">
        <div><CardDescription>{title}</CardDescription><CardTitle className="mt-1 font-data text-3xl">{value}</CardTitle></div>
        {Icon ? <span className="rounded-lg bg-secondary p-2 text-muted-foreground"><Icon className="h-4 w-4" /></span> : null}
      </CardHeader>
      <CardContent className="text-xs text-muted-foreground">{description}</CardContent>
    </Card>
  );
}

function EmptyState({ icon: Icon = Activity, title, description }) {
  return <div className="grid place-items-center gap-2 p-12 text-center"><Icon className="h-7 w-7 text-muted-foreground" /><p className="font-semibold">{title}</p><p className="max-w-md text-sm text-muted-foreground">{description}</p></div>;
}

function SearchField({ value, onChange, label, placeholder }) {
  return (
    <label className="relative block min-w-0 flex-1">
      <span className="sr-only">{label}</span>
      <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
      <Input aria-label={label} className="pl-9" value={value} onChange={(event) => onChange(event.target.value)} placeholder={placeholder} />
    </label>
  );
}

function DetailOverlay({ children, labelId, onClose, open }) {
  const backdropRef = useRef(null);
  const dialogRef = useRef(null);

  useEffect(() => {
    if (!open) return undefined;

    const previouslyFocused = document.activeElement;
    const previousOverflow = document.body.style.overflow;
    const appRoot = document.getElementById("app");
    const appRootState = appRoot ? {
      ariaHidden: appRoot.getAttribute("aria-hidden"),
      hadInert: appRoot.hasAttribute("inert"),
    } : null;
    document.body.style.overflow = "hidden";
    if (appRoot) {
      appRoot.setAttribute("aria-hidden", "true");
      appRoot.setAttribute("inert", "");
    }

    const focusableSelector = [
      "button:not([disabled])",
      "[href]",
      "input:not([disabled])",
      "select:not([disabled])",
      "textarea:not([disabled])",
      "[tabindex]:not([tabindex='-1'])",
    ].join(",");

    const focusInitialControl = () => {
      const dialog = dialogRef.current;
      if (!dialog) return;
      const initialControl = dialog.querySelector("[data-overlay-initial-focus]");
      (initialControl || dialog).focus();
    };

    const animationFrame = window.requestAnimationFrame(focusInitialControl);
    const handleKeyDown = (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== "Tab") return;

      const dialog = dialogRef.current;
      const focusable = dialog
        ? Array.from(dialog.querySelectorAll(focusableSelector))
        : [];
      if (!focusable.length) {
        event.preventDefault();
        dialog?.focus();
        return;
      }

      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && (document.activeElement === first || !dialog.contains(document.activeElement))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (document.activeElement === last || !dialog.contains(document.activeElement))) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => {
      window.cancelAnimationFrame(animationFrame);
      document.removeEventListener("keydown", handleKeyDown);
      document.body.style.overflow = previousOverflow;
      if (appRoot && appRootState) {
        if (appRootState.ariaHidden === null) appRoot.removeAttribute("aria-hidden");
        else appRoot.setAttribute("aria-hidden", appRootState.ariaHidden);
        if (!appRootState.hadInert) appRoot.removeAttribute("inert");
      }
      if (previouslyFocused instanceof HTMLElement && previouslyFocused.isConnected) {
        previouslyFocused.focus();
      }
    };
  }, [onClose, open]);

  if (!open) return null;
  return createPortal(
    <div ref={backdropRef} className="fixed inset-0 z-[100] grid place-items-center bg-slate-950/70 p-3 backdrop-blur-sm sm:p-6" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelId}
        tabIndex={-1}
        onMouseDown={(event) => event.stopPropagation()}
        className="max-h-[calc(100vh-1.5rem)] w-full max-w-6xl overflow-y-auto overscroll-contain rounded-lg bg-card shadow-2xl outline-none sm:max-h-[calc(100vh-3rem)]"
      >
        {children}
      </div>
    </div>,
    document.body,
  );
}

function Overview({ claims, investigations, summary, network, openClaim, openInvestigation, canViewInvestigations }) {
  const highRisk = claims
    .filter((claim) => Number(claim.riskScore) >= 70)
    .sort((left, right) => Number(right.riskScore) - Number(left.riskScore))
    .slice(0, 6);
  const urgentInvestigations = investigations
    .slice()
    .sort((left, right) => PRIORITIES.indexOf(right.priority) - PRIORITIES.indexOf(left.priority))
    .slice(0, 5);
  return (
    <div className="space-y-6">
      <section className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard title="Cached claims" value={claims.length} description="Most recent 90 days plus active investigations" icon={FileSearch} />
        <StatCard title="Total scheme claims" value={summary.totalClaims ?? "—"} description="Current server aggregate, not a local recount" icon={BarChart3} />
        <StatCard title="High-risk claims" value={summary.highRiskClaims ?? "—"} description="Screening signals requiring human review" icon={ShieldAlert} />
        <StatCard title="Active investigations" value={canViewInvestigations ? investigations.length : "—"} description={canViewInvestigations ? `${investigations.filter((item) => item.priority === "CRITICAL").length} critical priority` : "Requires investigation-view permission"} icon={AlertTriangle} />
      </section>

      <div className="grid gap-6 xl:grid-cols-[1.35fr_0.85fr]">
        <Card>
          <CardHeader><CardTitle>Cached claim summaries</CardTitle><CardDescription>Highest-risk records in the current bounded cache. Open a claim for authoritative detail.</CardDescription></CardHeader>
          <CardContent className="p-0">
            {highRisk.length ? <div className="divide-y divide-border/70">{highRisk.map((claim) => <button type="button" key={claim.claimId} onClick={() => openClaim(claim)} className="flex w-full items-center gap-4 px-5 py-4 text-left hover:bg-secondary/40"><div className="min-w-0 flex-1"><p className="truncate font-data text-xs font-semibold">{claim.claimId}</p><p className="mt-1 text-xs text-muted-foreground">{claim.serviceDate || "No service date"} · {money(claim.billedAmount)} · {claim.billingCode || "No billing code"}</p></div><RiskLabel score={claim.riskScore} /></button>)}</div> : <EmptyState title="No high-risk cached claims" description="The bounded cache does not currently contain a claim above the high-risk threshold." />}
          </CardContent>
        </Card>

        <Card>
          <CardHeader><CardTitle>Operational attention</CardTitle><CardDescription>{canViewInvestigations ? "Active cases ordered by priority." : "Investigation data is capability restricted."}</CardDescription></CardHeader>
          <CardContent className="p-0">
            {canViewInvestigations && urgentInvestigations.length ? <div className="divide-y divide-border/70">{urgentInvestigations.map((item) => <button type="button" key={item.investigationId} onClick={() => openInvestigation(item)} className="flex w-full items-center justify-between gap-3 px-5 py-4 text-left hover:bg-secondary/40"><div className="min-w-0"><p className="truncate font-data text-xs font-semibold">{item.investigationId}</p><p className="mt-1 text-xs text-muted-foreground">Claim {item.claimId} · {enumLabel(item.status)}</p></div><StatusPill value={item.priority} /></button>)}</div> : <EmptyState icon={AlertTriangle} title={canViewInvestigations ? "No active investigations" : "Investigation access not assigned"} description={canViewInvestigations ? "New and updated investigations will appear after synchronization." : "Your current account can still work with the claims permitted by the scheme."} />}
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader className="flex-row items-center justify-between"><div><CardTitle>Suspicious-network projection</CardTitle><CardDescription>Precomputed multi-claim review candidates; these are signals, not fraud findings.</CardDescription></div><Network className="h-5 w-5 text-muted-foreground" /></CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-3"><div><p className="text-xs text-muted-foreground">Active clusters</p><p className="mt-1 font-data text-2xl font-semibold">{network?.summary?.active_cluster_count ?? 0}</p></div><div><p className="text-xs text-muted-foreground">Represented claims</p><p className="mt-1 font-data text-2xl font-semibold">{network?.summary?.represented_claim_count ?? 0}</p></div><div><p className="text-xs text-muted-foreground">Linked entities</p><p className="mt-1 font-data text-2xl font-semibold">{network?.summary?.entity_count ?? 0}</p></div></CardContent>
      </Card>
    </div>
  );
}

function InvestigationCreationPanel({ claim, writesAllowed, canCreate, canAssign, investigators, onCreate }) {
  const [priority, setPriority] = useState("NORMAL");
  const [assignedInvestigator, setAssignedInvestigator] = useState("");
  const [submitting, setSubmitting] = useState(false);
  if (claim.investigation || !canCreate) return null;
  async function create() {
    setSubmitting(true);
    try {
      await onCreate(claim, { priority, assignedInvestigator: canAssign ? assignedInvestigator || null : null });
    } finally {
      setSubmitting(false);
    }
  }
  return <div className="rounded-xl border border-primary/20 bg-primary/5 p-4"><div><p className="text-sm font-semibold">Create an investigation</p><p className="mt-1 text-xs text-muted-foreground">Creation is sent directly to the authoritative scheme data plane and checked against claim version {claim.currentClaimVersion}.</p></div><div className="mt-4 grid gap-3 md:grid-cols-[1fr_1fr_auto]"><label className="grid gap-2 text-sm font-medium">Priority<select aria-label="New investigation priority" className="h-10 rounded-md border border-input bg-background px-3 text-sm" value={priority} onChange={(event) => setPriority(event.target.value)} disabled={!writesAllowed}>{PRIORITIES.map((value) => <option key={value} value={value}>{enumLabel(value)}</option>)}</select></label>{canAssign ? <label className="grid gap-2 text-sm font-medium">Assign investigator<select aria-label="New investigation assignee" className="h-10 rounded-md border border-input bg-background px-3 text-sm" value={assignedInvestigator} onChange={(event) => setAssignedInvestigator(event.target.value)} disabled={!writesAllowed}><option value="">Leave unassigned</option>{investigators.map((user) => <option key={user.userId} value={user.userId}>{user.displayName}</option>)}</select></label> : <div />}<div className="flex items-end"><Button onClick={create} disabled={!writesAllowed || submitting}>{submitting ? "Creating…" : "Create investigation"}</Button></div></div>{!writesAllowed ? <p className="mt-3 text-xs text-amber-700 dark:text-amber-300">Reconnect and synchronize before creating the case.</p> : null}</div>;
}

function inputNoveltySignals(claim, feature) {
  return (claim?.detection?.inputDrift?.signals || []).filter((signal) => (
    signal?.feature === feature && signal?.kind === "UNSEEN_CATEGORY"
  ));
}

function NoveltyWarning({ signals }) {
  if (!signals?.length) return null;
  return <div className="mt-2 rounded-lg border border-amber-500/30 bg-amber-500/10 p-2 text-xs leading-5 text-amber-900 dark:text-amber-100"><p className="font-semibold">Unknown to deployed model</p><p>This value was not present in the deployed model’s training vocabulary. It is a model-input novelty warning and does not by itself prove fraud.</p></div>;
}

function DetailField({ label, value, mono = false, warningSignals = [] }) {
  const rendered = value === null || value === undefined || value === "" ? "—" : value;
  return <div className="min-w-0 rounded-lg border border-border/70 bg-secondary/20 p-3"><dt className="text-xs font-medium text-muted-foreground">{label}</dt><dd className={`mt-1 break-words text-sm font-medium ${mono ? "font-data text-xs" : ""}`}>{rendered}</dd><NoveltyWarning signals={warningSignals} /></div>;
}

function ClaimDetail({ payload, loading, error, offline, onClose, onOpenInvestigation, onCreateInvestigation, canViewInvestigations, canCreateInvestigations, canAssignInvestigations, investigators, writesAllowed }) {
  if (!payload && !loading && !error) return null;
  const claim = payload?.claim || null;
  const noveltySignals = claim?.detection?.inputDrift?.signals?.filter((signal) => signal?.kind === "UNSEEN_CATEGORY") || [];
  return (
    <Card className="border-primary/20 shadow-lg">
      <CardHeader className="flex-row items-start justify-between gap-4">
        <div><p className="font-data text-[10px] font-semibold uppercase tracking-[0.16em] text-primary">Authoritative claim detail</p><CardTitle id="claim-detail-title" className="mt-2"><span className="sr-only">Claim </span>{claim?.claimId || "Loading claim…"}</CardTitle><CardDescription>{payload?.fetchedAt ? `Fetched ${displayDate(payload.fetchedAt)}` : "Requesting minimum-necessary detail from the scheme data plane."}</CardDescription></div>
        <Button data-overlay-initial-focus variant="ghost" size="sm" onClick={onClose}><X className="h-4 w-4" /><span className="sr-only">Close claim detail</span></Button>
      </CardHeader>
      <CardContent>
        {error ? <div role="alert" className="mb-4 rounded-lg border border-rose-500/30 bg-rose-500/10 p-3 text-sm text-rose-700 dark:text-rose-300">{error}</div> : null}
        {offline && claim ? <div role="status" className="mb-4 flex gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-sm text-amber-800 dark:text-amber-200"><WifiOff className="mt-0.5 h-4 w-4 shrink-0" />Showing the last cached claim detail. Authoritative updates require a connection.</div> : null}
        {loading && !claim ? <div className="flex items-center gap-3 py-10 text-sm text-muted-foreground"><RefreshCw className="h-4 w-4 animate-spin" />Loading claim detail…</div> : null}
        {claim ? <div className="space-y-6">
          <section aria-labelledby="patient-section-title" className="rounded-xl border border-border p-4"><h3 id="patient-section-title" className="text-sm font-semibold">Patient</h3><div className="mt-3"><p className="break-words text-lg font-semibold">{claim.member?.displayName || "Unknown patient"}</p><p className="mt-1 break-all font-data text-xs text-muted-foreground">Member ID: {claim.memberId || "Unavailable"}</p></div><dl className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3"><DetailField label="Date of birth" value={claim.member?.dateOfBirth || "—"} /><DetailField label="Gender" value={claim.member?.gender || "—"} /><DetailField label="Home region" value={claim.member?.homeRegion || "—"} /><DetailField label="Join date" value={claim.member?.joinDate || "—"} /><DetailField label="Benefit option" value={claim.benefitOption || "—"} warningSignals={inputNoveltySignals(claim, "benefit_option")} /></dl></section>

          <section aria-labelledby="provider-section-title" className="rounded-xl border border-border p-4"><h3 id="provider-section-title" className="text-sm font-semibold">Provider</h3><div className="mt-3"><p className="break-words text-lg font-semibold">{claim.provider?.displayName || "Unknown provider"}</p><div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 font-data text-xs text-muted-foreground"><span>Provider ID: {claim.providerId || "Unavailable"}</span><span>Practice number: {claim.provider?.practiceNumber || "Unavailable"}</span></div></div><dl className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4"><DetailField label="Specialty" value={claim.provider?.specialty || "—"} /><DetailField label="Provider kind" value={claim.provider?.kind || "—"} /><DetailField label="Provider category" value={claim.provider?.category || "—"} /><DetailField label="Practice region" value={claim.provider?.region || "—"} /></dl></section>

          <section aria-labelledby="classification-section-title" className="rounded-xl border border-border p-4"><h3 id="classification-section-title" className="text-sm font-semibold">Claim Classification</h3><p className="mt-1 text-xs text-muted-foreground">Raw categorical and transactional inputs supplied to the deployed fraud-detection workflow.</p><dl className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4"><DetailField label="Diagnosis code" value={claim.diagnosisCode} mono warningSignals={inputNoveltySignals(claim, "diagnosis_code")} /><DetailField label="Billing code" value={claim.billingCode} mono /><DetailField label="Tariff discipline" value={claim.tariffDiscipline} warningSignals={inputNoveltySignals(claim, "tariff_discipline")} /><DetailField label="Line type" value={claim.lineType} warningSignals={inputNoveltySignals(claim, "line_type")} /><DetailField label="Benefit option" value={claim.benefitOption} warningSignals={inputNoveltySignals(claim, "benefit_option")} /><DetailField label="Network type" value={claim.networkType} warningSignals={inputNoveltySignals(claim, "network_type")} /><DetailField label="Quantity" value={Number.isFinite(Number(claim.quantity)) ? Number(claim.quantity).toLocaleString("en-ZA") : "—"} /><DetailField label="Claimed amount" value={money(claim.billedAmount)} /><DetailField label="Service date" value={claim.serviceDate || "—"} /><DetailField label="Received date" value={claim.receivedDate || "—"} /><DetailField label="Submission lag in days" value={Number.isFinite(Number(claim.submissionLagDays)) ? Number(claim.submissionLagDays) : "—"} /><DetailField label="Billing-provider kind" value={claim.billingProviderKind || claim.provider?.kind || "—"} /><DetailField label="Billing-provider category" value={claim.billingProviderCategory || claim.provider?.category || "—"} /><DetailField label="Rendering-practitioner ID" value={claim.renderingPractitionerId || "None recorded"} mono /><DetailField label="Rendering-practitioner category" value={claim.renderingPractitionerCategory || "—"} /><DetailField label="Known to billing provider" value={claim.renderingKnownToBillingProvider ? "Yes" : "No"} /></dl></section>

          <section aria-labelledby="assessment-section-title" className="rounded-xl border border-border p-4"><h3 id="assessment-section-title" className="text-sm font-semibold">Model Assessment</h3><div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4"><DetailField label="Fraud score" value={Number.isFinite(Number(claim.riskScore)) ? `${Number(claim.riskScore).toFixed(1)} risk` : "Unscored"} /><DetailField label="Risk level" value={claim.riskLevel || "Unscored"} /><DetailField label="Claim status" value={enumLabel(claim.status)} /><DetailField label="Processing status" value={enumLabel(claim.processingStatus)} /><DetailField label="Model deployment" value={claim.detection?.modelDeploymentId || "—"} mono /><DetailField label="Feature schema" value={claim.detection?.featureSchemaVersion || "—"} mono /><DetailField label="Claim version" value={claim.currentClaimVersion ?? "—"} /><DetailField label="Scored at" value={displayDate(claim.detection?.scoredAt)} /></div>{claim.triggeredRules?.length ? <div className="mt-4 flex flex-wrap gap-2">{claim.triggeredRules.map((rule) => <StatusPill key={rule} value={rule} tone="warning" />)}</div> : null}</section>

          <section aria-labelledby="alerts-section-title" className="rounded-xl border border-border p-4"><h3 id="alerts-section-title" className="text-sm font-semibold">Alerts and Evidence</h3>{noveltySignals.length ? <div className="mt-3 space-y-2">{noveltySignals.map((signal, index) => <div key={`${signal.feature}-${index}`} role="alert" className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-sm text-amber-900 dark:text-amber-100"><p className="font-semibold">Model-input novelty: {enumLabel(signal.feature)}</p><p className="mt-1">Observed value <span className="font-data">{String(signal.observed ?? "missing")}</span> was not present in the deployed model’s training vocabulary. This warning does not by itself prove that the claim is fraudulent.</p></div>)}</div> : null}{claim.evidence?.length ? <ul className="mt-3 space-y-2">{claim.evidence.map((item) => <li key={item} className="rounded-lg border border-border bg-secondary/20 p-3 text-sm leading-6">{item}</li>)}</ul> : <p className="mt-3 text-sm text-muted-foreground">No persisted detection rationale is available for this claim version.</p>}</section>

          <section aria-labelledby="activity-section-title" className="rounded-xl border border-border p-4"><h3 id="activity-section-title" className="text-sm font-semibold">Investigation Activity</h3>{claim.investigation ? <div className="mt-3 flex flex-col gap-3 rounded-xl border border-primary/20 bg-primary/5 p-4 sm:flex-row sm:items-center sm:justify-between"><div><p className="text-sm font-semibold">Linked investigation</p><p className="mt-1 break-all font-data text-xs text-muted-foreground">{claim.investigation.investigationId}</p></div><div className="flex flex-wrap items-center gap-2"><StatusPill value={claim.investigation.status} />{canViewInvestigations ? <Button variant="outline" size="sm" onClick={() => onOpenInvestigation(claim.investigation)}>Open case</Button> : null}</div></div> : <p className="mt-3 text-sm text-muted-foreground">No investigation is currently linked to this claim.</p>}<div className="mt-4"><InvestigationCreationPanel claim={claim} writesAllowed={writesAllowed} canCreate={canCreateInvestigations} canAssign={canAssignInvestigations} investigators={investigators} onCreate={onCreateInvestigation} /></div></section>
        </div> : null}
      </CardContent>
    </Card>
  );
}

function ClaimsView({ claims, openClaim }) {
  const [search, setSearch] = useState("");
  const [risk, setRisk] = useState("all");
  const [visibleCount, setVisibleCount] = useState(10);
  const filtered = useMemo(() => claims.filter((claim) => {
    const query = search.trim().toLowerCase();
    const matchesSearch = !query || [claim.claimId, claim.member?.displayName, claim.memberId, claim.provider?.displayName, claim.providerId, claim.provider?.practiceNumber, claim.provider?.specialty, claim.provider?.kind, claim.provider?.category, claim.provider?.region, claim.diagnosisCode, claim.billingCode, claim.benefitOption, claim.networkType, claim.lineType, claim.tariffDiscipline, claim.status].some((value) => String(value || "").toLowerCase().includes(query));
    const score = Number(claim.riskScore);
    const bucket = !Number.isFinite(score) ? "unscored" : score >= 70 ? "high" : score >= 40 ? "medium" : "low";
    return matchesSearch && (risk === "all" || risk === bucket);
  }), [claims, risk, search]);
  useEffect(() => setVisibleCount(10), [risk, search]);
  const visible = filtered.slice(0, visibleCount);
  return <div className="space-y-6">
    <Card><CardHeader><CardTitle>Claims queue</CardTitle><CardDescription>Search the bounded local cache. Opening a claim refreshes its authoritative detail when connected.</CardDescription></CardHeader><CardContent className="space-y-4"><div className="flex flex-col gap-3 sm:flex-row"><SearchField label="Search claims" placeholder="Patient, member, provider, diagnosis, billing, benefit, network, line, or tariff" value={search} onChange={setSearch} /><label className="grid gap-1 text-xs text-muted-foreground"><span>Risk band</span><select aria-label="Risk band" className="h-10 rounded-md border border-input bg-background px-3 text-sm text-foreground" value={risk} onChange={(event) => setRisk(event.target.value)}><option value="all">All risk bands</option><option value="high">High risk</option><option value="medium">Medium risk</option><option value="low">Low risk</option><option value="unscored">Unscored</option></select></label></div><p className="text-xs text-muted-foreground">Showing {visible.length} of {filtered.length} matching claims · {claims.length} cached</p></CardContent><CardContent className="overflow-x-auto p-0"><table className="desktop-claim-table w-full min-w-[1220px] text-left text-sm"><thead className="border-y border-border bg-secondary/40 text-[10px] uppercase tracking-[0.12em] text-muted-foreground"><tr><th className="px-5 py-3">Claim</th><th className="px-5 py-3">Patient</th><th className="px-5 py-3">Provider</th><th className="px-5 py-3">Service date</th><th className="px-5 py-3">Amount</th><th className="px-5 py-3">Diagnosis</th><th className="px-5 py-3">Billing</th><th className="px-5 py-3">Risk</th><th className="px-5 py-3">Status</th><th className="px-5 py-3"><span className="sr-only">Actions</span></th></tr></thead><tbody className="divide-y divide-border/70">{visible.map((claim) => <tr key={claim.claimId}><td className="px-5 py-4 font-data text-xs font-semibold">{claim.claimId}</td><td className="min-w-48 px-5 py-4"><p className="break-words font-medium">{claim.member?.displayName || "Unknown patient"}</p><p className="mt-1 break-all font-data text-[11px] text-muted-foreground">Member ID: {claim.memberId || "Unavailable"}</p></td><td className="min-w-56 px-5 py-4"><p className="break-words font-medium">{claim.provider?.displayName || "Unknown provider"}</p><p className="mt-1 break-all font-data text-[11px] text-muted-foreground">Provider ID: {claim.providerId || "Unavailable"}</p>{claim.provider?.practiceNumber ? <p className="mt-1 text-xs text-muted-foreground">Practice {claim.provider.practiceNumber}</p> : null}</td><td className="px-5 py-4">{claim.serviceDate || "—"}</td><td className="px-5 py-4 font-data">{money(claim.billedAmount)}</td><td className="px-5 py-4 font-data text-xs">{claim.diagnosisCode || "—"}</td><td className="px-5 py-4 font-data text-xs">{claim.billingCode || "—"}</td><td className="px-5 py-4"><RiskLabel score={claim.riskScore} /></td><td className="px-5 py-4"><StatusPill value={claim.status} /></td><td className="px-5 py-4 text-right"><Button variant="outline" size="sm" onClick={() => openClaim(claim)}>Open</Button></td></tr>)}</tbody></table>{filtered.length === 0 ? <EmptyState icon={FileSearch} title="No matching claims" description="Adjust the search or risk filter. Older claims remain available through the web application." /> : null}{visible.length < filtered.length ? <div className="flex justify-center border-t border-border p-4"><Button variant="outline" onClick={() => setVisibleCount((count) => Math.min(count + 10, filtered.length))}>Show more claims</Button></div> : null}</CardContent></Card>
  </div>;
}

function InvestigationWorkspace({
  compact, detail, loading, error, offline, writesAllowed, canChangePriority, canAssign,
  canAddNote, canUploadEvidence, investigators, onSave, onAddNote, onUploadEvidence, onClose, onOpenClaim,
}) {
  const record = detail?.investigation || compact;

  const [draftPriority, setDraftPriority] = useState(record?.priority || "NORMAL");
  const [draftAssignee, setDraftAssignee] = useState(record?.assignedInvestigator || "");
  const [note, setNote] = useState({ text: "", noteType: "INTERNAL_NOTE" });
  const [evidence, setEvidence] = useState({ file: null, description: "", evidenceType: "DOCUMENT" });
  const [fileInputKey, setFileInputKey] = useState(0);
  const [saving, setSaving] = useState(false);
  const [addingNote, setAddingNote] = useState(false);
  const [uploading, setUploading] = useState(false);

  useEffect(() => {
    setDraftPriority(record?.priority || "NORMAL");
    setDraftAssignee(record?.assignedInvestigator || "");
  }, [record?.assignedInvestigator, record?.investigationId, record?.priority, record?.recordVersion, record?.status]);

  if (!record && !loading && !error) return null;

  const changedPriority = canChangePriority && draftPriority !== record?.priority;
  const changedAssignee = canAssign && draftAssignee && draftAssignee !== record?.assignedInvestigator;
  async function save() {
    setSaving(true);
    try {
      await onSave(record, {
        ...(changedPriority ? { priority: draftPriority } : {}),
        ...(changedAssignee ? { assignedInvestigator: draftAssignee } : {}),
      });
    } finally {
      setSaving(false);
    }
  }
  async function addNote() {
    setAddingNote(true);
    try {
      await onAddNote(record, note);
      setNote({ text: "", noteType: "INTERNAL_NOTE" });
    } finally {
      setAddingNote(false);
    }
  }
  async function uploadEvidence() {
    setUploading(true);
    try {
      const contentBase64 = await fileAsBase64(evidence.file);
      await onUploadEvidence(record, {
        filename: evidence.file.name,
        description: evidence.description,
        evidenceType: evidence.evidenceType,
        contentType: evidenceContentType(evidence.file),
        contentBase64,
      });
      setEvidence({ file: null, description: "", evidenceType: "DOCUMENT" });
      setFileInputKey((value) => value + 1);
    } finally {
      setUploading(false);
    }
  }
  return <Card className="border-primary/20 shadow-lg"><CardHeader className="flex-row items-start justify-between gap-4"><div><p className="font-data text-[10px] font-semibold uppercase tracking-[0.16em] text-primary">Investigation workspace</p><CardTitle id="investigation-detail-title" className="mt-2"><span className="sr-only">Investigation </span>{record?.investigationId || "Loading investigation…"}</CardTitle><CardDescription>Claim {record?.claimId || "—"} · record version {record?.recordVersion || "—"} · updated {displayDate(record?.updatedAt)}</CardDescription></div><Button data-overlay-initial-focus variant="ghost" size="sm" onClick={onClose}><X className="h-4 w-4" /><span className="sr-only">Close investigation workspace</span></Button></CardHeader><CardContent className="space-y-6">
    {error ? <div role="alert" className="rounded-lg border border-rose-500/30 bg-rose-500/10 p-3 text-sm text-rose-700 dark:text-rose-300">{error}</div> : null}
    {offline && record ? <div role="status" className="flex gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-sm text-amber-800 dark:text-amber-200"><WifiOff className="mt-0.5 h-4 w-4 shrink-0" />Showing the last cached case detail. Authoritative updates require a connection.</div> : null}
    {loading && !detail ? <div className="flex items-center gap-3 py-4 text-sm text-muted-foreground"><RefreshCw className="h-4 w-4 animate-spin" />Loading notes and evidence…</div> : null}
    {record?.investigationId ? <GovernedDesktopCasePanel key={record.investigationId} investigationId={record.investigationId} historicalStatus={record.status} writesAllowed={writesAllowed} /> : null}
    <div className="grid gap-4 lg:grid-cols-[1fr_1fr_1fr_auto]"><div className="grid gap-2 text-sm font-medium"><span>Historical status</span><span aria-label="Investigation status" className="flex h-10 items-center rounded-md border border-input bg-secondary/30 px-3 text-sm text-muted-foreground">{enumLabel(record?.status)}</span><span className="text-[10px] text-muted-foreground">Lifecycle changes require the governed case-action API.</span></div><label className="grid gap-2 text-sm font-medium">Priority<select aria-label="Investigation priority" className="h-10 rounded-md border border-input bg-background px-3 text-sm" value={draftPriority} onChange={(event) => setDraftPriority(event.target.value)} disabled={!writesAllowed || !canChangePriority}>{PRIORITIES.map((value) => <option key={value} value={value}>{enumLabel(value)}</option>)}</select></label><label className="grid gap-2 text-sm font-medium">Assigned investigator<select aria-label="Assigned investigator" className="h-10 rounded-md border border-input bg-background px-3 text-sm" value={draftAssignee} onChange={(event) => setDraftAssignee(event.target.value)} disabled={!writesAllowed || !canAssign}><option value="" disabled>Select an investigator</option>{record?.assignedInvestigator && !investigators.some((user) => user.userId === record.assignedInvestigator) ? <option value={record.assignedInvestigator}>{record.assignedInvestigator} (currently assigned)</option> : null}{investigators.map((user) => <option key={user.userId} value={user.userId}>{user.displayName}</option>)}</select></label><div className="flex items-end"><Button onClick={save} disabled={saving || !writesAllowed || (!changedPriority && !changedAssignee)}>{saving ? "Saving…" : "Save changes"}</Button></div></div>
    {!writesAllowed ? <p className="text-sm text-amber-700 dark:text-amber-300">Reconnect and synchronize before changing authoritative case data.</p> : null}
    {writesAllowed && !canChangePriority && !canAssign ? <p className="text-sm text-muted-foreground">This account can review the case but does not have case-update capabilities.</p> : null}
    <div className="grid gap-6 lg:grid-cols-2"><section><h3 className="text-sm font-semibold">Case information</h3><dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-5 gap-y-2 text-sm"><dt className="text-muted-foreground">Status</dt><dd><StatusPill value={record?.status} /></dd><dt className="text-muted-foreground">Priority</dt><dd><StatusPill value={record?.priority} /></dd><dt className="text-muted-foreground">Assigned to</dt><dd>{record?.assignedInvestigator || "Unassigned"}</dd><dt className="text-muted-foreground">Opened by</dt><dd>{record?.assignedBy || "—"}</dd><dt className="text-muted-foreground">Opened</dt><dd>{displayDate(record?.createdAt)}</dd></dl><Button variant="outline" size="sm" className="mt-4" onClick={() => onOpenClaim(record?.claimId)}>Open related claim</Button></section><section><h3 className="text-sm font-semibold">Recorded milestones</h3><div className="mt-3 space-y-2 text-sm"><p className="rounded-lg border border-border p-3"><span className="text-muted-foreground">Last updated</span><br />{displayDate(record?.updatedAt)}</p>{record?.fraudConfirmedAt ? <p className="rounded-lg border border-rose-500/20 bg-rose-500/5 p-3"><span className="text-muted-foreground">Historical fraud-confirmed timestamp</span><br />{displayDate(record.fraudConfirmedAt)}</p> : null}{record?.closedAt ? <p className="rounded-lg border border-border p-3"><span className="text-muted-foreground">Closed</span><br />{displayDate(record.closedAt)}</p> : null}</div></section></div>
    <div className="grid gap-6 xl:grid-cols-2"><section><h3 className="text-sm font-semibold">Investigation notes</h3>{canAddNote ? <div className="mt-3 space-y-3 rounded-xl border border-border bg-secondary/10 p-4"><label className="grid gap-2 text-sm font-medium">Note type<select aria-label="Investigation note type" className="h-10 rounded-md border border-input bg-background px-3 text-sm" value={note.noteType} onChange={(event) => setNote((previous) => ({ ...previous, noteType: event.target.value }))} disabled={!writesAllowed}>{NOTE_TYPES.map((value) => <option key={value} value={value}>{enumLabel(value)}</option>)}</select></label><label className="grid gap-2 text-sm font-medium">Note<textarea aria-label="Investigation note" className="min-h-28 rounded-md border border-input bg-background p-3 text-sm" maxLength={20000} value={note.text} onChange={(event) => setNote((previous) => ({ ...previous, text: event.target.value }))} disabled={!writesAllowed} /></label><Button size="sm" onClick={addNote} disabled={!writesAllowed || addingNote || !note.text.trim()}>{addingNote ? "Adding…" : "Add note"}</Button></div> : null}{detail?.investigation?.notes?.length ? <div className="mt-3 space-y-3">{detail.investigation.notes.map((item) => <article key={item.noteId} className="rounded-xl border border-border bg-secondary/20 p-4"><div className="flex flex-wrap items-center justify-between gap-2"><StatusPill value={item.noteType} /><time className="text-xs text-muted-foreground">{displayDate(item.timestamp)}</time></div><p className="mt-3 whitespace-pre-wrap text-sm leading-6">{item.text}</p><p className="mt-2 text-xs text-muted-foreground">Author {item.author}</p></article>)}</div> : <p className="mt-3 text-sm text-muted-foreground">No notes are recorded for this investigation.</p>}</section><section><h3 className="text-sm font-semibold">Evidence register</h3>{canUploadEvidence ? <div className="mt-3 space-y-3 rounded-xl border border-border bg-secondary/10 p-4"><label className="grid gap-2 text-sm font-medium">Evidence file<input key={fileInputKey} aria-label="Evidence file" type="file" accept={EVIDENCE_ACCEPT} className="block w-full text-sm" onChange={(event) => setEvidence((previous) => ({ ...previous, file: event.target.files?.[0] || null }))} disabled={!writesAllowed} /></label><p className="text-xs text-muted-foreground">Private upload. PDF, PNG, JPEG, TXT, or CSV; maximum 10 MB.</p>{evidence.file?.size > 10 * 1024 * 1024 ? <p role="alert" className="text-xs text-rose-700 dark:text-rose-300">The selected file is larger than 10 MB.</p> : null}<label className="grid gap-2 text-sm font-medium">Evidence type<select aria-label="Evidence type" className="h-10 rounded-md border border-input bg-background px-3 text-sm" value={evidence.evidenceType} onChange={(event) => setEvidence((previous) => ({ ...previous, evidenceType: event.target.value }))} disabled={!writesAllowed}>{EVIDENCE_TYPES.map((value) => <option key={value} value={value}>{enumLabel(value)}</option>)}</select></label><label className="grid gap-2 text-sm font-medium">Description<textarea aria-label="Evidence description" className="min-h-20 rounded-md border border-input bg-background p-3 text-sm" maxLength={20000} value={evidence.description} onChange={(event) => setEvidence((previous) => ({ ...previous, description: event.target.value }))} disabled={!writesAllowed} /></label><Button size="sm" onClick={uploadEvidence} disabled={!writesAllowed || uploading || !evidence.file || evidence.file.size > 10 * 1024 * 1024}>{uploading ? "Uploading…" : "Upload evidence"}</Button></div> : null}{detail?.investigation?.evidence?.length ? <div className="mt-3 divide-y divide-border rounded-xl border border-border">{detail.investigation.evidence.map((item) => <article key={item.evidenceId} className="p-4"><div className="flex flex-wrap items-center justify-between gap-2"><p className="font-medium">{item.filename}</p><StatusPill value={item.evidenceType} /></div><p className="mt-2 text-sm text-muted-foreground">{item.description || "No description supplied."}</p><p className="mt-2 text-xs text-muted-foreground">{item.contentSha256 ? `${item.byteSize ? `${new Intl.NumberFormat("en-ZA").format(item.byteSize)} bytes · ` : ""}SHA-256 ${item.contentSha256.slice(0, 16)}…` : "Legacy metadata record; no stored content hash."}</p><p className="mt-1 text-xs text-muted-foreground">Uploaded {displayDate(item.uploadedAt)} by {item.uploadedBy}</p></article>)}</div> : <p className="mt-3 text-sm text-muted-foreground">No evidence is recorded for this investigation.</p>}</section></div>
    {detail?.investigation?.activity?.length ? <section><h3 className="text-sm font-semibold">Case activity audit</h3><div className="mt-3 divide-y divide-border rounded-xl border border-border">{detail.investigation.activity.map((event) => <div key={event.activityEventId} className="flex flex-wrap items-center justify-between gap-3 p-4"><div><p className="text-sm font-medium">{enumLabel(event.action)}</p><p className="mt-1 text-xs text-muted-foreground">Actor {event.actorId} · {displayDate(event.occurredAt)}</p></div><span className="break-all font-data text-[10px] text-muted-foreground">{event.activityEventId}</span></div>)}</div></section> : null}
  </CardContent></Card>;
}

function InvestigationsView({ investigations, selection, detail, loading, writesAllowed, capabilities, investigators, openInvestigation, closeInvestigation, updateInvestigation, addInvestigationNote, uploadInvestigationEvidence, openClaimById }) {
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [priorityFilter, setPriorityFilter] = useState("all");
  const filtered = useMemo(() => investigations.filter((item) => {
    const query = search.trim().toLowerCase();
    return (!query || [item.investigationId, item.claimId, item.assignedInvestigator].some((value) => String(value || "").toLowerCase().includes(query)))
      && (statusFilter === "all" || item.status === statusFilter)
      && (priorityFilter === "all" || item.priority === priorityFilter);
  }), [investigations, priorityFilter, search, statusFilter]);
  return <div className="space-y-6"><Card><CardHeader><CardTitle>Investigation queue</CardTitle><CardDescription>All active cases in the organisation-bound cache, including investigations older than the 90-day claim window.</CardDescription></CardHeader><CardContent className="space-y-4"><div className="grid gap-3 lg:grid-cols-[1fr_auto_auto]"><SearchField label="Search investigations" placeholder="Investigation, claim, or assignee" value={search} onChange={setSearch} /><label className="grid gap-1 text-xs text-muted-foreground"><span>Status</span><select aria-label="Filter investigation status" className="h-10 rounded-md border border-input bg-background px-3 text-sm" value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)}><option value="all">All statuses</option>{Object.keys(STATUS_TRANSITIONS).filter((value) => value !== "CLOSED").map((value) => <option key={value} value={value}>{enumLabel(value)}</option>)}</select></label><label className="grid gap-1 text-xs text-muted-foreground"><span>Priority</span><select aria-label="Filter investigation priority" className="h-10 rounded-md border border-input bg-background px-3 text-sm" value={priorityFilter} onChange={(event) => setPriorityFilter(event.target.value)}><option value="all">All priorities</option>{PRIORITIES.map((value) => <option key={value} value={value}>{enumLabel(value)}</option>)}</select></label></div><p className="text-xs text-muted-foreground">Showing {filtered.length} of {investigations.length} active investigations</p></CardContent><CardContent className="overflow-x-auto p-0"><table className="desktop-claim-table w-full min-w-[900px] text-left text-sm"><thead className="border-y border-border bg-secondary/40 text-[10px] uppercase tracking-[0.12em] text-muted-foreground"><tr><th className="px-5 py-3">Investigation</th><th className="px-5 py-3">Claim</th><th className="px-5 py-3">Status</th><th className="px-5 py-3">Priority</th><th className="px-5 py-3">Assigned investigator</th><th className="px-5 py-3">Updated</th><th className="px-5 py-3"><span className="sr-only">Actions</span></th></tr></thead><tbody className="divide-y divide-border/70">{filtered.map((item) => <tr key={item.investigationId} className={selection?.investigationId === item.investigationId ? "bg-primary/5" : ""}><td className="px-5 py-4 font-data text-xs font-semibold">{item.investigationId}</td><td className="px-5 py-4 font-data text-xs">{item.claimId}</td><td className="px-5 py-4"><StatusPill value={item.status} /></td><td className="px-5 py-4"><StatusPill value={item.priority} /></td><td className="px-5 py-4">{item.assignedInvestigator || "Unassigned"}</td><td className="px-5 py-4 text-xs text-muted-foreground">{displayDate(item.updatedAt)}</td><td className="px-5 py-4 text-right"><Button variant="outline" size="sm" onClick={() => openInvestigation(item)}>Open case</Button></td></tr>)}</tbody></table>{filtered.length === 0 ? <EmptyState icon={AlertTriangle} title="No matching investigations" description="Adjust the filters or synchronize to receive current active cases." /> : null}</CardContent></Card><InvestigationWorkspace compact={selection} detail={detail} loading={loading} writesAllowed={writesAllowed} canChangePriority={capabilities.includes("investigations.change_priority")} canAssign={capabilities.includes("investigations.assign")} canAddNote={capabilities.includes("investigations.add_note")} canUploadEvidence={capabilities.includes("investigations.upload_evidence")} investigators={investigators} onSave={updateInvestigation} onAddNote={addInvestigationNote} onUploadEvidence={uploadInvestigationEvidence} onClose={closeInvestigation} onOpenClaim={openClaimById} /></div>;
}

function RiskSignalsView({ network, openClaimById }) {
  const summary = network?.summary || {};
  const nodes = (network?.nodes || []).slice().sort((left, right) => Number(right.max_risk_score || 0) - Number(left.max_risk_score || 0)).slice(0, 12);
  const edges = (network?.edges || []).slice().sort((left, right) => Number(right.risk_score || 0) - Number(left.risk_score || 0)).slice(0, 12);
  return <div className="space-y-6"><section className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4"><StatCard title="Active clusters" value={summary.active_cluster_count ?? 0} description="Multi-claim review candidates" icon={Network} /><StatCard title="Linked entities" value={summary.entity_count ?? 0} description={`${summary.member_count ?? 0} members · ${summary.provider_count ?? 0} providers`} icon={Activity} /><StatCard title="Represented claims" value={summary.represented_claim_count ?? 0} description="Claims inside qualifying networks" icon={FileSearch} /><StatCard title="Isolated signals" value={summary.isolated_review_claim_count ?? 0} description="Review signals not forming a network" icon={ShieldAlert} /></section><div className="grid gap-6 xl:grid-cols-2"><Card><CardHeader><CardTitle>Highest-risk linked entities</CardTitle><CardDescription>Tokenised identifiers from the current server projection.</CardDescription></CardHeader><CardContent className="p-0">{nodes.length ? <div className="divide-y divide-border/70">{nodes.map((node) => <div key={node.entity_id} className="flex items-center justify-between gap-4 px-5 py-4"><div className="min-w-0"><p className="truncate font-data text-xs font-semibold">{node.value}</p><p className="mt-1 text-xs text-muted-foreground">{enumLabel(node.entity_type)} · {node.flagged_claim_count} flagged claims</p></div><RiskLabel score={node.max_risk_score} /></div>)}</div> : <EmptyState icon={Network} title="No qualifying network" description="No connected multi-claim review candidate meets the current projection rule." />}</CardContent></Card><Card><CardHeader><CardTitle>Claims in suspicious networks</CardTitle><CardDescription>Open the claim for authoritative evidence before making a decision.</CardDescription></CardHeader><CardContent className="p-0">{edges.length ? <div className="divide-y divide-border/70">{edges.map((edge) => <button type="button" key={`${edge.cluster_id}:${edge.claim_id}`} onClick={() => openClaimById(edge.claim_id)} className="flex w-full items-center justify-between gap-4 px-5 py-4 text-left hover:bg-secondary/40"><div><p className="font-data text-xs font-semibold">{edge.claim_id}</p><p className="mt-1 text-xs text-muted-foreground">{money(edge.billed_amount)} · {edge.cluster_id}</p></div><RiskLabel score={edge.risk_score} /></button>)}</div> : <EmptyState icon={ShieldAlert} title="No network claims" description="This projection currently contains no qualifying connected claims." />}</CardContent></Card></div><div className="rounded-xl border border-sky-500/20 bg-sky-500/5 p-4 text-sm text-sky-800 dark:text-sky-200"><p className="font-semibold">Human review remains mandatory</p><p className="mt-1 leading-6">Network membership and risk scores prioritize work. They do not confirm fraud or replace an investigation.</p></div></div>;
}

export function DesktopWorkspace({ status, onStatus, onError }) {
  const [activeView, setActiveView] = useState("overview");
  const [selectedClaim, setSelectedClaim] = useState(null);
  const [claimLoading, setClaimLoading] = useState(false);
  const [claimError, setClaimError] = useState("");
  const [selectedInvestigation, setSelectedInvestigation] = useState(null);
  const [investigationDetail, setInvestigationDetail] = useState(null);
  const [investigationLoading, setInvestigationLoading] = useState(false);
  const [investigationError, setInvestigationError] = useState("");
  const [investigators, setInvestigators] = useState([]);
  const [resetConfirmation, setResetConfirmation] = useState("");
  const [syncing, setSyncing] = useState(false);
  const detailRequest = useRef(0);
  const syncAttempt = useRef(0);
  const syncingRef = useRef(false);
  const initialSyncStarted = useRef(false);
  const claims = status.cache?.claims || [];
  const investigations = status.cache?.investigations || [];
  const summary = status.cache?.dashboard?.summary || {};
  const network = status.cache?.suspiciousNetwork || {};
  const capabilities = status.session?.clientCapabilities || [];
  const canViewInvestigations = capabilities.includes("investigations.view");
  const canCreateInvestigations = capabilities.includes("investigations.create");
  const canAssignInvestigations = capabilities.includes("investigations.assign");
  const writesAllowed = operationalWriteAllowed(status);

  useEffect(() => {
    let active = true;
    if (!canAssignInvestigations || !writesAllowed) {
      setInvestigators([]);
      return undefined;
    }
    desktopBridge.investigators()
      .then((result) => { if (active) setInvestigators(result.investigators || []); })
      .catch((error) => { if (active) onError(error?.message || "Investigator assignment is unavailable."); });
    return () => { active = false; };
  }, [canAssignInvestigations, onError, status.session?.user?.userId, writesAllowed]);

  const syncNow = useCallback(async () => {
    if (syncingRef.current || !status.authenticated || status.locked) return null;
    syncingRef.current = true;
    setSyncing(true);
    onStatus((previous) => ({ ...previous, cache: { ...previous.cache, freshness: "Synchronizing" } }));
    try {
      const next = await desktopBridge.sync();
      syncAttempt.current = 0;
      onStatus(next);
      return next;
    } catch (error) {
      syncAttempt.current += 1;
      onError(error?.message || "Synchronization failed. Cached data remains read-only.", true);
      return null;
    } finally {
      syncingRef.current = false;
      setSyncing(false);
    }
  }, [onError, onStatus, status.authenticated, status.locked]);

  useEffect(() => {
    if (initialSyncStarted.current) return undefined;
    initialSyncStarted.current = true;
    const initial = window.setTimeout(syncNow, 0);
    return () => window.clearTimeout(initial);
  }, [syncNow]);

  useEffect(() => {
    const delay = status.syncHasMore ? 250 : nextBackoff(syncAttempt.current, { active: document.visibilityState === "visible" });
    const timer = window.setTimeout(syncNow, delay);
    return () => window.clearTimeout(timer);
  }, [status.cache?.lastSuccessfulSyncAt, status.error, status.syncHasMore, syncNow]);

  useEffect(() => {
    let timer;
    const arm = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(async () => {
        await desktopBridge.lock();
        onStatus((previous) => ({ ...previous, locked: true, lockReason: "automatic_lock" }));
      }, AUTO_LOCK_MS);
    };
    const events = ["pointerdown", "keydown", "focus"];
    events.forEach((event) => window.addEventListener(event, arm, { passive: true }));
    arm();
    return () => { window.clearTimeout(timer); events.forEach((event) => window.removeEventListener(event, arm)); };
  }, [onStatus]);

  const openClaim = useCallback(async (claimOrId) => {
    const claimId = typeof claimOrId === "string" ? claimOrId : claimOrId?.claimId;
    if (!claimId) return;
    const request = ++detailRequest.current;
    const cached = claims.find((claim) => claim.claimId === claimId) || (typeof claimOrId === "object" ? claimOrId : null);
    setSelectedInvestigation(null);
    setInvestigationDetail(null);
    setInvestigationLoading(false);
    setInvestigationError("");
    setSelectedClaim(cached ? { claim: cached } : null);
    setClaimError("");
    setClaimLoading(true);
    try {
      const detail = await desktopBridge.claimDetails(claimId);
      if (detailRequest.current === request) setSelectedClaim(detail);
    } catch (error) {
      const message = error?.message || "Claim details are unavailable.";
      if (detailRequest.current === request) {
        setClaimError(message);
        onError(message, status.cache?.freshness === "Offline");
      }
    } finally {
      if (detailRequest.current === request) setClaimLoading(false);
    }
  }, [claims, onError, status.cache?.freshness]);

  const openInvestigation = useCallback(async (compact) => {
    const investigationId = compact?.investigationId;
    if (!investigationId) return;
    const request = ++detailRequest.current;
    const cached = investigations.find((item) => item.investigationId === investigationId) || compact;
    setSelectedClaim(null);
    setClaimLoading(false);
    setClaimError("");
    setSelectedInvestigation(cached);
    setInvestigationDetail(null);
    setInvestigationError("");
    setInvestigationLoading(true);
    try {
      const detail = await desktopBridge.investigationDetails(investigationId);
      if (detailRequest.current === request) setInvestigationDetail(detail);
    } catch (error) {
      const message = error?.message || "Investigation details are unavailable.";
      if (detailRequest.current === request) {
        setInvestigationError(message);
        onError(message, status.cache?.freshness === "Offline");
      }
    } finally {
      if (detailRequest.current === request) setInvestigationLoading(false);
    }
  }, [investigations, onError, status.cache?.freshness]);

  const createInvestigation = useCallback(async (claim, input) => {
    setClaimError("");
    try {
      const result = await desktopBridge.createInvestigation(
        claim.claimId,
        claim.currentClaimVersion,
        input.assignedInvestigator,
        input.priority,
      );
      onStatus(result.status);
      setSelectedClaim((previous) => previous?.claim ? {
        ...previous,
        claim: { ...previous.claim, investigation: result.investigation },
      } : previous);
      await openInvestigation(result.investigation);
    } catch (error) {
      const message = error?.message || "The investigation could not be created.";
      if (error?.code === "STALE_RECORD_VERSION") {
        await openClaim(claim.claimId);
        const staleMessage = "The claim changed on the server. It was refreshed; review it before creating the case.";
        setClaimError(staleMessage);
        onError(staleMessage);
      } else {
        setClaimError(message);
        onError(message, message.toLowerCase().includes("unavailable"));
      }
    }
  }, [onError, onStatus, openClaim, openInvestigation]);

  const updateInvestigation = useCallback(async (record, changes) => {
    setInvestigationError("");
    try {
      const result = await desktopBridge.updateInvestigation(record.investigationId, record.recordVersion, changes);
      onStatus(result.status);
      if (result.investigation.status === "CLOSED") {
        setSelectedInvestigation(null);
        setInvestigationDetail(null);
      } else {
        setSelectedInvestigation(result.investigation);
        setInvestigationDetail((previous) => previous ? {
          ...previous,
          investigation: { ...previous.investigation, ...result.investigation },
        } : { available: true, investigation: result.investigation });
      }
    } catch (error) {
      const message = error?.message || "The investigation could not be updated.";
      if (error?.code === "STALE_RECORD_VERSION") {
        await syncNow();
        try {
          const refreshed = await desktopBridge.investigationDetails(record.investigationId);
          setInvestigationDetail(refreshed);
          setSelectedInvestigation(refreshed.investigation);
        } catch {
          setSelectedInvestigation(null);
          setInvestigationDetail(null);
        }
        const staleMessage = "The investigation changed on the server. The queue was refreshed; review it before trying again.";
        setInvestigationError(staleMessage);
        onError(staleMessage);
      } else {
        setInvestigationError(message);
        onError(message, message.toLowerCase().includes("unavailable"));
      }
    }
  }, [onError, onStatus, syncNow]);

  const refreshAfterInvestigationMutation = useCallback(async (result) => {
    setInvestigationError("");
    onStatus(result.status);
    setSelectedInvestigation(result.investigation);
    const refreshed = await desktopBridge.investigationDetails(result.investigation.investigationId);
    setInvestigationDetail(refreshed);
    setSelectedInvestigation(refreshed.investigation);
  }, [onStatus]);

  const addInvestigationNote = useCallback(async (record, input) => {
    setInvestigationError("");
    try {
      const result = await desktopBridge.addInvestigationNote(record.investigationId, record.recordVersion, input.text, input.noteType);
      await refreshAfterInvestigationMutation(result);
    } catch (error) {
      const message = error?.message || "The investigation note could not be added.";
      if (error?.code === "STALE_RECORD_VERSION") await openInvestigation(record);
      const detailMessage = error?.code === "STALE_RECORD_VERSION" ? "The investigation changed on the server. It was refreshed; review it before adding the note." : message;
      setInvestigationError(detailMessage);
      onError(detailMessage, message.toLowerCase().includes("unavailable"));
    }
  }, [onError, openInvestigation, refreshAfterInvestigationMutation]);

  const uploadInvestigationEvidence = useCallback(async (record, input) => {
    setInvestigationError("");
    try {
      const result = await desktopBridge.uploadInvestigationEvidence(record.investigationId, record.recordVersion, input);
      await refreshAfterInvestigationMutation(result);
    } catch (error) {
      const message = error?.message || "The evidence could not be uploaded.";
      if (error?.code === "STALE_RECORD_VERSION") await openInvestigation(record);
      const detailMessage = error?.code === "STALE_RECORD_VERSION" ? "The investigation changed on the server. It was refreshed; review it before uploading evidence." : message;
      setInvestigationError(detailMessage);
      onError(detailMessage, message.toLowerCase().includes("unavailable"));
    }
  }, [onError, openInvestigation, refreshAfterInvestigationMutation]);

  const closeClaim = useCallback(() => {
    detailRequest.current += 1;
    setSelectedClaim(null);
    setClaimLoading(false);
    setClaimError("");
  }, []);

  const closeInvestigation = useCallback(() => {
    detailRequest.current += 1;
    setSelectedInvestigation(null);
    setInvestigationDetail(null);
    setInvestigationLoading(false);
    setInvestigationError("");
  }, []);

  async function signOut() {
    await desktopBridge.logout();
    onStatus(await desktopBridge.status());
  }

  async function lock() {
    await desktopBridge.lock();
    onStatus((previous) => ({ ...previous, locked: true, lockReason: "manual_lock" }));
  }

  async function reset() {
    await desktopBridge.reset(resetConfirmation);
    onStatus(await desktopBridge.status());
  }

  const navigation = [
    { id: "overview", label: "Overview", icon: BarChart3 },
    { id: "claims", label: "Claims", icon: FileSearch },
    ...(canViewInvestigations ? [{ id: "investigations", label: "Investigations", icon: AlertTriangle, count: investigations.length }] : []),
    { id: "risk", label: "Risk signals", icon: Network },
  ];

  return <div className="min-h-screen bg-background text-foreground"><header className="desktop-drag-region sticky top-0 z-30 border-b border-border bg-card"><div className="flex min-h-16 items-center gap-4 px-5"><WorkspaceBrand /><nav aria-label="Desktop workspace" className="desktop-no-drag hidden items-center gap-1 lg:flex">{navigation.map(({ id, label, icon: Icon, count }) => <button type="button" key={id} onClick={() => setActiveView(id)} className={`inline-flex h-9 items-center gap-2 rounded-lg px-3 text-sm font-medium ${activeView === id ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-secondary hover:text-foreground"}`}><Icon className="h-4 w-4" />{label}{count !== undefined ? <span className={`rounded-full px-1.5 py-0.5 font-data text-[10px] ${activeView === id ? "bg-primary-foreground/15" : "bg-background"}`}>{count}</span> : null}</button>)}</nav><div className="desktop-no-drag ml-auto flex items-center gap-2"><div className="hidden rounded-lg border border-border bg-background px-3 py-2 xl:block"><span className="text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">Licensed to </span><span className="text-sm font-semibold" data-testid="licensed-organisation">{status.enrollment.organisationDisplayName}</span></div><div className={`inline-flex items-center gap-2 rounded-lg border px-3 py-2 ${freshnessClasses(status.cache?.freshness)}`}><span className="h-2 w-2 rounded-full bg-current" /><span className="text-xs font-semibold">{status.cache?.freshness || "Stale"}</span></div><Button variant="outline" size="sm" onClick={syncNow} disabled={syncing}><RefreshCw className={`mr-2 h-4 w-4 ${syncing ? "animate-spin" : ""}`} />Sync</Button><Button variant="ghost" size="sm" onClick={lock}><LockKeyhole className="h-4 w-4" /><span className="sr-only">Lock</span></Button><Button variant="ghost" size="sm" onClick={signOut}><LogOut className="h-4 w-4" /><span className="sr-only">Sign out</span></Button></div></div><nav aria-label="Desktop workspace mobile" className="desktop-no-drag flex gap-1 overflow-x-auto border-t border-border px-3 py-2 lg:hidden">{navigation.map(({ id, label, icon: Icon, count }) => <button type="button" key={id} onClick={() => setActiveView(id)} className={`inline-flex shrink-0 items-center gap-2 rounded-lg px-3 py-2 text-xs font-medium ${activeView === id ? "bg-primary text-primary-foreground" : "text-muted-foreground"}`}><Icon className="h-4 w-4" />{label}{count !== undefined ? ` ${count}` : ""}</button>)}</nav></header>

    <main className="mx-auto max-w-[1500px] space-y-6 p-5 sm:p-7"><section className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between"><div><p className="font-data text-xs font-semibold uppercase tracking-[0.18em] text-primary">Scheme intelligence</p><h1 className="mt-2 font-display text-3xl font-semibold">{navigation.find((item) => item.id === activeView)?.label || "Overview"}</h1><p className="mt-2 text-sm text-muted-foreground">Cached records render immediately; authoritative changes require a verified connection.</p></div><div className="flex items-center gap-2 text-xs text-muted-foreground"><Clock3 className="h-4 w-4" />Last successful sync {displayDate(status.cache?.lastSuccessfulSyncAt)}</div></section>
      {status.error ? <div role="alert" className="rounded-xl border border-rose-500/30 bg-rose-500/10 p-4 text-sm text-rose-700 dark:text-rose-300">{status.error}</div> : null}
      {!writesAllowed ? <div className="flex gap-3 rounded-xl border border-amber-500/30 bg-amber-500/10 p-4 text-sm text-amber-800 dark:text-amber-200"><WifiOff className="h-5 w-5 shrink-0" /><div><p className="font-semibold">Offline data is read-only</p><p className="mt-1">Investigation creation, priority, assignment, notes, evidence, and governed actions are blocked until authoritative connectivity returns. Historical investigation status remains read-only. Scheme device and activation-key management remains on the ClaimGuard web application.</p></div></div> : null}
      {activeView === "overview" ? <Overview claims={claims} investigations={investigations} summary={summary} network={network} openClaim={openClaim} openInvestigation={openInvestigation} canViewInvestigations={canViewInvestigations} /> : null}
      {activeView === "claims" ? <ClaimsView claims={claims} openClaim={openClaim} /> : null}
      {activeView === "investigations" && canViewInvestigations ? <InvestigationsView investigations={investigations} selection={null} detail={null} loading={false} writesAllowed={writesAllowed} capabilities={capabilities} investigators={investigators} openInvestigation={openInvestigation} closeInvestigation={closeInvestigation} updateInvestigation={updateInvestigation} addInvestigationNote={addInvestigationNote} uploadInvestigationEvidence={uploadInvestigationEvidence} openClaimById={openClaim} /> : null}
      {activeView === "risk" ? <RiskSignalsView network={network} openClaimById={openClaim} /> : null}
      <details className="rounded-xl border border-border bg-card p-4"><summary className="cursor-pointer text-sm font-semibold">Reset this device</summary><div className="mt-4 max-w-xl space-y-3"><p className="text-sm text-muted-foreground">This local recovery action permanently deletes this Windows user’s encrypted cache, session material, device key, and organisation enrollment. A web administrator must issue a new activation key.</p><label className="grid gap-2 text-sm font-medium">Type RESET CLAIMGUARD<Input value={resetConfirmation} onChange={(event) => setResetConfirmation(event.target.value)} /></label><Button variant="destructive" onClick={reset} disabled={resetConfirmation !== "RESET CLAIMGUARD"}><RotateCcw className="mr-2 h-4 w-4" />Delete cache and reset organisation</Button></div></details>
    </main>
    <DetailOverlay labelId="claim-detail-title" onClose={closeClaim} open={Boolean(selectedClaim || claimLoading || claimError)}>
      <ClaimDetail payload={selectedClaim} loading={claimLoading} error={claimError} offline={status.cache?.freshness === "Offline"} onClose={closeClaim} onOpenInvestigation={openInvestigation} onCreateInvestigation={createInvestigation} canViewInvestigations={canViewInvestigations} canCreateInvestigations={canCreateInvestigations} canAssignInvestigations={canAssignInvestigations} investigators={investigators} writesAllowed={writesAllowed} />
    </DetailOverlay>
    <DetailOverlay labelId="investigation-detail-title" onClose={closeInvestigation} open={Boolean(selectedInvestigation || investigationLoading || investigationError)}>
      <InvestigationWorkspace compact={selectedInvestigation} detail={investigationDetail} loading={investigationLoading} error={investigationError} offline={status.cache?.freshness === "Offline"} writesAllowed={writesAllowed} canChangePriority={capabilities.includes("investigations.change_priority")} canAssign={capabilities.includes("investigations.assign")} canAddNote={capabilities.includes("investigations.add_note")} canUploadEvidence={capabilities.includes("investigations.upload_evidence")} investigators={investigators} onSave={updateInvestigation} onAddNote={addInvestigationNote} onUploadEvidence={uploadInvestigationEvidence} onClose={closeInvestigation} onOpenClaim={openClaim} />
    </DetailOverlay>
  </div>;
}

export { ClaimDetail, ClaimsView };
