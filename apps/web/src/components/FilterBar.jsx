import React from "react";

export default function FilterBar({
  filters,
  schemes,
  onChange,
  onClear,
  resultCount,
}) {
  const { search, schemeId, risk, detectionStatus, sortBy } = filters;
  const pageSize = filters.pageSize || 25;

  const uniqueStatuses = React.useMemo(() => {
    const set = new Set();
    for (const s of schemes || []) {
      for (const f of (s.provider_findings || [])) {
        if (f.status) set.add(f.status);
      }
      for (const f of (s.member_findings || [])) {
        if (f.status) set.add(f.status);
      }
    }
    return [...set];
  }, [schemes]);

  return (
    <div className="panel" style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
      <input
        aria-label="Search"
        placeholder="Search providers, members, detection id..."
        value={search}
        onChange={(e) => onChange({ ...filters, search: e.target.value })}
        style={{ flex: "1 1 240px", padding: 8 }}
      />

      <select value={schemeId || ""} onChange={(e) => onChange({ ...filters, schemeId: e.target.value || null })}>
        <option value="">All schemes</option>
        {(schemes || []).map((s) => (
          <option key={s.scheme_id} value={s.scheme_id}>{s.scheme_id}</option>
        ))}
      </select>

      <select value={risk} onChange={(e) => onChange({ ...filters, risk: e.target.value })}>
        <option value="all">Risk: All</option>
        <option value="low">Low</option>
        <option value="medium">Medium</option>
        <option value="high">High</option>
      </select>

      <select value={detectionStatus || ""} onChange={(e) => onChange({ ...filters, detectionStatus: e.target.value || null })}>
        <option value="">Any status</option>
        {uniqueStatuses.map((st) => (
          <option key={st} value={st}>{st}</option>
        ))}
      </select>

      <select value={sortBy} onChange={(e) => onChange({ ...filters, sortBy: e.target.value })}>
        <option value="score_desc">Sort: score desc</option>
        <option value="score_asc">Sort: score asc</option>
        <option value="claims_desc">Sort: claims desc</option>
        <option value="claims_asc">Sort: claims asc</option>
        <option value="id_asc">Sort: id asc</option>
      </select>

      <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span>Page size</span>
        <select value={pageSize} onChange={(e) => onChange({ ...filters, pageSize: Number(e.target.value), page: 1 })}>
          <option value={10}>10</option>
          <option value={25}>25</option>
          <option value={50}>50</option>
          <option value={100}>100</option>
        </select>
      </label>

      <button onClick={onClear}>Clear filters</button>

      <div style={{ marginLeft: "auto" }}>
        <strong>{resultCount ?? 0}</strong> results
      </div>
    </div>
  );
}
