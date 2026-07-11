import React, { useMemo } from "react";
import DetailPanel from "./DetailPanel";

export default function EntityDetail({ scheme, providerId, entityId, onBack, onSelectFinding, filters, setFilters }) {
  const findings = useMemo(() => {
    return (scheme.provider_findings || []).filter((f) => f.provider_id === providerId && (f.entity_id === entityId || f.member_id === entityId));
  }, [scheme, providerId, entityId]);

  return (
    <div>
      <button onClick={onBack}>← Back to provider</button>
      <DetailPanel title={`Entity ${entityId}`} meta={`provider ${providerId}`}>
        <div className="metrics">
          <dl className="metric"><dt>Findings</dt><dd>{findings.length}</dd></dl>
          <dl className="metric"><dt>Avg score</dt><dd>{(findings.reduce((s, f) => s + (f.score || 0), 0) / (findings.length || 1)).toFixed(2)}</dd></dl>
        </div>

        <h3>Findings</h3>
        {findings.length === 0 ? (
          <div className="empty">No findings for this entity.</div>
        ) : (
          <div>
            {(() => {
              const page = filters?.page || 1;
              const pageSize = filters?.pageSize || 25;
              const start = (page - 1) * pageSize;
              return findings.slice(start, start + pageSize).map((f, i) => (
                <div key={i} className="finding">
                  <strong onClick={() => onSelectFinding(f.detection_id)} style={{ cursor: "pointer" }}>{f.detection_id || `${f.entity_id || f.member_id}`}</strong>
                  <p>{f.reasons?.join(" ") || f.description}</p>
                </div>
              ));
            })()}
            <div style={{ marginTop: 8 }}>
              <button onClick={() => setFilters({ ...filters, page: 1 })}>First</button>
              <button onClick={() => setFilters({ ...filters, page: Math.max(1, (filters.page || 1) - 1) })}>Prev</button>
              <span style={{ margin: '0 8px' }}>Page {filters?.page || 1}</span>
              <button onClick={() => setFilters({ ...filters, page: (filters.page || 1) + 1 })}>Next</button>
            </div>
          </div>
        )}
      </DetailPanel>
    </div>
  );
}
