import React, { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { Input } from "../../components/ui/input";
import { Button } from "../../components/ui/button";
import { Badge } from "../../components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../../components/ui/card";

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
    <Card>
      <CardHeader>
        <CardTitle>Claims Explorer</CardTitle>
        <CardDescription>Search, sort, and filter claims surfaced by the detection APIs.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid gap-2 md:grid-cols-[1fr_auto_auto]">
          <Input
            aria-label="Search claims"
            placeholder="Search claim id, policy holder, status, rule..."
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          <select
            aria-label="Filter by severity"
            value={severityFilter}
            onChange={(event) => setSeverityFilter(event.target.value)}
            className="h-9 rounded-md border border-border bg-background px-3 text-sm"
          >
            <option value="all">All severities</option>
            <option value="high">High</option>
            <option value="medium">Medium</option>
            <option value="low">Low</option>
          </select>
          <Button variant="outline" onClick={() => { setQuery(""); setSeverityFilter("all"); }}>Clear</Button>
        </div>

        <div className="overflow-x-auto rounded-md border border-border">
          <table className="min-w-full text-left text-sm" aria-label="Claims table">
            <thead className="bg-muted/60 text-xs uppercase text-muted-foreground">
              <tr>
                <th className="px-3 py-2"><button onClick={() => toggleSort("claimId")}>Claim ID</button></th>
                <th className="px-3 py-2"><button onClick={() => toggleSort("riskScore")}>Risk score</button></th>
                <th className="px-3 py-2">Status</th>
                <th className="px-3 py-2">Policy holder</th>
                <th className="px-3 py-2"><button onClick={() => toggleSort("detectionDate")}>Detection date</button></th>
                <th className="px-3 py-2">Triggered rules</th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 ? (
                <tr>
                  <td colSpan={6} className="px-3 py-6 text-center text-muted-foreground">No claims match your filters.</td>
                </tr>
              ) : (
                rows.map((claim) => (
                  <tr key={claim.claimId} className="border-t border-border">
                    <td className="px-3 py-2 font-medium">
                      <Link to={`/claims/${encodeURIComponent(claim.claimId)}`} className="text-primary underline-offset-4 hover:underline">{claim.claimId}</Link>
                    </td>
                    <td className="px-3 py-2">{Number.isFinite(claim.riskScore) ? claim.riskScore : "Unavailable"}</td>
                    <td className="px-3 py-2"><Badge variant={claim.severity === "High" ? "destructive" : claim.severity === "Medium" ? "warning" : "secondary"}>{claim.status}</Badge></td>
                    <td className="px-3 py-2">{claim.policyHolder}</td>
                    <td className="px-3 py-2">{new Date(claim.detectionDate).toLocaleString()}</td>
                    <td className="px-3 py-2 text-xs text-muted-foreground">{claim.triggeredRules.join(", ") || "No rules"}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </CardContent>
    </Card>
  );
}
