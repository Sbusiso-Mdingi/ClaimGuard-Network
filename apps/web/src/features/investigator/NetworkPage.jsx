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
      truncated: graph?.summary?.truncated === true,
    };
  }, [graph, selectedDetails]);

  return (
    <PageFrame
      eyebrow="Network Intelligence"
      title="Scheme relationship network"
      description="Trace real member-to-provider claim links, identify repeated connections, and open the claims behind elevated-risk relationships."
      actions={[
        <MetricPill key="entities" label="Entities" value={graphStats.entities} />,
        <MetricPill key="relationships" label="Relationships" value={graphStats.relationships} />,
        <MetricPill key="providers" label="Providers" value={graphStats.providers} />,
        <MetricPill key="members" label="Members" value={graphStats.members} />,
      ]}
    >
      {graphStats.entities === 0 ? (
        <WorkspaceNotice title="No network data available" tone="warning">
          Entity-relationship data has not been returned in this snapshot yet.
        </WorkspaceNotice>
      ) : null}
      {graphStats.truncated ? (
        <WorkspaceNotice title="Showing the highest-priority 500 claim relationships" tone="warning">
          The scheme contains more graphable claims than the interactive view can safely render at once. Counts remain scheme-wide; the graph prioritises higher-risk and newer links.
        </WorkspaceNotice>
      ) : null}

      <SummaryRail
        ariaLabel="Network summary"
        items={[
          {
            key: "entities",
            label: "Entities",
            value: graphStats.entities,
            description: "Nodes in current projection",
            icon: Users,
          },
          {
            key: "relationships",
            label: "Relationships",
            value: graphStats.relationships,
            description: "Links between entities",
            icon: Network,
          },
          {
            key: "review-signals",
            label: "Review signals",
            value: graphStats.reviewSignals,
            description: "Relationships with model review recommendations",
            icon: ShieldAlert,
            iconClassName: graphStats.reviewSignals > 0 ? "text-rose-500" : "text-muted-foreground",
          },
          {
            key: "selected",
            label: "Selected links",
            value: graphStats.selectedLinks,
            description: "Connections tied to selected node",
            icon: Radar,
            iconClassName: selectedNodeId ? "text-primary" : "text-muted-foreground",
          },
        ]}
      />

      <div className="grid gap-4 xl:grid-cols-[1.65fr_0.95fr]">
        <SectionCard
          variant="console"
          title="Network graph"
          description="Zoom, pan, and select a member or provider. Red links contain a model review recommendation; amber links carry a medium-or-higher score."
          actions={[
            <StatusIndicator key="selected" variant="badge">{selectedNodeId ? "Node selected" : "No node selected"}</StatusIndicator>,
          ]}
        >
          {graphStats.entities === 0 ? (
            <EmptyState compact icon={Network} title="Graph unavailable" description="No graph entities are available for rendering in this view." />
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
          description="Selected node context, relationship count, and local cluster metadata."
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
                        <p className="mt-1 text-muted-foreground">Risk {Number.isFinite(rel.risk_score) ? rel.risk_score : "awaiting score"} · {rel.review_recommended ? "review recommended" : "no review signal"}</p>
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
