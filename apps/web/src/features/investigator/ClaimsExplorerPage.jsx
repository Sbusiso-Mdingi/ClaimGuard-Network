import React, { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import Filter from "lucide-react/dist/esm/icons/filter.mjs";
import Search from "lucide-react/dist/esm/icons/search.mjs";
import ArrowDown from "lucide-react/dist/esm/icons/arrow-down.mjs";
import ArrowUp from "lucide-react/dist/esm/icons/arrow-up.mjs";
import ArrowUpDown from "lucide-react/dist/esm/icons/arrow-up-down.mjs";
import ChevronLeft from "lucide-react/dist/esm/icons/chevron-left.mjs";
import ChevronRight from "lucide-react/dist/esm/icons/chevron-right.mjs";
import { Input } from "../../components/ui/input";
import { Button } from "../../components/ui/button";
import { PageFrame, SectionCard, StatusIndicator, RiskScoreBar, claimStatusTone } from "./InvestigatorUI";

const PAGE_SIZE = 10;

const SORT_FIELDS = {
  claimId: (a, b) => a.claimId.localeCompare(b.claimId),
  riskScore: (a, b) => {
    const left = Number.isFinite(a.riskScore) ? a.riskScore : -1;
    const right = Number.isFinite(b.riskScore) ? b.riskScore : -1;
    return left - right;
  },
  detectionDate: (a, b) => new Date(a.detectionDate) - new Date(b.detectionDate),
};

export function ClaimsExplorerPage({ claims }) {
  const [query, setQuery] = useState("");
  const [severityFilter, setSeverityFilter] = useState("all");
  const [sortField, setSortField] = useState("riskScore");
  const [sortDirection, setSortDirection] = useState("desc");
  const [page, setPage] = useState(0);

  const rows = useMemo(() => {
    const filtered = claims.filter((claim) => {
      const matchesQuery = [claim.claimId, claim.policyHolder, claim.status, ...(claim.triggeredRules || [])]
        .join(" ")
        .toLowerCase()
        .includes(query.toLowerCase());
      const matchesSeverity = severityFilter === "all" || claim.severity.toLowerCase() === severityFilter;
      return matchesQuery && matchesSeverity;
    });

    filtered.sort((a, b) => {
      const comparator = SORT_FIELDS[sortField] || SORT_FIELDS.riskScore;
      const result = comparator(a, b);
      return sortDirection === "asc" ? result : -result;
    });

    return filtered;
  }, [claims, query, severityFilter, sortField, sortDirection]);

  const pageCount = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  const currentPage = Math.min(page, pageCount - 1);
  const pagedRows = useMemo(
    () => rows.slice(currentPage * PAGE_SIZE, currentPage * PAGE_SIZE + PAGE_SIZE),
    [rows, currentPage],
  );

  useEffect(() => {
    setPage(0);
  }, [query, severityFilter]);

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

  return (
    <PageFrame
      eyebrow="Claims Explorer"
      title="Claims review table"
      description="Search, sort, and filter claims surfaced by the detection APIs in a high-density investigation view."
      actions={[
        <StatusIndicator key="count" variant="badge">{rows.length} records</StatusIndicator>,
        <StatusIndicator key="severity" variant="badge">{severityFilter === "all" ? "All severities" : severityFilter}</StatusIndicator>,
      ]}
    >
      <SectionCard title="Filters" description="Use search and severity controls to narrow the investigation queue.">
        <div className="grid gap-3 lg:grid-cols-[1fr_220px_auto]">
          <div className="relative">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              aria-label="Search claims"
              placeholder="Search claim id, policy holder, status, rule..."
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
            </select>
          </div>
          <Button variant="outline" onClick={() => { setQuery(""); setSeverityFilter("all"); }} className="h-11 rounded-xl px-4">
            Clear
          </Button>
        </div>
      </SectionCard>

      <SectionCard title="Claims table" description="Sticky headers, stronger row separation, and clearer sort affordances make the table easier to scan.">
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
                <th>Status</th>
                <th>Policy holder</th>
                <th>
                  <button className="inline-flex items-center gap-2 font-medium text-foreground transition hover:text-primary" onClick={() => toggleSort("detectionDate")} aria-label="Sort by detection date">
                    Detection date <SortIcon field="detectionDate" />
                  </button>
                </th>
                <th>Triggered rules</th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 ? (
                <tr>
                  <td colSpan={6} className="px-4 py-10 text-center text-muted-foreground">No claims match your filters.</td>
                </tr>
              ) : (
                pagedRows.map((claim) => (
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
                        "Unavailable"
                      )}
                    </td>
                    <td>
                      <StatusIndicator tone={claimStatusTone(claim.status)}>{claim.status.replace(/_/g, " ")}</StatusIndicator>
                    </td>
                    <td>{claim.policyHolder}</td>
                    <td>{new Date(claim.detectionDate).toLocaleString()}</td>
                    <td className="max-w-[360px] text-xs leading-5 text-muted-foreground">{claim.triggeredRules.join(", ") || "No rules"}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
        <div className="mt-4 flex flex-wrap items-center justify-between gap-3 text-sm text-muted-foreground">
          <p>
            Showing {rows.length === 0 ? 0 : currentPage * PAGE_SIZE + 1}–{Math.min(rows.length, (currentPage + 1) * PAGE_SIZE)} of {rows.length} matching claims.
          </p>
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              className="h-9 rounded-full px-3"
              disabled={currentPage === 0}
              onClick={() => setPage((prev) => Math.max(0, prev - 1))}
            >
              <ChevronLeft className="mr-1 h-4 w-4" /> Prev
            </Button>
            <span className="font-data text-xs uppercase tracking-[0.14em]">
              Page {currentPage + 1} / {pageCount}
            </span>
            <Button
              variant="outline"
              size="sm"
              className="h-9 rounded-full px-3"
              disabled={currentPage >= pageCount - 1}
              onClick={() => setPage((prev) => Math.min(pageCount - 1, prev + 1))}
            >
              Next <ChevronRight className="ml-1 h-4 w-4" />
            </Button>
          </div>
        </div>
      </SectionCard>
    </PageFrame>
  );
}
