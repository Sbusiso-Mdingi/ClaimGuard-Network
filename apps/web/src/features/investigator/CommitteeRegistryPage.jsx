import React, { useState } from "react";
import { useRole } from "../../context/RoleContext";
import { apiRequest } from "../../lib/apiClient";
import { PageFrame, SectionCard, StatusIndicator } from "./InvestigatorUI";
import { Input } from "../../components/ui/input";
import { Button } from "../../components/ui/button";

export function CommitteeRegistryPage() {
  const { identity } = useRole();
  const [subjectToken, setSubjectToken] = useState("");
  const [results, setResults] = useState(null);
  const [history, setHistory] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);

  async function search(event) {
    event.preventDefault();
    if (!subjectToken.trim()) return;
    setLoading(true);
    setError(null);
    setHistory(null);
    try {
      const response = await apiRequest(`/registry/search?subjectToken=${encodeURIComponent(subjectToken.trim())}`);
      const json = await response.json();
      if (!response.ok || !json.available) {
        setError(json.message || "Search failed.");
        setResults(null);
        return;
      }
      setResults(json.results);
    } catch (err) {
      setError(err.message || "Could not reach the API.");
    } finally {
      setLoading(false);
    }
  }

  async function loadHistory() {
    if (!subjectToken.trim()) return;
    try {
      const response = await apiRequest(`/registry/history/${encodeURIComponent(subjectToken.trim())}`);
      const json = await response.json();
      if (response.ok && json.available) setHistory(json.history);
    } catch {
      /* ignore */
    }
  }

  return (
    <PageFrame
      eyebrow="Applications Committee"
      title="Shared fraud registry"
      description={`${identity.label} sees only confirmed fraud outcomes and reversals — no claims, risk scores, or investigation notes are exposed here.`}
    >
      <SectionCard title="Search by member or provider token" description="Look up confirmed fraud findings by subject token.">
        <form onSubmit={search} className="flex flex-wrap gap-3">
          <Input value={subjectToken} onChange={(e) => setSubjectToken(e.target.value)} placeholder="subject token" className="max-w-sm" />
          <Button type="submit" disabled={loading}>{loading ? "Searching..." : "Search"}</Button>
          <Button type="button" variant="outline" onClick={loadHistory}>View history</Button>
        </form>
        {error && <p className="mt-2 text-sm text-destructive">{error}</p>}
      </SectionCard>

      <SectionCard title="Active findings" description="Current, unreversed confirmed fraud entries matching the search.">
        {!results || results.length === 0 ? (
          <p className="text-sm text-muted-foreground">No results yet. Search for a subject token above.</p>
        ) : (
          <div className="space-y-2">
            {results.map((entry) => (
              <div key={entry.registryEntryId} className="rounded-xl border border-border/70 bg-background/70 px-4 py-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="text-sm font-semibold">{entry.medicalScheme}</p>
                  <StatusIndicator tone={entry.status === "ACTIVE" ? "danger" : "info"} variant="badge">{entry.status}</StatusIndicator>
                </div>
                <p className="text-xs text-muted-foreground">{entry.fraudSubjectType} · {entry.offenceCategory} · finding date {entry.findingDate}</p>
                <p className="mt-1 font-data text-xs">{entry.registryEntryId}</p>
              </div>
            ))}
          </div>
        )}
      </SectionCard>

      {history && (
        <SectionCard title="Registry history" description="Full history for the searched token, including reversals.">
          <div className="space-y-2">
            {history.map((entry) => (
              <div key={entry.registryEntryId} className="rounded-xl border border-border/70 bg-secondary/30 px-4 py-3 text-sm">
                <div className="flex items-center justify-between">
                  <span>{entry.status}</span>
                  <span className="text-xs text-muted-foreground">{new Date(entry.publicationTimestamp).toLocaleString()}</span>
                </div>
                <p className="text-xs text-muted-foreground">Ledger hash: {entry.ledgerHash}</p>
              </div>
            ))}
          </div>
        </SectionCard>
      )}
    </PageFrame>
  );
}
