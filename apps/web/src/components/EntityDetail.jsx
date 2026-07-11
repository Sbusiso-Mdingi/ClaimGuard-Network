import React, { useMemo } from "react";
import DetailPanel from "./DetailPanel";

export default function EntityDetail({ scheme, providerId, entityId, onBack, onSelectFinding }) {
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
          <ul className="finding-list">
            {findings.map((f, i) => (
              <li key={i} className="finding">
                <strong onClick={() => onSelectFinding(f.detection_id)} style={{ cursor: "pointer" }}>{f.detection_id || `${f.entity_id || f.member_id}`}</strong>
                <p>{f.reasons?.join(" ") || f.description}</p>
              </li>
            ))}
          </ul>
        )}
      </DetailPanel>
    </div>
  );
}
