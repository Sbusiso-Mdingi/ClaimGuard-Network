from __future__ import annotations

from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def replace_once(text: str, old: str, new: str, label: str) -> str:
    count = text.count(old)
    if count != 1:
        raise RuntimeError(f"{label}: expected one match, found {count}")
    return text.replace(old, new, 1)


def replace_exact_count(text: str, old: str, new: str, expected: int, label: str) -> str:
    count = text.count(old)
    if count != expected:
        raise RuntimeError(f"{label}: expected {expected} matches, found {count}")
    return text.replace(old, new)


def patch_backend() -> None:
    path = ROOT / "packages/database/src/claims-read-repository.js"
    text = path.read_text()

    text = replace_once(
        text,
        '''function referenceKey(claimId, claimVersion) {
  return `${claimId}\\u0000${claimVersion}`;
}

function parseJsonObject(value) {''',
        '''function referenceKey(claimId, claimVersion) {
  return `${claimId}\\u0000${claimVersion}`;
}

function displayText(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function memberDisplayName(firstName, lastName) {
  const canonicalFirstName = displayText(firstName);
  const canonicalLastName = displayText(lastName);
  const initial = canonicalFirstName?.charAt(0).toUpperCase() || null;
  if (initial && canonicalLastName) return `${initial}. ${canonicalLastName}`;
  return canonicalLastName || initial;
}

function memberPresentation(row) {
  return {
    displayName: memberDisplayName(row.member_first_name, row.member_last_name),
  };
}

function providerPresentation(row) {
  return {
    displayName: displayText(row.provider_practice_name),
    practiceNumber: displayText(row.provider_practice_number),
    specialty: displayText(row.provider_specialty),
    region: displayText(row.provider_region),
  };
}

function parseJsonObject(value) {''',
        "backend identity presentation helpers",
    )

    text = replace_once(
        text,
        '''    memberId: row.member_id,
    providerId: row.provider_id,
    serviceDate: row.service_date,''',
        '''    memberId: row.member_id,
    providerId: row.provider_id,
    member: memberPresentation(row),
    provider: providerPresentation(row),
    serviceDate: row.service_date,''',
        "backend claim mapper",
    )

    text = replace_once(
        text,
        '''    currentClaimVersion: claim.currentClaimVersion,
    serviceDate: claim.serviceDate,''',
        '''    currentClaimVersion: claim.currentClaimVersion,
    member: claim.member,
    provider: claim.provider,
    serviceDate: claim.serviceDate,''',
        "desktop claim mapper",
    )

    overview_columns = '''            c.member_id,
            c.provider_id,
            c.amount,'''
    overview_identity_columns = '''            c.member_id,
            c.provider_id,
            m.first_name AS member_first_name,
            m.last_name AS member_last_name,
            p.practice_name AS provider_practice_name,
            p.practice_number AS provider_practice_number,
            p.specialty AS provider_specialty,
            p.practice_region AS provider_region,
            c.amount,'''
    text = replace_once(text, overview_columns, overview_identity_columns, "overview identity columns")

    detailed_columns = '''            c.member_id,
            c.provider_id,
            c.service_date,'''
    detailed_identity_columns = '''            c.member_id,
            c.provider_id,
            m.first_name AS member_first_name,
            m.last_name AS member_last_name,
            p.practice_name AS provider_practice_name,
            p.practice_number AS provider_practice_number,
            p.specialty AS provider_specialty,
            p.practice_region AS provider_region,
            c.service_date,'''
    text = replace_exact_count(
        text,
        detailed_columns,
        detailed_identity_columns,
        3,
        "list, desktop sync and detail identity columns",
    )

    text = replace_once(
        text,
        '''          FROM claims c
          LEFT JOIN claim_detection_results d
            ON d.tenant_id = c.tenant_id''',
        '''          FROM claims c
          LEFT JOIN members m
            ON m.tenant_id = c.tenant_id
           AND m.scheme_id = c.scheme_id
           AND m.member_id = c.member_id
          LEFT JOIN providers p
            ON p.tenant_id = c.tenant_id
           AND p.scheme_id = c.scheme_id
           AND p.provider_id = c.provider_id
          LEFT JOIN claim_detection_results d
            ON d.tenant_id = c.tenant_id''',
        "overview identity joins",
    )

    text = replace_once(
        text,
        '''          FROM claims c
          WHERE c.tenant_id = ?
          ORDER BY c.updated_at DESC, c.claim_id ASC''',
        '''          FROM claims c
          LEFT JOIN members m
            ON m.tenant_id = c.tenant_id
           AND m.scheme_id = c.scheme_id
           AND m.member_id = c.member_id
          LEFT JOIN providers p
            ON p.tenant_id = c.tenant_id
           AND p.scheme_id = c.scheme_id
           AND p.provider_id = c.provider_id
          WHERE c.tenant_id = ?
          ORDER BY c.updated_at DESC, c.claim_id ASC''',
        "list claims identity joins",
    )

    text = replace_once(
        text,
        '''          FROM claims c
          LEFT JOIN claim_detection_results d
            ON d.tenant_id = c.tenant_id
           AND d.claim_id = c.claim_id
           AND d.claim_version = c.current_claim_version
          WHERE c.tenant_id = ?
            AND (''',
        '''          FROM claims c
          LEFT JOIN members m
            ON m.tenant_id = c.tenant_id
           AND m.scheme_id = c.scheme_id
           AND m.member_id = c.member_id
          LEFT JOIN providers p
            ON p.tenant_id = c.tenant_id
           AND p.scheme_id = c.scheme_id
           AND p.provider_id = c.provider_id
          LEFT JOIN claim_detection_results d
            ON d.tenant_id = c.tenant_id
           AND d.claim_id = c.claim_id
           AND d.claim_version = c.current_claim_version
          WHERE c.tenant_id = ?
            AND (''',
        "desktop sync identity joins",
    )

    text = replace_once(
        text,
        '''          FROM claims c
          WHERE c.tenant_id = ? AND c.claim_id = ?
          LIMIT 1''',
        '''          FROM claims c
          LEFT JOIN members m
            ON m.tenant_id = c.tenant_id
           AND m.scheme_id = c.scheme_id
           AND m.member_id = c.member_id
          LEFT JOIN providers p
            ON p.tenant_id = c.tenant_id
           AND p.scheme_id = c.scheme_id
           AND p.provider_id = c.provider_id
          WHERE c.tenant_id = ? AND c.claim_id = ?
          LIMIT 1''',
        "claim detail identity joins",
    )

    text = replace_once(
        text,
        '''          memberId: row.member_id,
          providerId: row.provider_id,
          billedAmount: Number(row.amount),''',
        '''          memberId: row.member_id,
          providerId: row.provider_id,
          member: memberPresentation(row),
          provider: providerPresentation(row),
          billedAmount: Number(row.amount),''',
        "overview mapper identity",
    )

    path.write_text(text)


def patch_web_claims_table() -> None:
    path = ROOT / "apps/web/src/features/investigator/ClaimsExplorerPage.jsx"
    text = path.read_text()

    text = replace_once(
        text,
        '''        claim.claimId,
        claim.memberId,
        claim.providerId,
        claim.status,''',
        '''        claim.claimId,
        claim.member?.displayName,
        claim.provider?.displayName,
        claim.provider?.practiceNumber,
        claim.provider?.specialty,
        claim.provider?.region,
        claim.memberId,
        claim.providerId,
        claim.status,''',
        "web claims search fields",
    )
    text = replace_once(
        text,
        'placeholder="Claim, member or provider ID"',
        'placeholder="Claim, member, provider or token"',
        "web claims search placeholder",
    )
    text = replace_once(
        text,
        '''                    <td>{claim.memberId || "Not recorded"}</td>
                    <td>{claim.providerId || "Not recorded"}</td>''',
        '''                    <td>
                      <p className="font-medium">{claim.member?.displayName || "Member unavailable"}</p>
                    </td>
                    <td>
                      <p className="font-medium">{claim.provider?.displayName || "Provider unavailable"}</p>
                      {[claim.provider?.specialty, claim.provider?.region].filter(Boolean).length > 0 ? (
                        <p className="mt-1 text-xs text-muted-foreground">
                          {[claim.provider?.specialty, claim.provider?.region].filter(Boolean).join(" · ")}
                        </p>
                      ) : null}
                    </td>''',
        "web member/provider cells",
    )
    path.write_text(text)


def patch_web_claim_detail() -> None:
    path = ROOT / "apps/web/src/features/investigator/ClaimDetailsPage.jsx"
    text = path.read_text()

    text = replace_once(
        text,
        '''    memberId: claim?.memberId || null,
    providerId: claim?.providerId || null,
    policyHolder: claim?.memberId || "Unknown",
    status,''',
        '''    memberId: claim?.memberId || null,
    providerId: claim?.providerId || null,
    member: claim?.member || { displayName: null },
    provider: claim?.provider || {
      displayName: null,
      practiceNumber: null,
      specialty: null,
      region: null,
    },
    policyHolder: claim?.member?.displayName || "Member unavailable",
    status,''',
        "web claim detail mapper",
    )
    text = replace_once(
        text,
        'description={`Policy holder ${claim.policyHolder} · ${new Date(claim.detectionDate).toLocaleString()}`}',
        'description={`Member ${claim.policyHolder} · ${new Date(claim.detectionDate).toLocaleString()}`}',
        "web claim description",
    )
    text = replace_once(
        text,
        '''            <div className="rounded-xl border border-border/70 px-4 py-3">
              <p className="text-xs uppercase tracking-[0.16em] text-muted-foreground">Policy holder</p>
              <p className="mt-1 text-sm font-semibold">{claim.policyHolder}</p>
            </div>
            <div className="rounded-xl border border-border/70 px-4 py-3">
              <p className="text-xs uppercase tracking-[0.16em] text-muted-foreground">Risk score</p>''',
        '''            <div className="rounded-xl border border-border/70 px-4 py-3">
              <p className="text-xs uppercase tracking-[0.16em] text-muted-foreground">Member</p>
              <p className="mt-1 text-sm font-semibold">{claim.policyHolder}</p>
            </div>
            <div className="rounded-xl border border-border/70 px-4 py-3">
              <p className="text-xs uppercase tracking-[0.16em] text-muted-foreground">Provider</p>
              <p className="mt-1 text-sm font-semibold">{claim.provider?.displayName || "Provider unavailable"}</p>
              {[claim.provider?.specialty, claim.provider?.region].filter(Boolean).length > 0 ? (
                <p className="mt-1 text-xs text-muted-foreground">
                  {[claim.provider?.specialty, claim.provider?.region].filter(Boolean).join(" · ")}
                </p>
              ) : null}
            </div>
            <div className="rounded-xl border border-border/70 px-4 py-3">
              <p className="text-xs uppercase tracking-[0.16em] text-muted-foreground">Risk score</p>''',
        "web claim member/provider cards",
    )
    text = replace_once(
        text,
        '''          <div className="mt-4 grid gap-4 lg:grid-cols-2">
            <div className="rounded-xl border border-border/70 p-4">''',
        '''          <details className="mt-4 rounded-xl border border-border/70">
            <summary className="cursor-pointer px-4 py-3 text-sm font-semibold">
              Technical identifiers
            </summary>
            <dl className="grid gap-3 border-t border-border/70 p-4 text-sm md:grid-cols-2">
              <div>
                <dt className="text-xs text-muted-foreground">Member token</dt>
                <dd className="mt-1 break-all font-data text-xs">{claim.memberId || "Not recorded"}</dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">Provider token</dt>
                <dd className="mt-1 break-all font-data text-xs">{claim.providerId || "Not recorded"}</dd>
              </div>
              {claim.provider?.practiceNumber ? (
                <div>
                  <dt className="text-xs text-muted-foreground">Practice number</dt>
                  <dd className="mt-1 font-data text-xs">{claim.provider.practiceNumber}</dd>
                </div>
              ) : null}
            </dl>
          </details>

          <div className="mt-4 grid gap-4 lg:grid-cols-2">
            <div className="rounded-xl border border-border/70 p-4">''',
        "web technical identifiers disclosure",
    )
    path.write_text(text)


def patch_desktop() -> None:
    path = ROOT / "apps/desktop/src/DesktopWorkspace.jsx"
    text = path.read_text()

    text = replace_once(
        text,
        '''            <section><h3 className="text-sm font-semibold">Claim information</h3><dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-5 gap-y-2 text-sm"><dt className="text-muted-foreground">Service date</dt><dd>{claim.serviceDate || "—"}</dd><dt className="text-muted-foreground">Submitted</dt><dd>{displayDate(claim.submittedAt)}</dd><dt className="text-muted-foreground">Billing code</dt><dd className="font-data text-xs">{claim.billingCode || "—"}</dd><dt className="text-muted-foreground">Member token</dt><dd className="break-all font-data text-xs">{claim.memberId || "—"}</dd><dt className="text-muted-foreground">Provider token</dt><dd className="break-all font-data text-xs">{claim.providerId || "—"}</dd><dt className="text-muted-foreground">Version</dt><dd>{claim.currentClaimVersion ?? "—"}</dd></dl></section>''',
        '''            <section><h3 className="text-sm font-semibold">Claim information</h3><dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-5 gap-y-2 text-sm"><dt className="text-muted-foreground">Member</dt><dd className="font-medium">{claim.member?.displayName || "Member unavailable"}</dd><dt className="text-muted-foreground">Provider</dt><dd><span className="font-medium">{claim.provider?.displayName || "Provider unavailable"}</span>{[claim.provider?.specialty, claim.provider?.region].filter(Boolean).length > 0 ? <span className="mt-1 block text-xs text-muted-foreground">{[claim.provider?.specialty, claim.provider?.region].filter(Boolean).join(" · ")}</span> : null}</dd><dt className="text-muted-foreground">Service date</dt><dd>{claim.serviceDate || "—"}</dd><dt className="text-muted-foreground">Submitted</dt><dd>{displayDate(claim.submittedAt)}</dd><dt className="text-muted-foreground">Billing code</dt><dd className="font-data text-xs">{claim.billingCode || "—"}</dd><dt className="text-muted-foreground">Version</dt><dd>{claim.currentClaimVersion ?? "—"}</dd></dl><details className="mt-4 rounded-lg border border-border"><summary className="cursor-pointer px-3 py-2 text-xs font-semibold">Technical identifiers</summary><dl className="grid gap-2 border-t border-border p-3 text-xs"><div><dt className="text-muted-foreground">Member token</dt><dd className="mt-1 break-all font-data">{claim.memberId || "—"}</dd></div><div><dt className="text-muted-foreground">Provider token</dt><dd className="mt-1 break-all font-data">{claim.providerId || "—"}</dd></div>{claim.provider?.practiceNumber ? <div><dt className="text-muted-foreground">Practice number</dt><dd className="mt-1 font-data">{claim.provider.practiceNumber}</dd></div> : null}</dl></details></section>''',
        "desktop claim detail identity",
    )

    text = replace_once(
        text,
        '''    const matchesSearch = !query || [claim.claimId, claim.billingCode, claim.status].some((value) => String(value || "").toLowerCase().includes(query));''',
        '''    const matchesSearch = !query || [claim.claimId, claim.billingCode, claim.status, claim.member?.displayName, claim.provider?.displayName, claim.provider?.practiceNumber, claim.provider?.specialty, claim.provider?.region].some((value) => String(value || "").toLowerCase().includes(query));''',
        "desktop claims search fields",
    )

    old_table = '''    <Card><CardHeader><CardTitle>Claims queue</CardTitle><CardDescription>Search the bounded local cache. Opening a claim refreshes its authoritative detail when connected.</CardDescription></CardHeader><CardContent className="space-y-4"><div className="flex flex-col gap-3 sm:flex-row"><SearchField label="Search claims" placeholder="Claim ID, billing code, or status" value={search} onChange={setSearch} /><label className="grid gap-1 text-xs text-muted-foreground"><span>Risk band</span><select aria-label="Risk band" className="h-10 rounded-md border border-input bg-background px-3 text-sm text-foreground" value={risk} onChange={(event) => setRisk(event.target.value)}><option value="all">All risk bands</option><option value="high">High risk</option><option value="medium">Medium risk</option><option value="low">Low risk</option><option value="unscored">Unscored</option></select></label></div><p className="text-xs text-muted-foreground">Showing {filtered.length} of {claims.length} cached claims</p></CardContent><CardContent className="overflow-x-auto p-0"><table className="desktop-claim-table w-full min-w-[860px] text-left text-sm"><thead className="border-y border-border bg-secondary/40 text-[10px] uppercase tracking-[0.12em] text-muted-foreground"><tr><th className="px-5 py-3">Claim</th><th className="px-5 py-3">Service date</th><th className="px-5 py-3">Amount</th><th className="px-5 py-3">Status</th><th className="px-5 py-3">Risk</th><th className="px-5 py-3">Investigation</th><th className="px-5 py-3"><span className="sr-only">Actions</span></th></tr></thead><tbody className="divide-y divide-border/70">{filtered.map((claim) => <tr key={claim.claimId}><td className="px-5 py-4 font-data text-xs font-semibold">{claim.claimId}</td><td className="px-5 py-4">{claim.serviceDate || "—"}</td><td className="px-5 py-4 font-data">{money(claim.billedAmount)}</td><td className="px-5 py-4"><StatusPill value={claim.status} /></td><td className="px-5 py-4"><RiskLabel score={claim.riskScore} /></td><td className="px-5 py-4">{claim.investigation ? <StatusPill value={claim.investigation.priority} /> : <span className="text-xs text-muted-foreground">None</span>}</td><td className="px-5 py-4 text-right"><Button variant="outline" size="sm" onClick={() => openClaim(claim)}>Open</Button></td></tr>)}</tbody></table>{filtered.length === 0 ? <EmptyState icon={FileSearch} title="No matching claims" description="Adjust the search or risk filter. Older claims remain available through the web application." /> : null}</CardContent></Card>'''
    new_table = '''    <Card><CardHeader><CardTitle>Claims queue</CardTitle><CardDescription>Search the bounded local cache. Opening a claim refreshes its authoritative detail when connected.</CardDescription></CardHeader><CardContent className="space-y-4"><div className="flex flex-col gap-3 sm:flex-row"><SearchField label="Search claims" placeholder="Claim, member, provider, billing code, or status" value={search} onChange={setSearch} /><label className="grid gap-1 text-xs text-muted-foreground"><span>Risk band</span><select aria-label="Risk band" className="h-10 rounded-md border border-input bg-background px-3 text-sm text-foreground" value={risk} onChange={(event) => setRisk(event.target.value)}><option value="all">All risk bands</option><option value="high">High risk</option><option value="medium">Medium risk</option><option value="low">Low risk</option><option value="unscored">Unscored</option></select></label></div><p className="text-xs text-muted-foreground">Showing {filtered.length} of {claims.length} cached claims</p></CardContent><CardContent className="overflow-x-auto p-0"><table className="desktop-claim-table w-full min-w-[1120px] text-left text-sm"><thead className="border-y border-border bg-secondary/40 text-[10px] uppercase tracking-[0.12em] text-muted-foreground"><tr><th className="px-5 py-3">Claim</th><th className="px-5 py-3">Member</th><th className="px-5 py-3">Provider</th><th className="px-5 py-3">Service date</th><th className="px-5 py-3">Amount</th><th className="px-5 py-3">Status</th><th className="px-5 py-3">Risk</th><th className="px-5 py-3">Investigation</th><th className="px-5 py-3"><span className="sr-only">Actions</span></th></tr></thead><tbody className="divide-y divide-border/70">{filtered.map((claim) => <tr key={claim.claimId}><td className="px-5 py-4 font-data text-xs font-semibold">{claim.claimId}</td><td className="px-5 py-4 font-medium">{claim.member?.displayName || "Member unavailable"}</td><td className="px-5 py-4"><p className="font-medium">{claim.provider?.displayName || "Provider unavailable"}</p>{claim.provider?.specialty ? <p className="mt-1 text-xs text-muted-foreground">{claim.provider.specialty}</p> : null}</td><td className="px-5 py-4">{claim.serviceDate || "—"}</td><td className="px-5 py-4 font-data">{money(claim.billedAmount)}</td><td className="px-5 py-4"><StatusPill value={claim.status} /></td><td className="px-5 py-4"><RiskLabel score={claim.riskScore} /></td><td className="px-5 py-4">{claim.investigation ? <StatusPill value={claim.investigation.priority} /> : <span className="text-xs text-muted-foreground">None</span>}</td><td className="px-5 py-4 text-right"><Button variant="outline" size="sm" onClick={() => openClaim(claim)}>Open</Button></td></tr>)}</tbody></table>{filtered.length === 0 ? <EmptyState icon={FileSearch} title="No matching claims" description="Adjust the search or risk filter. Older claims remain available through the web application." /> : null}</CardContent></Card>'''
    text = replace_once(text, old_table, new_table, "desktop claims table")
    path.write_text(text)


def write_repository_test() -> None:
    path = ROOT / "packages/database/tests/claims-identity-presentation.test.js"
    path.write_text('''import assert from "node:assert/strict";
import test from "node:test";

import { createClaimsReadRepository } from "../src/claims-read-repository.js";

const claimRow = {
  claim_id: "claim-identity-1",
  current_claim_version: 1,
  scheme_id: "SCHEME1",
  member_id: "member-token-1",
  provider_id: "provider-token-1",
  member_first_name: "Sbusiso",
  member_last_name: "Mdingi",
  provider_practice_name: "Dlamini Family Practice",
  provider_practice_number: "PR-1001",
  provider_specialty: "General Practitioner",
  provider_region: "Bloemfontein",
  service_date: "2026-08-01",
  amount: "1250.00",
  billing_code: "GP01",
  created_at: "2026-08-01T08:00:00.000Z",
  updated_at: "2026-08-01T08:00:00.000Z",
};

function fakePool() {
  return {
    calls: [],
    async execute(sql) {
      this.calls.push(sql);
      if (sql.includes("COUNT(*) AS total")) return [[{ total: 1 }]];
      if (sql.includes("FROM claims c") && sql.includes("ORDER BY c.updated_at DESC")) {
        return [[claimRow]];
      }
      if (sql.includes("FROM claim_detection_results")) return [[]];
      if (sql.includes("FROM claim_processing_outbox")) return [[]];
      if (sql.includes("FROM investigations i")) return [[]];
      throw new Error(`Unexpected SQL: ${sql}`);
    },
  };
}

test("claim reads expose minimal member and provider presentation alongside tokens", async () => {
  const pool = fakePool();
  const repository = createClaimsReadRepository(pool, {
    dataPlaneContext: { operationalTenantId: "tenant-1" },
  });

  const result = await repository.listClaims({ page: 1, pageSize: 25 });
  const claim = result.claims[0];

  assert.equal(claim.memberId, "member-token-1");
  assert.equal(claim.providerId, "provider-token-1");
  assert.deepEqual(claim.member, { displayName: "S. Mdingi" });
  assert.deepEqual(claim.provider, {
    displayName: "Dlamini Family Practice",
    practiceNumber: "PR-1001",
    specialty: "General Practitioner",
    region: "Bloemfontein",
  });

  const baseQuery = pool.calls.find((sql) => sql.includes("ORDER BY c.updated_at DESC"));
  assert.match(baseQuery, /LEFT JOIN members m/);
  assert.match(baseQuery, /m\.tenant_id = c\.tenant_id/);
  assert.match(baseQuery, /m\.scheme_id = c\.scheme_id/);
  assert.match(baseQuery, /LEFT JOIN providers p/);
  assert.match(baseQuery, /p\.tenant_id = c\.tenant_id/);
  assert.match(baseQuery, /p\.scheme_id = c\.scheme_id/);
});
''')


def main() -> None:
    patch_backend()
    patch_web_claims_table()
    patch_web_claim_detail()
    patch_desktop()
    write_repository_test()

    (ROOT / ".github/workflows/pr124-claim-identity-once.yml").unlink()
    Path(__file__).unlink()


if __name__ == "__main__":
    main()
