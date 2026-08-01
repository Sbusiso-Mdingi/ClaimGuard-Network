import React, { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import Network from "lucide-react/dist/esm/icons/network.mjs";
import Radar from "lucide-react/dist/esm/icons/radar.mjs";
import ShieldAlert from "lucide-react/dist/esm/icons/shield-alert.mjs";
import Users from "lucide-react/dist/esm/icons/users.mjs";
import { EmptyState, PageFrame, SectionCard, MetricPill, StatusIndicator, SummaryRail, WorkspaceNotice } from "./InvestigatorUI";
import { NetworkGraph } from "./NetworkGraph";

export function NetworkPage({ graph }) {
  const [selectedNodeId, setSelectedNodeId] = useState(null);

  const selectedDetails = useMemo(() => {
    if (!selectedNodeId) return null;
    const entity = (graph?.nodes || []).find((item) => item.entity_id === selectedNodeId) || null;
    const links = (graph?.edges || []).filter((rel) => rel.source_entity_id === selectedNodeId || rel.target_entity_id === selectedNodeId);
    return { entity, links };
  }, [graph, selectedNodeId]);

  const graphStats = useMemo(() => {
    const entities = graph?.nodes || [];
    const relationships = graph?.edges || [];
    return {
      entities: entities.length,
      relationships: relationships.length,
      selectedLinks: selectedDetails?.links?.length || 0,
      providers: entities.filter((entity) => entity.entity_type === "provider").length,
      members: entities.filter((entity) => entity.entity_type === "member" || entity.entity_type === "claimant").length,
      reviewSignals: Number.isFinite(graph?.summary?.review_signal_count)
        ? graph.summary.review_signal_count
        : relationships.filter((relationship) => (
            relationship.review_recommended === true
            || (Number.isFinite(relationship.risk_score) && relationship.risk_score >= 75)
          )).length,
      networks: Number.isFinite(graph?.summary?.active_cluster_count)
        ? graph.summary.active_cluster_count
        : 0,
      representedClaims: Number.isFinite(graph?.summary?.represented_claim_count)
        ? graph.summary.represented_claim_count
        : relationships.length,
      isolatedSignals: Number.isFinite(graph?.summary?.isolated_review_claim_count)
        ? graph.summary.isolated_review_claim_count
        : 0,
      refreshSeconds: Number.isFinite(graph?.summary?.refresh_interval_seconds)
        ? graph.summary.refresh_interval_seconds
        : 15,
      truncated: graph?.summary?.truncated === true,
    };
  }, [graph, selectedDetails]);

  return (
    <PageFrame
      eyebrow="Network Intelligence"
      title="Fraud network candidates"
      description="Connected review signals only: a candidate needs at least three flagged claims spanning two members and two providers before it appears here."
      actions={[
        <MetricPill key="networks" label="Candidate networks" value={graphStats.networks} />,
        <MetricPill key="claims" label="Linked claims" value={graphStats.representedClaims} />,
        <MetricPill key="refresh" label="Refresh" value={`~${graphStats.refreshSeconds}s`} />,
      ]}
    >
      {graphStats.entities === 0 ? (
        <WorkspaceNotice title="No connected fraud-network candidate currently" tone="success">
          Isolated claim review signals remain in Claims Explorer. This view stays empty until a connected multi-member, multi-provider pattern meets the candidate rule.
        </WorkspaceNotice>
      ) : null}
      {graphStats.truncated ? (
        <WorkspaceNotice title="Showing the highest-priority 500 claim relationships" tone="warning">
          The scheme contains more connected review signals than the interactive view can safely render at once. Counts remain scheme-wide; the graph prioritises higher-risk and newer links.
        </WorkspaceNotice>
      ) : null}

      <SummaryRail
        ariaLabel="Network summary"
        items={[
          {
            key: "networks",
            label: "Candidate networks",
            value: graphStats.networks,
            description: "Connected multi-claim clusters",
            icon: Radar,
          },
          {
            key: "linked-claims",
            label: "Linked claims",
            value: graphStats.representedClaims,
            description: "Flagged claims represented below",
            icon: Network,
          },
          {
            key: "review-signals",
            label: "Review signals",
            value: graphStats.reviewSignals,
            description: "All graph-eligible review signals",
            icon: ShieldAlert,
            iconClassName: graphStats.reviewSignals > 0 ? "text-rose-500" : "text-muted-foreground",
          },
          {
            key: "isolated",
            label: "Isolated signals",
            value: graphStats.isolatedSignals,
            description: "Flagged claims excluded from networks",
            icon: Users,
          },
        ]}
      />

      <div className="grid gap-4 xl:grid-cols-[1.65fr_0.95fr]">
        <SectionCard
          variant="console"
          title="Suspicious connected claims"
          description={`Near-real-time projection, refreshed about every ${graphStats.refreshSeconds} seconds after scores are saved. Zoom, pan, and select a member or provider.`}
          actions={[
            <StatusIndicator key="selected" variant="badge">{selectedNodeId ? "Node selected" : "No node selected"}</StatusIndicator>,
          ]}
        >
          {graphStats.entities === 0 ? (
            <EmptyState compact icon={Network} title="No connected candidate" description="No three-claim, multi-member, multi-provider review pattern meets the projection rule yet." />
          ) : (
            <NetworkGraph
              graph={graph}
              selectedNodeId={selectedNodeId}
              onNodeSelect={setSelectedNodeId}
            />
          )}
        </SectionCard>

        <SectionCard
          variant="console"
          title="Graph details"
          description="Selected node context and the review-recommended claims in its candidate network."
        >
          <div className="space-y-4 p-5">
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-1">
              <div className="rounded-xl border border-border/70 px-4 py-3">
                <p className="text-xs uppercase tracking-[0.16em] text-muted-foreground">Selected links</p>
                <p className="mt-1 text-lg font-semibold">{graphStats.selectedLinks}</p>
              </div>
              <div className="rounded-xl border border-border/70 px-4 py-3">
                <p className="text-xs uppercase tracking-[0.16em] text-muted-foreground">Relationship count</p>
                <p className="mt-1 text-lg font-semibold">{graphStats.relationships}</p>
              </div>
            </div>

            {selectedDetails ? (
              <div className="space-y-4">
                <div className="rounded-2xl border border-border/70 bg-secondary/30 p-4">
                  <p className="text-xs uppercase tracking-[0.16em] text-muted-foreground">Selected node</p>
                  <p className="mt-1 break-all text-lg font-semibold">{selectedDetails.entity?.value || selectedDetails.entity?.entity_id}</p>
                  <p className="text-sm text-muted-foreground">{selectedDetails.entity?.entity_type} · {selectedDetails.entity?.claim_count || 0} linked claims · max risk {Number.isFinite(selectedDetails.entity?.max_risk_score) ? selectedDetails.entity.max_risk_score : "not scored"}</p>
                </div>

                <div className="rounded-2xl border border-border/70 p-4">
                  <p className="text-xs uppercase tracking-[0.16em] text-muted-foreground">Connected relationships</p>
                  <div className="mt-3 space-y-2">
                    {selectedDetails.links.length === 0 ? (
                      <p className="rounded-lg border border-dashed border-border px-3 py-3 text-xs text-muted-foreground">
                        This entity currently has no connected relationships in the loaded graph.
                      </p>
                    ) : selectedDetails.links.slice(0, 20).map((rel, idx) => (
                      <div key={`${rel.source_entity_id}-${rel.target_entity_id}-${rel.claim_id || idx}`} className="rounded-lg border border-border/70 bg-secondary/30 px-3 py-3 text-xs leading-5">
                        <p className="break-all">{rel.source_entity_id} → {rel.target_entity_id}</p>
                        <p className="mt-1 text-muted-foreground">Risk {Number.isFinite(rel.risk_score) ? rel.risk_score : "awaiting score"} · human review recommended</p>
                        {rel.claim_id ? <Link to={`/claims/${encodeURIComponent(rel.claim_id)}`} className="mt-2 inline-flex font-semibold text-primary hover:underline">Open claim {rel.claim_id}</Link> : null}
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            ) : (
              <p className="rounded-2xl border border-dashed border-border p-6 text-sm text-muted-foreground">Select a node to inspect connected entities.</p>
            )}
          </div>
        </SectionCard>
      </div>
    </PageFrame>
  );
}
