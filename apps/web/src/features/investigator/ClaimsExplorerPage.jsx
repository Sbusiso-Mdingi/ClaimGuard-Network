import React, { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import Filter from "lucide-react/dist/esm/icons/filter.mjs";
import Search from "lucide-react/dist/esm/icons/search.mjs";
import ArrowDown from "lucide-react/dist/esm/icons/arrow-down.mjs";
import ArrowUp from "lucide-react/dist/esm/icons/arrow-up.mjs";
import ArrowUpDown from "lucide-react/dist/esm/icons/arrow-up-down.mjs";
import ChevronLeft from "lucide-react/dist/esm/icons/chevron-left.mjs";
import ChevronRight from "lucide-react/dist/esm/icons/chevron-right.mjs";
import RefreshCw from "lucide-react/dist/esm/icons/refresh-cw.mjs";
import { Input } from "../../components/ui/input";
import { Button } from "../../components/ui/button";
import { PageFrame, SectionCard, StatusIndicator, RiskScoreBar, claimStatusTone } from "./InvestigatorUI";

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
  queued: { label: "Awaiting scoring", tone: "info", riskLabel: "Awaiting scoring" },
  processing: { label: "Processing", tone: "info", riskLabel: "Processing" },
  retrying: { label: "Retrying", tone: "warning", riskLabel: "Retrying" },
  failed: { label: "Scoring failed", tone: "danger", riskLabel: "Scoring failed" },
  not_scored: { label: "Not scored", tone: "warning", riskLabel: "Not scored" },
  scored: { label: "Scored", tone: "success", riskLabel: null },
});

function processingPresentation(claim) {
  return PROCESSING_PRESENTATION[claim.processingStatus] || PROCESSING_PRESENTATION.not_scored;
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
  const [severityFilter, setSeverityFilter] = useState("all");
  const [sortField, setSortField] = useState("riskScore");
  const [sortDirection, setSortDirection] = useState("desc");

  const rows = useMemo(() => {
    const filtered = claims.filter((claim) => {
      const matchesQuery = [
        claim.claimId,
        claim.policyHolder,
        claim.status,
        claim.processingStatus,
        claim.processing?.failureCode,
        claim.processing?.lastError,
        ...(claim.triggeredRules || []),
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase()
        .includes(query.toLowerCase());
      const claimSeverity = String(claim.severity || "unknown").toLowerCase();
      const matchesSeverity = severityFilter === "all" || claimSeverity === severityFilter;
      return matchesQuery && matchesSeverity;
    });

    filtered.sort((a, b) => {
      const comparator = SORT_FIELDS[sortField] || SORT_FIELDS.riskScore;
      const result = comparator(a, b);
      return sortDirection === "asc" ? result : -result;
    });

    return filtered;
  }, [claims, query, severityFilter, sortField, sortDirection]);

  const page = Number.isFinite(claimsPagination?.page) ? claimsPagination.page : 1;
  const pageSize = Number.isFinite(claimsPagination?.pageSize) ? claimsPagination.pageSize : claims.length;
  const total = Number.isFinite(claimsPagination?.total) ? claimsPagination.total : claims.length;
  const totalPages = Math.max(1, Number.isFinite(claimsPagination?.totalPages) ? claimsPagination.totalPages : 1);
  const firstRecord = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const lastRecord = total === 0 ? 0 : Math.min(total, firstRecord + claims.length - 1);
  const refreshing = claimsStatus === "refreshing";
  const stale = claimsStatus === "stale";

  function toggleSort(field) {
    if (sortField === field) {
      setSortDirection((prev) => (prev === "asc" ? "desc" : "asc"));
      return;
    }
    setSortField(field);
    setSortDirection("desc");
  }

  function SortIcon({ field }) {
    if (sortField !== field) return <ArrowUpDown className="h-3.5 w-3.5 opacity-50" />;
    return sortDirection === "asc" ? <ArrowUp className="h-3.5 w-3.5 text-primary" /> : <ArrowDown className="h-3.5 w-3.5 text-primary" />;
  }

  if (claimsStatus === "loading") {
    return (
      <PageFrame
        eyebrow="Claims Explorer"
        title="Claims review table"
        description="Loading authoritative claims from the API."
      >
        <SectionCard title="Claims" description="The claims list is loading.">
          <p className="text-sm text-muted-foreground">Loading claims...</p>
        </SectionCard>
      </PageFrame>
    );
  }

  if (claimsStatus === "error") {
    return (
      <PageFrame
        eyebrow="Claims Explorer"
        title="Claims review table"
        description="Authoritative claims API is currently unavailable."
      >
        <SectionCard title="Claims unavailable" description={claimsError || "The claims API request failed."}>
          <div className="flex items-center gap-3">
            <StatusIndicator tone="danger">Unavailable</StatusIndicator>
            <Button variant="outline" onClick={() => onRetryClaims?.()} className="h-9 rounded-full px-4">Retry</Button>
          </div>
        </SectionCard>
      </PageFrame>
    );
  }

  return (
    <PageFrame
      eyebrow="Claims Explorer"
      title="Claims review table"
      description="Server-paginated claims with current processing, scoring and investigation state."
      actions={[
        <StatusIndicator key="count" variant="badge">{total} total records</StatusIndicator>,
        <StatusIndicator key="page" variant="badge">Page {page} of {totalPages}</StatusIndicator>,
        refreshing ? <StatusIndicator key="refreshing" variant="badge">Refreshing</StatusIndicator> : null,
        <Button key="refresh" variant="outline" size="sm" disabled={refreshing} onClick={() => onRetryClaims?.()} className="h-9 rounded-full px-3">
          <RefreshCw className={`mr-1.5 h-3.5 w-3.5 ${refreshing ? "animate-spin" : ""}`} /> Refresh claims
        </Button>,
      ].filter(Boolean)}
    >
      {stale ? (
        <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 p-4 text-sm text-amber-700 dark:text-amber-300">
          Showing the last successful claims response. Refresh failed: {claimsError || "Claims are temporarily unavailable."}
        </div>
      ) : null}

      <SectionCard title="Filters" description="Filters and sorting apply to the current server page only.">
        <div className="grid gap-3 lg:grid-cols-[1fr_220px_auto]">
          <div className="relative">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              aria-label="Search claims"
              placeholder="Search this page by claim, member, status or failure..."
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              className="h-11 pl-9"
            />
          </div>
          <div className="relative">
            <Filter className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <select
              aria-label="Filter by severity"
              value={severityFilter}
              onChange={(event) => setSeverityFilter(event.target.value)}
              className="h-11 w-full rounded-xl border border-border bg-background pl-9 pr-3 text-sm outline-none transition focus:border-primary focus:ring-2 focus:ring-primary/20"
            >
              <option value="all">All severities</option>
              <option value="high">High</option>
              <option value="medium">Medium</option>
              <option value="low">Low</option>
              <option value="unknown">Unscored</option>
            </select>
          </div>
          <Button variant="outline" onClick={() => { setQuery(""); setSeverityFilter("all"); }} className="h-11 rounded-xl px-4">
            Clear
          </Button>
        </div>
      </SectionCard>

      <SectionCard title="Claims table" description="Processing state is shown separately from investigation status and risk output.">
        <div className="overflow-x-auto investigator-scrollbar rounded-2xl border border-border/70 bg-background/70">
          <table className="investigator-table" aria-label="Claims table">
            <thead className="sticky top-0 z-10">
              <tr>
                <th>
                  <button className="inline-flex items-center gap-2 font-medium text-foreground transition hover:text-primary" onClick={() => toggleSort("claimId")} aria-label="Sort by claim id">
                    Claim ID <SortIcon field="claimId" />
                  </button>
                </th>
                <th>
                  <button className="inline-flex items-center gap-2 font-medium text-foreground transition hover:text-primary" onClick={() => toggleSort("riskScore")} aria-label="Sort by risk score">
                    Risk score <SortIcon field="riskScore" />
                  </button>
                </th>
                <th>Processing</th>
                <th>Claim status</th>
                <th>Policy holder</th>
                <th>
                  <button className="inline-flex items-center gap-2 font-medium text-foreground transition hover:text-primary" onClick={() => toggleSort("scoringUpdatedAt")} aria-label="Sort by processing update">
                    Updated <SortIcon field="scoringUpdatedAt" />
                  </button>
                </th>
                <th>Result / failure</th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 ? (
                <tr>
                  <td colSpan={7} className="px-4 py-10 text-center text-muted-foreground">No claims on this server page match your filters.</td>
                </tr>
              ) : (
                rows.map((claim) => {
                  const processingState = processingPresentation(claim);
                  const failureText = claim.processingStatus === "failed"
                    ? [claim.processing?.failureCode, claim.processing?.lastError].filter(Boolean).join(": ") || "Processing failed without a recorded reason."
                    : null;

                  return (
                    <tr key={claim.claimId}>
                      <td className="font-medium text-foreground">
                        <Link to={`/claims/${encodeURIComponent(claim.claimId)}`} className="text-primary underline-offset-4 hover:underline focus-visible:underline">
                          {claim.claimId}
                        </Link>
                      </td>
                      <td>
                        {Number.isFinite(claim.riskScore) ? (
                          <div className="min-w-[110px] space-y-1.5">
                            <span className="font-semibold">{claim.riskScore}</span>
                            <RiskScoreBar score={claim.riskScore} />
                          </div>
                        ) : (
                          <span className="text-xs font-medium text-muted-foreground">{processingState.riskLabel}</span>
                        )}
                      </td>
                      <td>
                        <StatusIndicator variant="badge" tone={processingState.tone}>{processingState.label}</StatusIndicator>
                        {claim.processingStatus === "retrying" && claim.processing?.maxAttempts ? (
                          <p className="mt-1 text-[11px] text-muted-foreground">Attempt {claim.processing.attemptCount} of {claim.processing.maxAttempts}</p>
                        ) : null}
                      </td>
                      <td>
                        <StatusIndicator tone={claimStatusTone(claim.status)}>{String(claim.status).replace(/_/g, " ")}</StatusIndicator>
                      </td>
                      <td>{claim.policyHolder}</td>
                      <td>{claim.scoringUpdatedAt ? new Date(claim.scoringUpdatedAt).toLocaleString() : "No processing timestamp"}</td>
                      <td className={`max-w-[420px] text-xs leading-5 ${failureText ? "text-destructive" : "text-muted-foreground"}`}>
                        {failureText || claim.triggeredRules.join(", ") || (claim.processingStatus === "scored" ? "Scored with no triggered indicators" : "No detection result yet")}
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
        <div className="mt-4 flex flex-wrap items-center justify-between gap-3 text-sm text-muted-foreground">
          <p>
            Showing server records {firstRecord}–{lastRecord} of {total}. Current-page filters show {rows.length} of {claims.length} loaded records.
          </p>
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              className="h-9 rounded-full px-3"
              disabled={page <= 1 || refreshing}
              onClick={() => onPageChange?.(page - 1)}
            >
              <ChevronLeft className="mr-1 h-4 w-4" /> Prev
            </Button>
            <span className="font-data text-xs uppercase tracking-[0.14em]">
              Page {page} / {totalPages}
            </span>
            <Button
              variant="outline"
              size="sm"
              className="h-9 rounded-full px-3"
              disabled={page >= totalPages || refreshing}
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
