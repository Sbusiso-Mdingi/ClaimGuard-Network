import React, { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import ArrowDown from "lucide-react/dist/esm/icons/arrow-down.mjs";
import ArrowUp from "lucide-react/dist/esm/icons/arrow-up.mjs";
import ArrowUpDown from "lucide-react/dist/esm/icons/arrow-up-down.mjs";
import ChevronLeft from "lucide-react/dist/esm/icons/chevron-left.mjs";
import ChevronRight from "lucide-react/dist/esm/icons/chevron-right.mjs";
import Clock3 from "lucide-react/dist/esm/icons/clock-3.mjs";
import FileStack from "lucide-react/dist/esm/icons/files.mjs";
import Flag from "lucide-react/dist/esm/icons/flag.mjs";
import RefreshCw from "lucide-react/dist/esm/icons/refresh-cw.mjs";
import Search from "lucide-react/dist/esm/icons/search.mjs";
import SearchCheck from "lucide-react/dist/esm/icons/search-check.mjs";
import { Input } from "../../components/ui/input";
import { Button } from "../../components/ui/button";
import {
  DataTableShell,
  EmptyState,
  PageFrame,
  RiskScoreBar,
  SectionCard,
  StatusIndicator,
  SummaryRail,
  TableLoadingRows,
  WorkspaceNotice,
  claimStatusTone,
  formatEnumLabel,
} from "./InvestigatorUI";

const SORT_FIELDS = {
  claimId: (a, b) => a.claimId.localeCompare(b.claimId),
  riskScore: (a, b) => {
    const left = Number.isFinite(a.riskScore) ? a.riskScore : -1;
    const right = Number.isFinite(b.riskScore) ? b.riskScore : -1;
    return left - right;
  },
  scoringUpdatedAt: (a, b) => {
    const left = a?.scoringUpdatedAt ? new Date(a.scoringUpdatedAt).getTime() : 0;
    const right = b?.scoringUpdatedAt ? new Date(b.scoringUpdatedAt).getTime() : 0;
    return left - right;
  },
};

const PROCESSING_PRESENTATION = Object.freeze({
  queued: { label: "Queued", tone: "info", riskLabel: "Calculating…" },
  processing: { label: "Scoring", tone: "info", riskLabel: "Calculating…" },
  retrying: { label: "Retrying", tone: "warning", riskLabel: "Calculating…" },
  failed: { label: "Scoring needs attention", tone: "danger", riskLabel: "Unavailable" },
  not_scored: { label: "Awaiting score", tone: "warning", riskLabel: "Calculating…" },
  scored: { label: "Scored", tone: "success", riskLabel: null },
});

const UNDER_INVESTIGATION_STATUSES = new Set([
  "UNDER_INVESTIGATION",
  "UNDER_REVIEW",
  "AWAITING_EVIDENCE",
  "CONFIRMED_FRAUD",
]);

function processingPresentation(claim) {
  return PROCESSING_PRESENTATION[claim.processingStatus]
    || PROCESSING_PRESENTATION.not_scored;
}

function formatMoney(value) {
  if (!Number.isFinite(value)) return "Not recorded";
  return new Intl.NumberFormat("en-ZA", {
    style: "currency",
    currency: "ZAR",
    maximumFractionDigits: 2,
  }).format(value);
}

function formatDate(value) {
  if (!value) return "Not recorded";
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? "Not recorded"
    : date.toLocaleString("en-ZA", {
        dateStyle: "medium",
        timeStyle: "short",
      });
}

function isUnderInvestigation(claim) {
  return Boolean(claim.investigation)
    || UNDER_INVESTIGATION_STATUSES.has(String(claim.status || ""));
}

function paginationInteger(value, fallback, { allowZero = false } = {}) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  const minimum = allowZero ? 0 : 1;
  return Number.isInteger(parsed) && parsed >= minimum ? parsed : fallback;
}

export function ClaimsExplorerPage({
  claims,
  claimsStatus = "ready",
  claimsError = null,
  claimsPagination = null,
  onRetryClaims = null,
  onPageChange = null,
}) {
  const [query, setQuery] = useState("");
  const [processingFilter, setProcessingFilter] = useState("all");
  const [investigationFilter, setInvestigationFilter] = useState("all");
  const [riskFilter, setRiskFilter] = useState("all");
  const [sortField, setSortField] = useState("riskScore");
  const [sortDirection, setSortDirection] = useState("desc");

  const rows = useMemo(() => {
    const filtered = claims.filter((claim) => {
      const matchesQuery = [
        claim.claimId,
        claim.memberId,
        claim.providerId,
        claim.status,
        claim.processingStatus,
        claim.processing?.failureCode,
        ...(claim.triggeredRules || []),
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase()
        .includes(query.trim().toLowerCase());
      const matchesProcessing = processingFilter === "all"
        || claim.processingStatus === processingFilter;
      const underInvestigation = isUnderInvestigation(claim);
      const matchesInvestigation = investigationFilter === "all"
        || (investigationFilter === "active" && underInvestigation)
        || (investigationFilter === "not_started" && !underInvestigation);
      const matchesRisk = riskFilter === "all"
        || (riskFilter === "unscored" && !Number.isFinite(claim.riskScore))
        || (riskFilter === "high" && claim.riskScore >= 75)
        || (riskFilter === "medium" && claim.riskScore >= 40 && claim.riskScore < 75)
        || (riskFilter === "low" && Number.isFinite(claim.riskScore) && claim.riskScore < 40);
      return matchesQuery && matchesProcessing && matchesInvestigation && matchesRisk;
    });

    filtered.sort((a, b) => {
      const comparator = SORT_FIELDS[sortField] || SORT_FIELDS.riskScore;
      const result = comparator(a, b);
      return sortDirection === "asc" ? result : -result;
    });
    return filtered;
  }, [
    claims,
    investigationFilter,
    processingFilter,
    query,
    riskFilter,
    sortDirection,
    sortField,
  ]);

  const page = paginationInteger(claimsPagination?.page, 1);
  const pageSize = paginationInteger(
    claimsPagination?.pageSize,
    Math.max(1, claims.length),
  );
  const total = paginationInteger(
    claimsPagination?.total,
    claims.length,
    { allowZero: true },
  );
  const totalPages = Math.max(
    1,
    paginationInteger(claimsPagination?.totalPages, Math.ceil(total / pageSize)),
  );
  const hasPreviousPage = claimsPagination?.hasPreviousPage === true || page > 1;
  const hasNextPage = claimsPagination?.hasNextPage === true || page < totalPages;
  const firstRecord = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const lastRecord = total === 0 ? 0 : Math.min(
    total,
    firstRecord + claims.length - 1,
  );
  const loading = claimsStatus === "loading";
  const refreshing = claimsStatus === "refreshing";
  const stale = claimsStatus === "stale";
  const failed = claimsStatus === "error";
  const summary = useMemo(() => ({
    awaitingScore: claims.filter((claim) => !Number.isFinite(claim.riskScore)).length,
    highRisk: claims.filter((claim) => Number.isFinite(claim.riskScore) && claim.riskScore >= 75).length,
    underInvestigation: claims.filter(isUnderInvestigation).length,
  }), [claims]);

  function toggleSort(field) {
    if (sortField === field) {
      setSortDirection((previous) => previous === "asc" ? "desc" : "asc");
      return;
    }
    setSortField(field);
    setSortDirection("desc");
  }

  function SortIcon({ field }) {
    if (sortField !== field) {
      return <ArrowUpDown className="h-3.5 w-3.5 opacity-50" />;
    }
    return sortDirection === "asc"
      ? <ArrowUp className="h-3.5 w-3.5 text-primary" />
      : <ArrowDown className="h-3.5 w-3.5 text-primary" />;
  }

  function clearFilters() {
    setQuery("");
    setProcessingFilter("all");
    setInvestigationFilter("all");
    setRiskFilter("all");
  }

  return (
    <PageFrame
      eyebrow="Casework"
      title="Claims"
      description="Submitted claims with current processing, scoring, and investigation state."
      actions={[
        <Button
          key="refresh"
          variant="outline"
          size="sm"
          disabled={loading || refreshing}
          onClick={() => onRetryClaims?.()}
          className="h-9"
        >
          <RefreshCw className={`mr-1.5 h-3.5 w-3.5 ${refreshing ? "animate-spin" : ""}`} />
          {refreshing ? "Refreshing…" : "Refresh claims"}
        </Button>,
      ]}
    >
      <p role="status" aria-live="polite" className="sr-only">
        {loading ? "Loading claims." : refreshing ? "Refreshing claims." : `Showing ${rows.length} filtered claims.`}
      </p>

      <SectionCard
        variant="console"
        title="Queue filters"
        description="Refine claims by identity, processing state, investigation state, and risk band."
      >
        <div className="grid gap-3 p-4 md:grid-cols-2 xl:grid-cols-[minmax(220px,1.4fr)_1fr_1fr_1fr_auto] xl:items-end">
          <label className="grid gap-2 text-sm font-medium">
            <span>Search claims</span>
            <span className="relative">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                aria-label="Search claims"
                placeholder="Claim, member or provider ID"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                className="h-10 pl-9"
              />
            </span>
          </label>
          <label className="grid gap-2 text-sm font-medium">
            <span>Processing status</span>
            <select
              aria-label="Filter by processing status"
              value={processingFilter}
              onChange={(event) => setProcessingFilter(event.target.value)}
              className="h-10 rounded-lg border border-input bg-background px-3 text-sm outline-none focus:ring-2 focus:ring-ring"
            >
              <option value="all">All statuses</option>
              <option value="queued">Queued</option>
              <option value="processing">Scoring</option>
              <option value="retrying">Retrying</option>
              <option value="failed">Needs attention</option>
              <option value="scored">Scored</option>
            </select>
          </label>
          <label className="grid gap-2 text-sm font-medium">
            <span>Investigation status</span>
            <select
              aria-label="Filter by investigation status"
              value={investigationFilter}
              onChange={(event) => setInvestigationFilter(event.target.value)}
              className="h-10 rounded-lg border border-input bg-background px-3 text-sm outline-none focus:ring-2 focus:ring-ring"
            >
              <option value="all">All statuses</option>
              <option value="active">Under investigation</option>
              <option value="not_started">Not started</option>
            </select>
          </label>
          <label className="grid gap-2 text-sm font-medium">
            <span>Risk band</span>
            <select
              aria-label="Filter by risk band"
              value={riskFilter}
              onChange={(event) => setRiskFilter(event.target.value)}
              className="h-10 rounded-lg border border-input bg-background px-3 text-sm outline-none focus:ring-2 focus:ring-ring"
            >
              <option value="all">All bands</option>
              <option value="high">High</option>
              <option value="medium">Medium</option>
              <option value="low">Low</option>
              <option value="unscored">Calculating</option>
            </select>
          </label>
          <Button variant="outline" className="h-10" onClick={clearFilters}>
            Clear
          </Button>
        </div>
      </SectionCard>

      <SummaryRail
        ariaLabel="Claims summary"
        items={[
          {
            key: "visible",
            label: "Total visible",
            value: loading ? "—" : claims.length,
            description: `${total} total`,
            icon: FileStack,
          },
          {
            key: "awaiting",
            label: "Awaiting score",
            value: loading ? "—" : summary.awaitingScore,
            description: "Queued or scoring",
            icon: Clock3,
            iconClassName: "text-sky-500",
          },
          {
            key: "high-risk",
            label: "High risk",
            value: loading ? "—" : summary.highRisk,
            description: "Score 75 or above",
            icon: Flag,
            iconClassName: summary.highRisk > 0 ? "text-rose-500" : "text-emerald-500",
          },
          {
            key: "investigation",
            label: "Under investigation",
            value: loading ? "—" : summary.underInvestigation,
            description: "Active case workflow",
            icon: SearchCheck,
            iconClassName: "text-amber-500",
          },
        ]}
      />

      {stale ? (
        <WorkspaceNotice
          title="Showing the last successful claims response."
          tone="warning"
          actions={<Button variant="outline" size="sm" onClick={() => onRetryClaims?.()}>Retry</Button>}
        >
          {claimsError || "The latest refresh did not complete."}
        </WorkspaceNotice>
      ) : null}
      {failed ? (
        <WorkspaceNotice
          title="We couldn't load the latest claims."
          tone="danger"
          actions={<Button variant="outline" size="sm" onClick={() => onRetryClaims?.()}>Retry</Button>}
        >
          {claimsError || "The claims service is temporarily unavailable."}
        </WorkspaceNotice>
      ) : null}

      <SectionCard
        variant="console"
        title="Claims queue"
        description="Processing state is shown separately from investigation status and risk output."
      >
        <DataTableShell ariaLabel="Claims table" minWidth="1480px">
          <thead className="sticky top-0 z-10">
            <tr>
              <th className="sticky left-0 z-20 min-w-[280px] bg-card shadow-[1px_0_0_hsl(var(--border))]">
                <button className="inline-flex items-center gap-2 font-medium text-foreground transition hover:text-primary" onClick={() => toggleSort("claimId")} aria-label="Sort by claim ID">
                  Claim <SortIcon field="claimId" />
                </button>
              </th>
              <th>Member</th>
              <th>Provider</th>
              <th>Amount</th>
              <th>
                <button className="inline-flex items-center gap-2 font-medium text-foreground transition hover:text-primary" onClick={() => toggleSort("scoringUpdatedAt")} aria-label="Sort by submitted or processing date">
                  Submitted <SortIcon field="scoringUpdatedAt" />
                </button>
              </th>
              <th>Processing</th>
              <th>
                <button className="inline-flex items-center gap-2 font-medium text-foreground transition hover:text-primary" onClick={() => toggleSort("riskScore")} aria-label="Sort by risk score">
                  Risk score <SortIcon field="riskScore" />
                </button>
              </th>
              <th>Investigation</th>
              <th><span className="sr-only">Action</span></th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <TableLoadingRows columns={9} rows={6} />
            ) : rows.length === 0 ? (
              <tr>
                <td colSpan={9}>
                  <EmptyState
                    icon={Search}
                    title={failed ? "Claims are unavailable" : "No claims match the current filters"}
                    description={failed ? "Retry the request to load the tenant claim queue." : "Adjust or clear filters to see results."}
                    actions={!failed ? <Button variant="outline" size="sm" onClick={clearFilters}>Clear filters</Button> : null}
                    compact
                  />
                </td>
              </tr>
            ) : (
              rows.map((claim) => {
                const processingState = processingPresentation(claim);
                return (
                  <tr key={claim.claimId}>
                    <td className="sticky left-0 z-10 min-w-[280px] max-w-[280px] bg-card font-medium text-foreground shadow-[1px_0_0_hsl(var(--border))]">
                      <Link
                        to={`/claims/${encodeURIComponent(claim.claimId)}`}
                        className="block break-all text-sky-700 underline-offset-4 hover:underline focus-visible:underline dark:text-sky-300"
                        title={claim.claimId}
                      >
                        {claim.claimId}
                      </Link>
                      {claim.currentClaimVersion ? <p className="mt-1 text-[10px] text-muted-foreground">Version {claim.currentClaimVersion}</p> : null}
                    </td>
                    <td>{claim.memberId || "Not recorded"}</td>
                    <td>{claim.providerId || "Not recorded"}</td>
                    <td className="whitespace-nowrap">{formatMoney(claim.billedAmount)}</td>
                    <td className="min-w-[150px] text-xs text-muted-foreground">{formatDate(claim.submittedAt || claim.scoringUpdatedAt)}</td>
                    <td>
                      <StatusIndicator variant="badge" tone={processingState.tone}>{processingState.label}</StatusIndicator>
                      {claim.processingStatus === "failed" ? (
                        <p className="mt-1 text-[11px] text-rose-700 dark:text-rose-300">Open the claim to review the safe failure code.</p>
                      ) : claim.processingStatus === "retrying" && claim.processing?.maxAttempts ? (
                        <p className="mt-1 text-[11px] text-muted-foreground">Attempt {claim.processing.attemptCount} of {claim.processing.maxAttempts}</p>
                      ) : null}
                    </td>
                    <td>
                      {Number.isFinite(claim.riskScore) ? (
                        <div className="min-w-[110px] space-y-1.5">
                          <div className="flex items-center justify-between gap-2">
                            <span className="font-semibold">{claim.riskScore}</span>
                            <span className="text-[10px] text-muted-foreground">{claim.severity}</span>
                          </div>
                          <RiskScoreBar score={claim.riskScore} />
                        </div>
                      ) : (
                        <span className="inline-flex items-center gap-2 text-xs font-medium text-muted-foreground">
                          {processingState.riskLabel === "Calculating…" ? <span className="h-3 w-3 animate-spin rounded-full border-2 border-sky-500/30 border-t-sky-500" aria-hidden="true" /> : null}
                          {processingState.riskLabel}
                        </span>
                      )}
                    </td>
                    <td>
                      <StatusIndicator variant="badge" tone={claimStatusTone(claim.status)}>
                        {isUnderInvestigation(claim) ? formatEnumLabel(claim.status, "Under investigation") : "Not started"}
                      </StatusIndicator>
                      {claim.investigation?.investigationId ? <p className="mt-1 text-[10px] text-muted-foreground">{claim.investigation.investigationId}</p> : null}
                    </td>
                    <td className="text-right">
                      <Button asChild variant="outline" size="sm">
                        <Link to={`/claims/${encodeURIComponent(claim.claimId)}`}>Open claim</Link>
                      </Button>
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </DataTableShell>
        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border/70 px-4 py-3 text-sm text-muted-foreground">
          <p>
            Showing server records {firstRecord}–{lastRecord} of {total}. Current filters show {rows.length} of {claims.length} loaded records.
          </p>
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              aria-label="Previous claims page"
              disabled={!hasPreviousPage || refreshing || loading}
              onClick={() => onPageChange?.(page - 1)}
            >
              <ChevronLeft className="mr-1 h-4 w-4" /> Previous
            </Button>
            <span className="font-data text-xs uppercase tracking-[0.14em]">
              Page {page} / {totalPages}
            </span>
            <Button
              variant="outline"
              size="sm"
              aria-label="Next claims page"
              disabled={!hasNextPage || refreshing || loading}
              onClick={() => onPageChange?.(page + 1)}
            >
              Next <ChevronRight className="ml-1 h-4 w-4" />
            </Button>
          </div>
        </div>
      </SectionCard>
    </PageFrame>
  );
}
