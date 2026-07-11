import React from "react";
import DetailPanel from "./DetailPanel";

function createMetric(label, value) {
  return (
    <dl className="metric" key={label}>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </dl>
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
      )}
    </section>
  );
}

export default function SchemeDetail({ scheme }) {
  if (!scheme) return <div className="panel">Scheme not found</div>;

  return (
    <div>
      <DetailPanel title={scheme.scheme_id} meta={`providers ${scheme.provider_count} · claims ${scheme.claim_count}`}>
        <div className="metrics">
          {createMetric("Provider score median", scheme.summary?.provider_score_median ?? 0)}
          {createMetric("Member score median", scheme.summary?.member_score_median ?? 0)}
          {createMetric("Provider findings", (scheme.provider_findings || []).length)}
          {createMetric("Member findings", (scheme.member_findings || []).length)}
        </div>
      </DetailPanel>

      <RenderFindings title="Provider findings" findings={scheme.provider_findings || []} />
      <RenderFindings title="Member findings" findings={scheme.member_findings || []} />
    </div>
  );
}
