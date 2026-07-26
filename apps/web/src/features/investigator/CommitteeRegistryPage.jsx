import React, { useState } from "react";
import Search from "lucide-react/dist/esm/icons/search.mjs";
import History from "lucide-react/dist/esm/icons/history.mjs";
import { useRole } from "../../context/RoleContext";
import { apiRequest } from "../../lib/apiClient";
import { hasCapability } from "../../lib/capabilities";
import {
  EmptyState,
  FormField,
  PageFrame,
  SectionCard,
  StatusIndicator,
  WorkspaceNotice,
  formatEnumLabel,
} from "./InvestigatorUI";
import { Input } from "../../components/ui/input";
import { Button } from "../../components/ui/button";

export function CommitteeRegistryPage() {
  const { identity } = useRole();
  const canSearch = hasCapability(identity, "fraud_registry.search");
  const canViewHistory = hasCapability(identity, "fraud_registry.review_history");
  const [subjectToken, setSubjectToken] = useState("");
  const [results, setResults] = useState(null);
  const [history, setHistory] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);

  async function search(event) {
    event.preventDefault();
    if (!canSearch) return;
    const token = subjectToken.trim();
    if (!token) return;
    setLoading(true);
    setError(null);
    setHistory(null);
    try {
      const response = await apiRequest(`/registry/search?subjectToken=${encodeURIComponent(token)}`);
      const json = await response.json();
      if (!response.ok || !json.available) {
        setError(json.message || "The registry search could not be completed.");
        setResults(null);
        return;
      }
      setResults(Array.isArray(json.results) ? json.results : []);
    } catch (requestError) {
      setError(requestError.message || "The registry API could not be reached.");
      setResults(null);
    } finally {
      setLoading(false);
    }
  }

  async function loadHistory() {
    if (!canViewHistory) return;
    const token = subjectToken.trim();
    if (!token) return;
    setLoading(true);
    setError(null);
    try {
      const response = await apiRequest(`/registry/history/${encodeURIComponent(token)}`);
      const json = await response.json();
      if (!response.ok || !json.available) {
        setError(json.message || "Registry history could not be loaded.");
        setHistory(null);
        return;
      }
      setHistory(Array.isArray(json.history) ? json.history : []);
    } catch (requestError) {
      setError(requestError.message || "Registry history could not be reached.");
      setHistory(null);
    } finally {
      setLoading(false);
    }
  }

  const hasSearched = results !== null;

  return (
    <PageFrame
      eyebrow="Applications committee"
      title="Shared fraud registry"
      description={`${identity.label} can review confirmed fraud publications and reversals only. Claim records, model scores, and investigation notes are intentionally excluded.`}
    >
      <SectionCard title="Registry search" description="Search using the member or provider subject token supplied through the authorised applications workflow.">
        <form onSubmit={search} className="grid gap-4 lg:grid-cols-[minmax(0,28rem)_auto] lg:items-end">
          <FormField label="Member or provider token" htmlFor="registry-subject-token" hint="Use the exact subject token; partial-name searches are not supported.">
            <Input
              id="registry-subject-token"
              value={subjectToken}
              onChange={(event) => setSubjectToken(event.target.value)}
              placeholder="Enter subject token"
              autoComplete="off"
            />
          </FormField>
          <div className="flex flex-wrap gap-2">
            {canSearch ? (
              <Button type="submit" disabled={loading || !subjectToken.trim()}>
                <Search className="mr-2 h-4 w-4" />
                {loading ? "Searching..." : "Search registry"}
              </Button>
            ) : null}
            {canViewHistory ? (
              <Button type="button" variant="outline" onClick={loadHistory} disabled={loading || !subjectToken.trim()}>
                <History className="mr-2 h-4 w-4" />
                View history
              </Button>
            ) : null}
          </div>
        </form>
        {error ? <div className="mt-4"><WorkspaceNotice title="Registry request failed" tone="danger">{error}</WorkspaceNotice></div> : null}
      </SectionCard>

      <SectionCard title="Active findings" description="Current unreversed fraud publications matching the searched subject token.">
        {!hasSearched ? (
          <EmptyState icon={Search} title="Search the registry" description="Enter a subject token above to retrieve current active findings." />
        ) : results.length === 0 ? (
          <EmptyState icon={Search} title="No active findings" description="The registry returned no active confirmed-fraud publication for this subject token." />
        ) : (
          <div className="grid gap-3 lg:grid-cols-2">
            {results.map((entry) => (
              <article key={entry.registryEntryId} className="rounded-xl border border-border/70 bg-background/40 p-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="font-semibold text-foreground">{entry.medicalScheme || "Medical scheme unavailable"}</p>
                    <p className="mt-1 text-sm leading-6 text-muted-foreground">
                      {formatEnumLabel(entry.fraudSubjectType)} · {formatEnumLabel(entry.offenceCategory)}
                    </p>
                  </div>
                  <StatusIndicator tone={entry.status === "ACTIVE" ? "danger" : "info"} variant="badge">
                    {formatEnumLabel(entry.status)}
                  </StatusIndicator>
                </div>
                <dl className="mt-4 grid gap-3 sm:grid-cols-2">
                  <div>
                    <dt className="text-xs uppercase tracking-[0.14em] text-muted-foreground">Finding date</dt>
                    <dd className="mt-1 text-sm font-medium">{entry.findingDate || "Not available"}</dd>
                  </div>
                  <div>
                    <dt className="text-xs uppercase tracking-[0.14em] text-muted-foreground">Registry reference</dt>
                    <dd className="mt-1 break-all font-data text-xs">{entry.registryEntryId}</dd>
                  </div>
                </dl>
              </article>
            ))}
          </div>
        )}
      </SectionCard>

      {history !== null ? (
        <SectionCard title="Registry history" description="Publication history for the searched token, including reversals.">
          {history.length === 0 ? (
            <EmptyState compact icon={History} title="No registry history" description="No publication or reversal history is available for this subject token." />
          ) : (
            <ol className="space-y-3">
              {history.map((entry) => (
                <li key={entry.registryEntryId} className="rounded-xl border border-border/70 bg-background/40 p-4">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <StatusIndicator variant="badge" tone={entry.status === "ACTIVE" ? "danger" : entry.status === "REVERSED" ? "success" : "info"}>
                      {formatEnumLabel(entry.status)}
                    </StatusIndicator>
                    <time className="text-xs text-muted-foreground">
                      {entry.publicationTimestamp ? new Date(entry.publicationTimestamp).toLocaleString("en-GB") : "Timestamp unavailable"}
                    </time>
                  </div>
                  <p className="mt-3 break-all font-data text-xs text-muted-foreground">Ledger hash: {entry.ledgerHash || "Not available"}</p>
                </li>
              ))}
            </ol>
          )}
        </SectionCard>
      ) : null}
    </PageFrame>
  );
}
