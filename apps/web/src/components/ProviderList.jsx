import React, { useMemo } from "react";
import DetailPanel from "./DetailPanel";

export default function ProviderList({ scheme, onSelectProvider }) {
  const providers = useMemo(() => {
    const map = new Map();
    for (const f of scheme.provider_findings || []) {
      const id = f.provider_id || "unknown";
      const entry = map.get(id) || { provider_id: id, scoreSum: 0, scoreCount: 0, claims: 0, findings: [] };
      entry.scoreSum += f.score || 0;
      entry.scoreCount += f.score != null ? 1 : 0;
      entry.claims += f.metrics?.claim_count || 0;
      entry.findings.push(f);
      map.set(id, entry);
    }
    return Array.from(map.values()).map((p) => ({
      ...p,
      avgScore: p.scoreCount ? p.scoreSum / p.scoreCount : 0,
    }));
  }, [scheme]);

  return (
    <DetailPanel title={`Providers (${providers.length})`} meta={`${scheme.scheme_id}`}>
      {providers.length === 0 ? (
        <div className="empty">No providers found for this scheme.</div>
      ) : (
        <ul className="finding-list">
          {providers.map((p) => (
            <li key={p.provider_id} className="finding" onClick={() => onSelectProvider(p.provider_id)} style={{ cursor: "pointer" }}>
              <strong>{p.provider_id} · score {p.avgScore.toFixed(2)}</strong>
              <p>{`findings ${p.findings.length} · claims ${p.claims}`}</p>
            </li>
          ))}
        </ul>
      )}
    </DetailPanel>
  );
}
