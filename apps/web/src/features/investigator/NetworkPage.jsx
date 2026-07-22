import React, { useMemo, useState } from "react";
import { Badge } from "../../components/ui/badge";
import { PageFrame, SectionCard, MetricPill, StatusIndicator } from "./InvestigatorUI";
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
    };
  }, [graph, selectedDetails]);

  return (
    <PageFrame
      eyebrow="Network Graph"
      title="Relationship intelligence"
      description="Inspect entity connections, trace high-risk clusters, and review the graph with supporting statistics."
      actions={[
        <MetricPill key="entities" label="Entities" value={graphStats.entities} />,
        <MetricPill key="relationships" label="Relationships" value={graphStats.relationships} />,
        <MetricPill key="providers" label="Providers" value={graphStats.providers} />,
      ]}
    >
      <div className="grid gap-4 xl:grid-cols-[1.65fr_0.95fr]">
        <SectionCard
          title="Network graph"
          description="Zoom, pan, and select nodes. High-risk relationships are emphasized when a node is selected."
          actions={[
            <StatusIndicator key="selected" variant="badge">{selectedNodeId ? "Node selected" : "No node selected"}</StatusIndicator>,
          ]}
        >
          <NetworkGraph 
            graph={graph} 
            selectedNodeId={selectedNodeId} 
            onNodeSelect={setSelectedNodeId} 
          />
        </SectionCard>

        <SectionCard
          title="Graph details"
          description="Selected node context, relationship count, and local cluster metadata."
        >
          <div className="space-y-4">
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
                  <p className="mt-1 text-lg font-semibold">{selectedDetails.entity?.entity_id}</p>
                  <p className="text-sm text-muted-foreground">{selectedDetails.entity?.entity_type}</p>
                </div>

                <div className="rounded-2xl border border-border/70 p-4">
                  <p className="text-xs uppercase tracking-[0.16em] text-muted-foreground">Connected relationships</p>
                  <div className="mt-3 space-y-2">
                    {selectedDetails.links.map((rel, idx) => (
                      <div key={`${rel.source_entity_id}-${rel.target_entity_id}-${idx}`} className="rounded-lg border border-border/70 bg-secondary/30 px-3 py-3 text-xs leading-5">
                        {rel.source_entity_id} → {rel.target_entity_id}
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
