import React, { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { Filter, Search, ArrowUpDown, ChevronLeft, ChevronRight } from "lucide-react";
import { Input } from "../../components/ui/input";
import { Button } from "../../components/ui/button";
import { PageFrame, SectionCard, StatusBadge, CaseStamp, statusStampTone } from "./InvestigatorUI";

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

  function toggleSort(field) {
    if (sortField === field) {
      setSortDirection((prev) => (prev === "asc" ? "desc" : "asc"));
      return;
    }
    setSortField(field);
    setSortDirection("desc");
  }

  return (
    <PageFrame
      eyebrow="Claims Explorer"
      title="Claims review table"
      description="Search, sort, and filter claims surfaced by the detection APIs in a high-density investigation view."
      actions={[
        <StatusBadge key="count" variant="outline">{rows.length} records</StatusBadge>,
        <StatusBadge key="severity" variant="outline">{severityFilter === "all" ? "All severities" : severityFilter}</StatusBadge>,
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
              className="h-11 w-full rounded-xl border border-border bg-background pl-9 pr-3 text-sm shadow-sm outline-none transition focus:border-primary focus:ring-2 focus:ring-primary/20"
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
                  <button className="inline-flex items-center gap-2 font-medium text-foreground transition hover:text-primary" onClick={() => toggleSort("claimId")}>
                    Claim ID <ArrowUpDown className="h-3.5 w-3.5" />
                  </button>
                </th>
                <th>
                  <button className="inline-flex items-center gap-2 font-medium text-foreground transition hover:text-primary" onClick={() => toggleSort("riskScore")}>
                    Risk score <ArrowUpDown className="h-3.5 w-3.5" />
                  </button>
                </th>
                <th>Status</th>
                <th>Policy holder</th>
                <th>
                  <button className="inline-flex items-center gap-2 font-medium text-foreground transition hover:text-primary" onClick={() => toggleSort("detectionDate")}>
                    Detection date <ArrowUpDown className="h-3.5 w-3.5" />
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
                rows.map((claim) => (
                  <tr key={claim.claimId}>
                    <td className="font-medium text-foreground">
                      <Link to={`/claims/${encodeURIComponent(claim.claimId)}`} className="text-primary underline-offset-4 hover:underline focus-visible:underline">
                        {claim.claimId}
                      </Link>
                    </td>
                    <td>{Number.isFinite(claim.riskScore) ? claim.riskScore : "Unavailable"}</td>
                    <td>
                      <CaseStamp tone={statusStampTone(claim.status)}>{claim.status.replace(/_/g, " ")}</CaseStamp>
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
        <div className="mt-4 flex items-center justify-between gap-3 text-sm text-muted-foreground">
          <p>Showing {rows.length} matching claims from the current snapshot.</p>
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" className="h-9 rounded-full px-3" disabled>
              <ChevronLeft className="mr-1 h-4 w-4" /> Prev
            </Button>
            <Button variant="outline" size="sm" className="h-9 rounded-full px-3" disabled>
              Next <ChevronRight className="ml-1 h-4 w-4" />
            </Button>
          </div>
        </div>
      </SectionCard>
    </PageFrame>
  );
}
