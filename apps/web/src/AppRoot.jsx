import React, { useEffect, useState, useMemo } from "react";
import * as Sentry from "@sentry/react";
import FilterBar from "./components/FilterBar";
import SchemeDetail from "./components/SchemeDetail";
import ProviderList from "./components/ProviderList";
import ProviderDetail from "./components/ProviderDetail";
import EntityDetail from "./components/EntityDetail";
import MemberDetail from "./components/MemberDetail";
import NetworkGraph from "./components/NetworkGraph";

function createMetric(label, value) {
  return (
    <dl className="metric" key={label}>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </dl>
  );
}

function formatList(items, emptyLabel) {
  if (!items?.length) {
    return <div className="empty">{emptyLabel}</div>;
  }

  return (
    <ul className="finding-list">
      {items.map((item, idx) => (
        <li className="finding" key={idx}>
          <strong>{item.title}</strong>
          <p>{item.description}</p>
        </li>
      ))}
    </ul>
  );
}

function RenderFindings({ title, findings }) {
  return (
    <section className="panel scheme">
      <header className="section-header">
        <h2>{title}</h2>
        <span className="pill">{findings.length} items</span>
      </header>
      {findings.length === 0 ? (
        <div className="empty">No findings in the top-N slice for this scheme.</div>
      ) : (
        <div>
          {/* Paginated rendering should be controlled by parent via filters */}
          <ul className="finding-list">
            {findings.map((finding, i) => (
              <li className="finding" key={i}>
                <strong>{`${finding.entity_id} · score ${finding.score}`}</strong>
                <p>
                  {`claims: ${finding.metrics?.claim_count ?? "n/a"} · avg amount: ${finding.metrics?.average_amount ?? finding.metrics?.total_amount ?? "n/a"} · note: ${finding.reasons?.join(" ") ?? "No textual explanation recorded."}`}
                </p>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}



export default function AppRoot() {
  const [state, setState] = useState({ status: "loading", report: null, message: null });
  const [route, setRoute] = useState({ name: "overview", params: {} });
  const [filters, setFilters] = useState({
    search: "",
    schemeId: null,
    risk: "all",
    detectionStatus: null,
    sortBy: "score_desc",
    page: 1,
    pageSize: 25,
  });

  useEffect(() => {
    let mounted = true;

    async function load() {
      try {
        const res = await fetch("/api/detection/report");
        const payload = await res.json();

        if (!res.ok || !payload.available) {
          if (!mounted) return;
          setState({ status: "error", report: null, message: payload.message || `Detection report unavailable (${res.status})` });
          return;
        }

        if (!mounted) return;
        setState({ status: "ready", report: payload.report, message: null });
      } catch (err) {
        if (!mounted) return;
        setState({ status: "error", report: null, message: err instanceof Error ? err.message : "Failed to load detection report." });
      }
    }

    load();
    return () => (mounted = false);
  }, []);

  useEffect(() => {
    function onHashChange() {
      const hash = window.location.hash || "";
      // /scheme/:schemeId/provider/:providerId/entity/:entityId/finding/:findingId
      const fullFinding = hash.match(/^#\/scheme\/([^/]+)\/provider\/([^/]+)\/entity\/([^/]+)\/finding\/([^/]+)$/);
      if (fullFinding) {
        setRoute({ name: "finding", params: { schemeId: decodeURIComponent(fullFinding[1]), providerId: decodeURIComponent(fullFinding[2]), entityId: decodeURIComponent(fullFinding[3]), detectionId: decodeURIComponent(fullFinding[4]) } });
        return;
      }

      const entityMatch = hash.match(/^#\/scheme\/([^/]+)\/provider\/([^/]+)\/entity\/([^/]+)$/);
      if (entityMatch) {
        setRoute({ name: "entity", params: { schemeId: decodeURIComponent(entityMatch[1]), providerId: decodeURIComponent(entityMatch[2]), entityId: decodeURIComponent(entityMatch[3]) } });
        return;
      }

      const providerMatch = hash.match(/^#\/scheme\/([^/]+)\/provider\/([^/]+)$/);
      if (providerMatch) {
        setRoute({ name: "provider", params: { schemeId: decodeURIComponent(providerMatch[1]), providerId: decodeURIComponent(providerMatch[2]) } });
        return;
      }

      const schemeMatch = hash.match(/^#\/scheme\/([^/]+)$/);
      if (schemeMatch) {
        setRoute({ name: "scheme", params: { schemeId: decodeURIComponent(schemeMatch[1]) } });
        return;
      }

      setRoute({ name: "overview", params: {} });
    }

    onHashChange();
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

  // derive a flat list of findings with context for efficient client-side filtering
  const allFindings = useMemo(() => {
    const list = [];
    const report = state.report;
    if (!report?.schemes) return list;
    for (const scheme of report.schemes) {
      const schemeId = scheme.scheme_id;
      for (const f of scheme.provider_findings || []) {
        list.push({
          ...f,
          _scheme_id: schemeId,
          _scheme_name: scheme.scheme_name || schemeId,
          _type: "provider",
        });
      }
      for (const f of scheme.member_findings || []) {
        list.push({
          ...f,
          _scheme_id: schemeId,
          _scheme_name: scheme.scheme_name || schemeId,
          _type: "member",
        });
      }
    }
    return list;
  }, [state.report]);

  const filteredFindings = useMemo(() => {
    const s = (filters.search || "").trim().toLowerCase();
    const schemeFilter = filters.schemeId || null;
    const risk = filters.risk || "all";
    const status = filters.detectionStatus || null;

    const scoreFilter = (score) => {
      if (score == null) return true;
      if (risk === "all") return true;
      if (risk === "low") return score < 0.3;
      if (risk === "medium") return score >= 0.3 && score < 0.7;
      if (risk === "high") return score >= 0.7;
      return true;
    };

    let out = allFindings.filter((item) => {
      if (schemeFilter && item._scheme_id !== schemeFilter) return false;
      if (status && item.status !== status) return false;
      if (!scoreFilter(item.score)) return false;

      if (!s) return true;

      // fields to search: scheme name/id, provider/member/display fields, detection id
      const fields = [item._scheme_id, item._scheme_name, item.provider_id, item.entity_id, item.member_id, item.detection_id, item.title, item.description, item.reasons?.join(" ")];
      return fields.some((f) => (f || "").toString().toLowerCase().includes(s));
    });

    // sorting
    const sortBy = filters.sortBy || "score_desc";
    out.sort((a, b) => {
      if (sortBy === "score_desc") return (b.score || 0) - (a.score || 0);
      if (sortBy === "score_asc") return (a.score || 0) - (b.score || 0);
      if (sortBy === "claims_desc") return (b.metrics?.claim_count || 0) - (a.metrics?.claim_count || 0);
      if (sortBy === "claims_asc") return (a.metrics?.claim_count || 0) - (b.metrics?.claim_count || 0);
      if (sortBy === "id_asc") return (a.entity_id || "").localeCompare(b.entity_id || "");
      return 0;
    });

    return out;
  }, [allFindings, filters]);

  const resultCount = filteredFindings.length;

  if (state.status === "loading") {
    return (
      <div id="app-root">
        <section className="hero fade-in">
          <p className="eyebrow">ClaimGuard Network</p>
          <h1>Network risk, surfaced.</h1>
          <p className="lede">This dashboard reads the synthetic detection report generated by the Phase 4 engine and highlights suspicious providers, members, and scheme-level summary metrics.</p>
          <div className="status-row">Loading detection report...</div>
        </section>
        <section className="grid fade-in">
          <div className="panel empty">Waiting for the API proxy to return a report.</div>
        </section>
      </div>
    );
  }

  if (state.status === "error") {
    return (
      <div id="app-root">
        <section className="hero fade-in">
          <p className="eyebrow">ClaimGuard Network</p>
          <h1>Network risk, surfaced.</h1>
          <p className="lede">This dashboard reads the synthetic detection report generated by the Phase 4 engine and highlights suspicious providers, members, and scheme-level summary metrics.</p>
          <div className="error">{state.message}</div>
        </section>
      </div>
    );
  }

  const report = state.report;
  const schemes = report?.schemes || [];
  const firstScheme = schemes[0];

  // navigation helpers
  function goToScheme(schemeId) {
    window.location.hash = `#/scheme/${encodeURIComponent(schemeId)}`;
  }

  function goToProvider(schemeId, providerId) {
    window.location.hash = `#/scheme/${encodeURIComponent(schemeId)}/provider/${encodeURIComponent(providerId)}`;
  }

  function goToEntity(schemeId, providerId, entityId) {
    window.location.hash = `#/scheme/${encodeURIComponent(schemeId)}/provider/${encodeURIComponent(providerId)}/entity/${encodeURIComponent(entityId)}`;
  }

  function goToFinding(schemeId, providerId, entityId, detectionId) {
    window.location.hash = `#/scheme/${encodeURIComponent(schemeId)}/provider/${encodeURIComponent(providerId)}/entity/${encodeURIComponent(entityId)}/finding/${encodeURIComponent(detectionId)}`;
  }

  if (route.name === "scheme") {
    const scheme = schemes.find((s) => s.scheme_id === route.params.schemeId) || null;
    return (
      <div>
        <FilterBar filters={filters} schemes={report?.schemes} resultCount={resultCount} onChange={setFilters} onClear={() => setFilters({ search: "", schemeId: null, risk: "all", detectionStatus: null, sortBy: "score_desc" })} />
        <section className="hero fade-in">
          <p className="eyebrow">ClaimGuard Network</p>
          <h1>Network risk, surfaced.</h1>
          <div className="status-row">
            <button onClick={() => (window.location.hash = "")}>← Back</button>
            <span className="pill">Scheme: {route.params.schemeId}</span>
          </div>
        </section>
        <section className="grid fade-in">
          <SchemeDetail scheme={scheme} />
          <ProviderList scheme={scheme} onSelectProvider={(providerId) => goToProvider(route.params.schemeId, providerId)} />
          <NetworkGraph report={report} filteredFindings={filteredFindings.filter((f) => f._scheme_id === route.params.schemeId)} filters={filters} onNavigate={(nav) => {
            // reuse routing helpers from AppRoot
            if (nav.type === 'scheme') goToScheme(nav.schemeId);
            if (nav.type === 'provider') goToProvider(nav.schemeId, nav.providerId);
            if (nav.type === 'entity') goToEntity(nav.schemeId, nav.providerId || '', nav.entityId);
            if (nav.type === 'finding') goToFinding(nav.schemeId, nav.providerId || '', nav.entityId || '', nav.detectionId);
          }} />
          <section className="panel">
            <h3>Filtered Results</h3>
            <div className="finding-list">
              {/* Paginate filteredFindings for scheme */}
              {(() => {
                const items = filteredFindings.filter((f) => f._scheme_id === route.params.schemeId);
                const page = filters.page || 1;
                const pageSize = filters.pageSize || 25;
                const start = (page - 1) * pageSize;
                return items.slice(start, start + pageSize).map((f, i) => (
                  <div key={i} className="finding">
                    <strong>{f.entity_id || f.provider_id || "n/a"} · score {f.score}</strong>
                    <p>{f.reasons?.join(" ") || f.description}</p>
                  </div>
                ));
              })()}
            </div>
            <div style={{ marginTop: 8 }}>
              <button onClick={() => setFilters({ ...filters, page: 1 })}>First</button>
              <button onClick={() => setFilters({ ...filters, page: Math.max(1, (filters.page || 1) - 1) })}>Prev</button>
              <span style={{ margin: '0 8px' }}>Page {filters.page || 1}</span>
              <button onClick={() => setFilters({ ...filters, page: (filters.page || 1) + 1 })}>Next</button>
            </div>
          </section>
        </section>
      </div>
    );
  }

  if (route.name === "provider") {
    const scheme = schemes.find((s) => s.scheme_id === route.params.schemeId) || null;
    if (!scheme) return <div className="panel">Scheme not found</div>;
    return (
      <div>
        <FilterBar filters={filters} schemes={report?.schemes} resultCount={resultCount} onChange={setFilters} onClear={() => setFilters({ search: "", schemeId: null, risk: "all", detectionStatus: null, sortBy: "score_desc", page: 1 })} />
        <ProviderDetail scheme={scheme} providerId={route.params.providerId} onSelectEntity={(entityId) => goToEntity(route.params.schemeId, route.params.providerId, entityId)} onBack={() => goToScheme(route.params.schemeId)} filters={filters} setFilters={setFilters} />
      </div>
    );
  }

  if (route.name === "entity") {
    const scheme = schemes.find((s) => s.scheme_id === route.params.schemeId) || null;
    if (!scheme) return <div className="panel">Scheme not found</div>;
    return (
      <div>
        <FilterBar filters={filters} schemes={report?.schemes} resultCount={resultCount} onChange={setFilters} onClear={() => setFilters({ search: "", schemeId: null, risk: "all", detectionStatus: null, sortBy: "score_desc", page: 1 })} />
        <EntityDetail scheme={scheme} providerId={route.params.providerId} entityId={route.params.entityId} onSelectFinding={(detectionId) => goToFinding(route.params.schemeId, route.params.providerId, route.params.entityId, detectionId)} onBack={() => goToProvider(route.params.schemeId, route.params.providerId)} filters={filters} setFilters={setFilters} />
      </div>
    );
  }

  if (route.name === "finding") {
    const scheme = schemes.find((s) => s.scheme_id === route.params.schemeId) || null;
    if (!scheme) return <div className="panel">Scheme not found</div>;
    return (
      <div>
        <FilterBar filters={filters} schemes={report?.schemes} resultCount={resultCount} onChange={setFilters} onClear={() => setFilters({ search: "", schemeId: null, risk: "all", detectionStatus: null, sortBy: "score_desc" })} />
        <MemberDetail scheme={scheme} detectionId={route.params.detectionId} onBack={() => goToEntity(route.params.schemeId, route.params.providerId, route.params.entityId)} />
      </div>
    );
  }

  return (
    <div>
      <FilterBar filters={filters} schemes={report?.schemes} onChange={setFilters} onClear={() => setFilters({ search: "", schemeId: null, risk: "all", detectionStatus: null, sortBy: "score_desc", resultCount: 0 })} />
      <section className="hero fade-in">
        <p className="eyebrow">ClaimGuard Network</p>
        <h1>Network risk, surfaced.</h1>
        <p className="lede">This dashboard reads the synthetic detection report generated by the Phase 4 engine and highlights suspicious providers, members, and scheme-level summary metrics.</p>
        <div className="status-row">
          <span className="pill">Schemes: {schemes.length}</span>
          <span className="pill">Data dir: {report?.data_dir || "unknown"}</span>
          <span className="pill">{firstScheme ? `Current: ${firstScheme.scheme_id}` : "No scheme data"}</span>
        </div>
      </section>

      <section className="grid fade-in">
        <section className="panel">
          <header className="section-header">
            <h2>Summary</h2>
            <span className="pill">{schemes.length} schemes</span>
          </header>
          {firstScheme ? (
            <div className="metrics">
              {createMetric("Providers", firstScheme.provider_count ?? 0)}
              {createMetric("Claims", firstScheme.claim_count ?? 0)}
              {createMetric("Members", firstScheme.member_count ?? 0)}
              {createMetric("Provider score median", firstScheme.summary?.provider_score_median ?? 0)}
            </div>
          ) : (
            <div className="empty">No scheme data returned by the API proxy.</div>
          )}
        </section>

        {schemes.map((scheme) => (
          <section className="panel scheme" key={scheme.scheme_id}>
            <header>
              <div style={{ cursor: "pointer" }} onClick={() => goToScheme(scheme.scheme_id)}>{scheme.scheme_id}</div>
              <div className="pill">providers {scheme.provider_count} · claims {scheme.claim_count}</div>
            </header>

            <div className="metrics">
              {createMetric("Provider score median", scheme.summary?.provider_score_median ?? 0)}
              {createMetric("Member score median", scheme.summary?.member_score_median ?? 0)}
              {createMetric("Provider findings", (scheme.provider_findings || []).length)}
              {createMetric("Member findings", (scheme.member_findings || []).length)}
            </div>

            <RenderFindings title="Provider findings" findings={scheme.provider_findings || []} />
            <RenderFindings title="Member findings" findings={scheme.member_findings || []} />
          </section>
        ))}

        <section className="panel">
          <h3>Filtered Results</h3>
          <div className="finding-list">
            {filteredFindings.slice(0, 200).map((f, i) => (
              <div key={i} className="finding">
                <strong>{f._scheme_id} · {f.entity_id || f.provider_id || "n/a"} · score {f.score}</strong>
                <p>{f.reasons?.join(" ") || f.description}</p>
              </div>
            ))}
          </div>
        </section>

        {report?.network && (
          (() => {
            const network = report.network;
            const exactLinks = network.exact_banking_links || [];
            const behavioralLinks = network.behavioral_provider_links || [];
            const resolvedEntities = network.resolved_entities || [];

            return (
              <>
                <section className="panel">
                  <h2>Network Summary</h2>
                  <div className="metrics">
                    {createMetric("Exact bank links", exactLinks.length)}
                    {createMetric("Behavioral links", behavioralLinks.length)}
                    {createMetric("Resolved entities", resolvedEntities.length)}
                    {createMetric("Provider nodes", (network.network_nodes || []).length)}
                  </div>
                </section>

                <section className="panel network-panel">
                  <header className="section-header">
                    <h2>Exact banking links</h2>
                    <span className="pill">{exactLinks.length} links</span>
                  </header>
                  {exactLinks.length === 0 ? (
                    <div className="empty">No cross-scheme bank matches detected in the current slice.</div>
                  ) : (
                    <ul className="finding-list">
                      {exactLinks.slice(0, 5).map((link, i) => (
                        <li className="finding link-finding" key={i}>
                          <strong>{`${link.synthetic_banking_detail} · ${link.providers.length} providers`}</strong>
                          <p>{`${link.providers.map((p) => p.provider_id).join(" ↔ ")} · schemes ${link.providers.map((p) => p.scheme_id).join(", ")}`}</p>
                        </li>
                      ))}
                    </ul>
                  )}
                </section>

                <section className="panel network-panel">
                  <header className="section-header">
                    <h2>Behavioral provider links</h2>
                    <span className="pill">{behavioralLinks.length} links</span>
                  </header>
                  {behavioralLinks.length === 0 ? (
                    <div className="empty">No fuzzy provider relationships crossed the confidence threshold.</div>
                  ) : (
                    <ul className="finding-list">
                      {behavioralLinks.slice(0, 5).map((link, i) => (
                        <li className="finding link-finding" key={i}>
                          <strong>{`${link.providers.join(" ↔ ")} · confidence ${link.confidence}`}</strong>
                          <p>{`schemes ${link.schemes?.join(", ") || "n/a"} · type ${link.link_type || "behavioral_provider_match"}`}</p>
                        </li>
                      ))}
                    </ul>
                  )}
                </section>

                <section className="panel">
                  <header className="section-header">
                    <h2>Resolved Provider Clusters</h2>
                    <span className="pill">{resolvedEntities.length} clusters</span>
                  </header>
                  {formatList(
                    resolvedEntities.slice(0, 3).map((entity) => ({
                      title: `${entity.resolved_entity_id} · confidence ${entity.confidence}`,
                      description: `${entity.schemes.join(", ")} · ${entity.providers.join(", ")}`,
                    })),
                    "No cross-scheme clusters detected in the current slice.",
                  )}
                </section>
              </>
            );
          })()
        )}

        {report?.evaluation && (
          <section className="panel">
            <h2>Evaluation</h2>
            <div className="metrics">
              {createMetric("Single-scheme recall", report.evaluation.single_scheme?.recall ?? "n/a")}
              {createMetric("Cross-scheme recall", report.evaluation.cross_scheme?.recall ?? "n/a")}
              {createMetric("Single detected", report.evaluation.single_scheme?.detected ?? 0)}
              {createMetric("Cross detected", report.evaluation.cross_scheme?.detected ?? 0)}
            </div>
            {report.evaluation.available === false && <div className="panel">Ground-truth evaluation data is not available for the current slice.</div>}
          </section>
        )}

        <section className="panel">
          <h2>Smoke test</h2>
          <p className="lede">Use this to confirm browser telemetry is still wired.</p>
          <button
            type="button"
            onClick={async () => {
              const error = new Error("Phase0 web Sentry smoke test error");
              Sentry.captureException(error);
              await Sentry.flush(2000);
              window.alert("Captured web Sentry smoke test error and flushed the event.");
            }}
          >
            Throw Test Error
          </button>
        </section>
      </section>
    </div>
  );
}
