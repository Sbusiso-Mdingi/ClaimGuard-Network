import React from "react";
import DetailPanel from "./DetailPanel";

export default function MemberDetail({ scheme, detectionId, onBack }) {
  const all = [...(scheme.provider_findings || []), ...(scheme.member_findings || [])];
  const finding = all.find((f) => f.detection_id === detectionId) || null;

  if (!finding) return <div className="panel">Finding not found</div>;

  return (
    <div>
      <button onClick={onBack}>← Back to entity</button>
      <DetailPanel title={`Finding ${detectionId}`} meta={`score ${finding.score}`}> 
        <div className="metrics">
          <dl className="metric"><dt>Detection id</dt><dd>{finding.detection_id}</dd></dl>
          <dl className="metric"><dt>Score</dt><dd>{finding.score}</dd></dl>
          <dl className="metric"><dt>Provider</dt><dd>{finding.provider_id}</dd></dl>
          <dl className="metric"><dt>Entity</dt><dd>{finding.entity_id || finding.member_id}</dd></dl>
        </div>

        <h3>Details</h3>
        <p>{finding.description}</p>
        {finding.reasons && <pre style={{ whiteSpace: "pre-wrap" }}>{finding.reasons.join("\n")}</pre>}
      </DetailPanel>
    </div>
  );
}
