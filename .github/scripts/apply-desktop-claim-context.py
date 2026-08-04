from __future__ import annotations

import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def replace_once(text: str, old: str, new: str, label: str) -> str:
    count = text.count(old)
    if count != 1:
        raise RuntimeError(f"{label}: expected one match, found {count}")
    return text.replace(old, new, 1)


def regex_once(text: str, pattern: str, replacement: str, label: str) -> str:
    updated, count = re.subn(pattern, replacement, text, count=1, flags=re.S)
    if count != 1:
        raise RuntimeError(f"{label}: expected one match, found {count}")
    return updated


def patch_claims_repository() -> None:
    path = ROOT / "packages/database/src/claims-read-repository.js"
    text = path.read_text()

    text = regex_once(
        text,
        r'''function memberDisplayName\(firstName, lastName\) \{.*?\n\}\n\nfunction memberPresentation\(row\) \{.*?\n\}\n\nfunction providerPresentation\(row\) \{.*?\n\}\n''',
        '''function memberDisplayName(firstName, lastName) {
  const names = [displayText(firstName), displayText(lastName)].filter(Boolean);
  return names.length > 0 ? names.join(" ") : null;
}

function memberPresentation(row) {
  return {
    displayName: memberDisplayName(row.member_first_name, row.member_last_name),
    dateOfBirth: row.member_date_of_birth || null,
    gender: displayText(row.member_gender),
    homeRegion: displayText(row.member_home_region),
    joinDate: row.member_join_date || null,
  };
}

function providerPresentation(row) {
  return {
    displayName: displayText(row.provider_practice_name),
    practiceNumber: displayText(row.provider_practice_number),
    specialty: displayText(row.provider_specialty),
    kind: displayText(row.provider_kind),
    category: displayText(row.provider_category),
    region: displayText(row.provider_region),
  };
}

function calendarDayDifference(start, end) {
  if (!start || !end) return null;
  const startDate = new Date(`${String(start).slice(0, 10)}T00:00:00.000Z`);
  const endDate = new Date(`${String(end).slice(0, 10)}T00:00:00.000Z`);
  if (!Number.isFinite(startDate.getTime()) || !Number.isFinite(endDate.getTime())) return null;
  return Math.round((endDate.getTime() - startDate.getTime()) / 86_400_000);
}
''',
        "rich identity presentation",
    )

    minimal_identity = '''            m.first_name AS member_first_name,
            m.last_name AS member_last_name,
            p.practice_name AS provider_practice_name,
            p.practice_number AS provider_practice_number,
            p.specialty AS provider_specialty,
            p.practice_region AS provider_region,'''
    rich_identity = '''            m.first_name AS member_first_name,
            m.last_name AS member_last_name,
            m.date_of_birth AS member_date_of_birth,
            m.gender AS member_gender,
            m.home_region AS member_home_region,
            m.join_date AS member_join_date,
            p.practice_name AS provider_practice_name,
            p.practice_number AS provider_practice_number,
            p.specialty AS provider_specialty,
            p.provider_kind AS provider_kind,
            p.provider_category AS provider_category,
            p.practice_region AS provider_region,'''
    count = text.count(minimal_identity)
    if count < 4:
        raise RuntimeError(f"identity select projection: expected at least 4 matches, found {count}")
    text = text.replace(minimal_identity, rich_identity)

    minimal_claim = '''            c.service_date,
            c.amount,
            c.billing_code,
            c.created_at,'''
    rich_claim = '''            c.service_date,
            c.received_date,
            c.amount,
            c.quantity,
            c.billing_code,
            c.benefit_option,
            c.network_type,
            c.line_type,
            c.tariff_discipline,
            c.diagnosis_code,
            c.rendering_practitioner_id,
            c.rendering_practitioner_category,
            c.rendering_known_to_billing_provider,
            c.created_at,'''
    count = text.count(minimal_claim)
    if count != 3:
        raise RuntimeError(f"claim classification select projection: expected 3 matches, found {count}")
    text = text.replace(minimal_claim, rich_claim)

    text = replace_once(
        text,
        '''    serviceDate: row.service_date,
    billedAmount: Number(row.amount),
    billingCode: row.billing_code,
    submittedAt: row.created_at,''',
        '''    serviceDate: row.service_date,
    receivedDate: row.received_date || null,
    submissionLagDays: calendarDayDifference(row.service_date, row.received_date),
    billedAmount: Number(row.amount),
    quantity: Number(row.quantity),
    billingCode: row.billing_code,
    benefitOption: displayText(row.benefit_option),
    networkType: displayText(row.network_type),
    lineType: displayText(row.line_type),
    tariffDiscipline: displayText(row.tariff_discipline),
    diagnosisCode: displayText(row.diagnosis_code),
    billingProviderKind: displayText(row.provider_kind),
    billingProviderCategory: displayText(row.provider_category),
    renderingPractitionerId: displayText(row.rendering_practitioner_id),
    renderingPractitionerCategory: displayText(row.rendering_practitioner_category),
    renderingKnownToBillingProvider: booleanValue(row.rendering_known_to_billing_provider),
    submittedAt: row.created_at,''',
        "claim mapper classification",
    )

    text = replace_once(
        text,
        '''    currentClaimVersion: claim.currentClaimVersion,
    member: claim.member,
    provider: claim.provider,
    serviceDate: claim.serviceDate,
    billedAmount: claim.billedAmount,
    billingCode: claim.billingCode,''',
        '''    currentClaimVersion: claim.currentClaimVersion,
    memberId: claim.memberId,
    providerId: claim.providerId,
    member: claim.member,
    provider: claim.provider,
    serviceDate: claim.serviceDate,
    receivedDate: claim.receivedDate,
    submissionLagDays: claim.submissionLagDays,
    billedAmount: claim.billedAmount,
    quantity: claim.quantity,
    billingCode: claim.billingCode,
    benefitOption: claim.benefitOption,
    networkType: claim.networkType,
    lineType: claim.lineType,
    tariffDiscipline: claim.tariffDiscipline,
    diagnosisCode: claim.diagnosisCode,
    billingProviderKind: claim.billingProviderKind,
    billingProviderCategory: claim.billingProviderCategory,
    renderingPractitionerId: claim.renderingPractitionerId,
    renderingPractitionerCategory: claim.renderingPractitionerCategory,
    renderingKnownToBillingProvider: claim.renderingKnownToBillingProvider,''',
        "desktop claim mapper rich fields",
    )

    path.write_text(text)


def patch_ingestion_reference_sync() -> None:
    path = ROOT / "packages/database/src/claim-ingestion-repository.js"
    text = path.read_text()

    text = replace_once(
        text,
        '''  if (existingOwner) {
    await connection.execute(
      updateSql,
      [
        ...updateParams,
        entityId,
        tenantId,
      ],
    );

    return "updated";
  }''',
        '''  if (existingOwner) {
    const [result] = await connection.execute(
      updateSql,
      [
        ...updateParams,
        entityId,
        tenantId,
      ],
    );

    return {
      disposition: "updated",
      changed: Number(result?.changedRows ?? result?.affectedRows ?? 0) > 0,
    };
  }''',
        "existing reference update result",
    )

    text = replace_once(
        text,
        '''    return "inserted";''',
        '''    return { disposition: "inserted", changed: true };''',
        "reference insert result",
    )

    text = replace_once(
        text,
        '''    await connection.execute(
      updateSql,
      [
        ...updateParams,
        entityId,
        tenantId,
      ],
    );

    return "updated";''',
        '''    const [result] = await connection.execute(
      updateSql,
      [
        ...updateParams,
        entityId,
        tenantId,
      ],
    );

    return {
      disposition: "updated",
      changed: Number(result?.changedRows ?? result?.affectedRows ?? 0) > 0,
    };''',
        "raced reference update result",
    )

    text = replace_once(
        text,
        '''function recordWrite(
  summary,
  result,
) {
  summary[result] += 1;
}''',
        '''async function touchClaimsForReference(connection, {
  tenantId,
  schemeId,
  referenceType,
  referenceId,
}) {
  const column = referenceType === "member" ? "member_id"
    : referenceType === "provider" ? "provider_id"
      : null;
  if (!column) throw new TypeError("Unsupported claim reference type.");
  await connection.execute(
    `UPDATE claims
     SET updated_at = UTC_TIMESTAMP(3)
     WHERE tenant_id = ?
       AND scheme_id = ?
       AND ${column} = ?`,
    [tenantId, schemeId, referenceId],
  );
}

function recordWrite(summary, result) {
  summary[result.disposition] += 1;
}''',
        "reference sync touch helper",
    )

    text = replace_once(
        text,
        '''    recordWrite(
      summary.members,
      result,
    );

    referenceCache.add(''',
        '''    recordWrite(
      summary.members,
      result,
    );

    if (result.changed) {
      await touchClaimsForReference(connection, {
        tenantId,
        schemeId: member.scheme_id,
        referenceType: "member",
        referenceId: member.member_id,
      });
    }

    referenceCache.add(''',
        "member reference claim touch",
    )

    text = replace_once(
        text,
        '''    recordWrite(
      summary.providers,
      result,
    );

    referenceCache.add(''',
        '''    recordWrite(
      summary.providers,
      result,
    );

    if (result.changed) {
      await touchClaimsForReference(connection, {
        tenantId,
        schemeId: provider.scheme_id,
        referenceType: "provider",
        referenceId: provider.provider_id,
      });
    }

    referenceCache.add(''',
        "provider reference claim touch",
    )

    path.write_text(text)


def patch_ingestion_test_stub() -> None:
    path = ROOT / "packages/database/tests/claim-ingestion-repository.test.js"
    text = path.read_text()
    anchor = '''          /*
           * Current-claim pointer and
           * canonical projection update.
           */
          if (
            statement.startsWith(
              "UPDATE claims SET current_claim_version",
            )
          ) {'''
    replacement = '''          /*
           * Reference updates advance the existing
           * claim synchronization cursor without
           * changing claim content or model scores.
           */
          if (
            statement.startsWith(
              "UPDATE claims SET updated_at = UTC_TIMESTAMP(3)",
            )
          ) {
            return [{ affectedRows: 0, changedRows: 0 }];
          }

''' + anchor
    text = replace_once(text, anchor, replacement, "ingestion test reference touch stub")
    path.write_text(text)


def patch_desktop_ui() -> None:
    path = ROOT / "apps/desktop/src/DesktopWorkspace.jsx"
    text = path.read_text()

    replacement = r'''function inputNoveltySignals(claim, feature) {
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

function InvestigationWorkspace'''

    text = regex_once(
        text,
        r'''function ClaimDetail\(\{.*?\nfunction InvestigationWorkspace''',
        replacement,
        "desktop rich claim detail and list",
    )

    if "export { ClaimDetail, ClaimsView };" not in text:
        text += "\nexport { ClaimDetail, ClaimsView };\n"
    path.write_text(text)


def write_database_test() -> None:
    path = ROOT / "packages/database/tests/desktop-claim-context.test.js"
    path.write_text('''import assert from "node:assert/strict";
import test from "node:test";

import { createClaimsReadRepository } from "../src/claims-read-repository.js";
import { CANONICAL_OPERATIONAL_SCHEMA_VERSION } from "../src/operational-schema.js";

function context() {
  return {
    organisationId: "org-context-test",
    organisationType: "medical_scheme",
    organisationStatus: "active",
    routeId: "route-context-test",
    routeType: "legacy_shared",
    routeGeneration: 1,
    operationalTenantId: "tenant-context",
    operationalTenantSlug: "context-test",
    logicalDatabaseIdentifier: "legacy-operational-shared",
    databaseName: "operational",
    schemaVersion: CANONICAL_OPERATIONAL_SCHEMA_VERSION,
    deploymentClass: "demo",
    region: "southafricanorth",
  };
}

const row = {
  claim_id: "claim-context-1",
  current_claim_version: 2,
  scheme_id: "SCHEME-A",
  member_id: "MEMBER-8F1A",
  provider_id: "PROVIDER-7B2C",
  member_first_name: "Amahle",
  member_last_name: "Nkosi",
  member_date_of_birth: "1992-04-12",
  member_gender: "F",
  member_home_region: "Gauteng",
  member_join_date: "2020-01-15",
  provider_practice_name: "Dr Priya Naidoo Family Practice With A Long but Valid Facility Name",
  provider_practice_number: "PR-1001",
  provider_specialty: "General Practice",
  provider_kind: "PRACTICE",
  provider_category: "GENERAL_PRACTITIONER",
  provider_region: "Gauteng",
  service_date: "2026-07-20",
  received_date: "2026-07-23",
  amount: "1250.50",
  quantity: "2.000",
  billing_code: "0190",
  benefit_option: "COMPREHENSIVE",
  network_type: "DSP",
  line_type: "PROFESSIONAL_SERVICE",
  tariff_discipline: "014",
  diagnosis_code: "Z76.0",
  rendering_practitioner_id: "RP-200",
  rendering_practitioner_category: "MEDICAL_PRACTITIONER",
  rendering_known_to_billing_provider: 1,
  created_at: "2026-07-23T08:00:00.000Z",
  updated_at: "2026-07-23T08:00:00.000Z",
  sync_updated_at: "2026-07-23T08:00:00.000Z",
};

function pool() {
  const calls = [];
  return {
    calls,
    async execute(sql) {
      calls.push(sql);
      if (sql.includes("AS sync_updated_at")) return [[row]];
      if (sql.includes("FROM claim_detection_results")) return [[{
        claim_id: row.claim_id,
        claim_version: 2,
        detection_strategy_id: 7,
        strategy_type: "approved_model",
        model_deployment_id: "model:sealed",
        analysis_mode: "PROSPECTIVE_CLAIM_SCREENING",
        scored_at: "2026-07-23T08:01:00.000Z",
        result_payload: JSON.stringify({
          score: { fraudProbability: 0.8, threshold: 0.4, reviewRecommended: true },
          inputDrift: {
            status: "WATCH",
            signals: [{ feature: "diagnosis_code", kind: "UNSEEN_CATEGORY", observed: "Z76.0", expected: "training vocabulary" }],
            message: "One unfamiliar model input was detected.",
          },
        }),
      }]];
      if (sql.includes("FROM claim_processing_outbox")) return [[]];
      if (sql.includes("FROM investigations i")) return [[]];
      throw new Error(`Unexpected SQL: ${sql}`);
    },
  };
}

test("desktop sync carries human identities and raw model inputs without changing the persisted score", async () => {
  const fake = pool();
  const repository = createClaimsReadRepository(fake, { dataPlaneContext: context() });
  const result = await repository.listDesktopClaimChanges({ scopeStart: "2026-05-01T00:00:00.000Z" });
  const claim = result.changes[0].record;

  assert.equal(claim.member.displayName, "Amahle Nkosi");
  assert.equal(claim.memberId, "MEMBER-8F1A");
  assert.deepEqual(claim.member, {
    displayName: "Amahle Nkosi",
    dateOfBirth: "1992-04-12",
    gender: "F",
    homeRegion: "Gauteng",
    joinDate: "2020-01-15",
  });
  assert.equal(claim.provider.displayName.includes("Priya Naidoo"), true);
  assert.equal(claim.providerId, "PROVIDER-7B2C");
  assert.equal(claim.provider.kind, "PRACTICE");
  assert.equal(claim.provider.category, "GENERAL_PRACTITIONER");
  assert.equal(claim.diagnosisCode, "Z76.0");
  assert.equal(claim.receivedDate, "2026-07-23");
  assert.equal(claim.submissionLagDays, 3);
  assert.equal(claim.renderingKnownToBillingProvider, true);
  assert.equal(claim.riskScore, 100);

  const query = fake.calls.find((sql) => sql.includes("AS sync_updated_at"));
  assert.match(query, /m\\.tenant_id = c\\.tenant_id/);
  assert.match(query, /m\\.scheme_id = c\\.scheme_id/);
  assert.match(query, /p\\.tenant_id = c\\.tenant_id/);
  assert.match(query, /p\\.scheme_id = c\\.scheme_id/);
  assert.match(query, /c\\.diagnosis_code/);
  assert.match(query, /p\\.provider_category/);
});

test("reference-data ingestion advances linked claim cursors only after a real reference change", async () => {
  const source = await import("node:fs/promises").then(({ readFile }) => readFile(new URL("../src/claim-ingestion-repository.js", import.meta.url), "utf8"));
  assert.match(source, /changedRows \\?\\? result\\?\\.affectedRows/);
  assert.match(source, /if \(result\\.changed\)[\\s\\S]*referenceType: "member"/);
  assert.match(source, /if \(result\\.changed\)[\\s\\S]*referenceType: "provider"/);
  assert.match(source, /UPDATE claims[\\s\\S]*SET updated_at = UTC_TIMESTAMP\\(3\\)[\\s\\S]*tenant_id = \\?[\\s\\S]*scheme_id = \\?/);
});
''')


def write_desktop_test() -> None:
    path = ROOT / "apps/desktop/src/DesktopClaimContext.test.jsx"
    path.write_text('''import React from "react";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { ClaimDetail, ClaimsView } from "./DesktopWorkspace";

const richClaim = {
  claimId: "CLAIM-RICH-1",
  currentClaimVersion: 4,
  memberId: "8F1A-MEMBER",
  providerId: "7B2C-PROVIDER",
  member: { displayName: "Amahle Nkosi", dateOfBirth: "1992-04-12", gender: "F", homeRegion: "Gauteng", joinDate: "2020-01-15" },
  provider: { displayName: "Dr Priya Naidoo Family Practice With An Exceptionally Long Facility Name That Must Wrap", practiceNumber: "PR-1001", specialty: "General Practice", kind: "PRACTICE", category: "GENERAL_PRACTITIONER", region: "Gauteng" },
  serviceDate: "2026-07-20",
  receivedDate: "2026-07-23",
  submissionLagDays: 3,
  billedAmount: 1250.5,
  quantity: 2,
  billingCode: "0190",
  benefitOption: "COMPREHENSIVE",
  networkType: "DSP",
  lineType: "PROFESSIONAL_SERVICE",
  tariffDiscipline: "014",
  diagnosisCode: "Z76.0",
  billingProviderKind: "PRACTICE",
  billingProviderCategory: "GENERAL_PRACTITIONER",
  renderingPractitionerId: "RP-200",
  renderingPractitionerCategory: "MEDICAL_PRACTITIONER",
  renderingKnownToBillingProvider: true,
  status: "FLAGGED",
  processingStatus: "scored",
  riskScore: 82,
  riskLevel: "High",
  evidence: ["One unfamiliar model input was detected."],
  triggeredRules: ["MODEL_REVIEW_RECOMMENDED"],
  detection: {
    modelDeploymentId: "model:sealed",
    featureSchemaVersion: "claim-feature-schema-2026.2",
    scoredAt: "2026-07-23T08:01:00.000Z",
    inputDrift: {
      signals: [{ feature: "diagnosis_code", kind: "UNSEEN_CATEGORY", observed: "Z76.0" }],
    },
  },
};

function detail(claim = richClaim) {
  return render(<ClaimDetail payload={{ claim, fetchedAt: "2026-07-23T08:02:00.000Z" }} loading={false} error="" offline={false} onClose={vi.fn()} onOpenInvestigation={vi.fn()} onCreateInvestigation={vi.fn()} canViewInvestigations={false} canCreateInvestigations={false} canAssignInvestigations={false} investigators={[]} writesAllowed />);
}

describe("desktop claim investigation context", () => {
  it("renders patient, provider, classification, model, and novelty context without changing the score", () => {
    detail();
    expect(screen.getByRole("heading", { name: "Patient" })).toBeInTheDocument();
    expect(screen.getByText("Amahle Nkosi")).toBeInTheDocument();
    expect(screen.getByText(/Member ID: 8F1A-MEMBER/)).toBeInTheDocument();
    expect(screen.getByText(/Dr Priya Naidoo Family Practice/)).toHaveClass("break-words");
    expect(screen.getByText(/Provider ID: 7B2C-PROVIDER/)).toBeInTheDocument();
    const classification = screen.getByRole("heading", { name: "Claim Classification" }).closest("section");
    expect(within(classification).getByText("Z76.0")).toBeInTheDocument();
    expect(within(classification).getByText("PROFESSIONAL_SERVICE")).toBeInTheDocument();
    expect(within(classification).getByText("3")).toBeInTheDocument();
    expect(screen.getAllByText("Unknown to deployed model").length).toBeGreaterThan(0);
    expect(screen.getByText(/does not by itself prove that the claim is fraudulent/i)).toBeInTheDocument();
    expect(screen.getByText("82.0 risk")).toBeInTheDocument();
  });

  it("uses safe identity fallbacks while keeping identifiers visible", () => {
    detail({ ...richClaim, member: null, provider: null });
    expect(screen.getByText("Unknown patient")).toBeInTheDocument();
    expect(screen.getByText("Unknown provider")).toBeInTheDocument();
    expect(screen.getByText(/Member ID: 8F1A-MEMBER/)).toBeInTheDocument();
    expect(screen.getByText(/Provider ID: 7B2C-PROVIDER/)).toBeInTheDocument();
  });

  it("shows ten cached claims initially, reveals more, and searches IDs and classifications", async () => {
    const claims = Array.from({ length: 12 }, (_, index) => ({
      ...richClaim,
      claimId: `CLAIM-${index + 1}`,
      memberId: `MEMBER-${index + 1}`,
      providerId: `PROVIDER-${index + 1}`,
      diagnosisCode: index === 11 ? "SEARCH-DX" : "I10",
      member: index === 0 ? null : { ...richClaim.member, displayName: `Patient ${index + 1}` },
      provider: index === 0 ? null : { ...richClaim.provider, displayName: `Provider ${index + 1}` },
    }));
    render(<ClaimsView claims={claims} openClaim={vi.fn()} />);
    expect(screen.getAllByRole("button", { name: "Open" })).toHaveLength(10);
    expect(screen.getByText("Unknown patient")).toBeInTheDocument();
    expect(screen.getByText(/Member ID: MEMBER-1/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Show more claims" }));
    expect(screen.getAllByRole("button", { name: "Open" })).toHaveLength(12);
    await userEvent.clear(screen.getByLabelText("Search claims"));
    await userEvent.type(screen.getByLabelText("Search claims"), "SEARCH-DX");
    expect(screen.getAllByRole("button", { name: "Open" })).toHaveLength(1);
    expect(screen.getByText("CLAIM-12")).toBeInTheDocument();
  });
});
''')


def main() -> None:
    patch_claims_repository()
    patch_ingestion_reference_sync()
    patch_ingestion_test_stub()
    patch_desktop_ui()
    write_database_test()
    write_desktop_test()
    (ROOT / ".github/workflows/apply-desktop-claim-context-once.yml").unlink(missing_ok=True)
    Path(__file__).unlink(missing_ok=True)


if __name__ == "__main__":
    main()
