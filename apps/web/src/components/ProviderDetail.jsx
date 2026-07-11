import React, { useMemo } from "react";
import DetailPanel from "./DetailPanel";

export default function ProviderDetail({ scheme, providerId, onSelectEntity, onBack }) {
  const findings = useMemo(() => (scheme.provider_findings || []).filter((f) => f.provider_id === providerId), [scheme, providerId]);

  const entities = useMemo(() => {
    const map = new Map();
    for (const f of findings) {
      const id = f.entity_id || f.member_id || "unknown";
      const entry = map.get(id) || { entity_id: id, findings: [], scoreSum: 0, scoreCount: 0 };
      entry.findings.push(f);
      entry.scoreSum += f.score || 0;
      entry.scoreCount += f.score != null ? 1 : 0;
      map.set(id, entry);
    }
    return Array.from(map.values()).map((e) => ({ ...e, avgScore: e.scoreCount ? e.scoreSum / e.scoreCount : 0 }));
  }, [findings]);

  return (
    <div>
      <button onClick={onBack}>← Back to scheme</button>
      <DetailPanel title={`Provider ${providerId}`} meta={`${findings.length} findings`}>
        <div className="metrics">
          <dl className="metric"><dt>Avg score</dt><dd>{(entities.reduce((s, e) => s + e.avgScore, 0) / (entities.length || 1)).toFixed(2)}</dd></dl>
          <dl className="metric"><dt>Entities</dt><dd>{entities.length}</dd></dl>
          <dl className="metric"><dt>Findings</dt><dd>{findings.length}</dd></dl>
        </div>

        <h3>Entities</h3>
        {entities.length === 0 ? (
          <div className="empty">No entities for this provider.</div>
        ) : (
          <ul className="finding-list">
            {entities.map((e) => (
              <li key={e.entity_id} className="finding" onClick={() => onSelectEntity(e.entity_id)} style={{ cursor: "pointer" }}>
                <strong>{e.entity_id} · score {e.avgScore.toFixed(2)}</strong>
                <p>{`${e.findings.length} findings`}</p>
              </li>
            ))}
          </ul>
        )}
      </DetailPanel>
    </div>
  );
}
