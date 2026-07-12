import React, { useMemo, useState } from "react";
import ReactFlow, { Background, Controls, MiniMap } from "reactflow";
import "reactflow/dist/style.css";
import { Badge } from "../../components/ui/badge";
import { PageFrame, SectionCard, MetricPill, StatusBadge } from "./InvestigatorUI";

function edgeId(rel, index) {
  return `${rel.source_entity_id}-${rel.target_entity_id}-${rel.claim_id || index}`;
}

export function NetworkPage({ graph }) {
  const [selectedNodeId, setSelectedNodeId] = useState(null);

  const nodes = useMemo(() => {
    const entities = graph?.entities || [];
    return entities.map((entity, idx) => ({
      id: entity.entity_id,
      position: { x: (idx % 8) * 180, y: Math.floor(idx / 8) * 120 },
      data: { label: entity.entity_id },
      type: "default",
      style: {
        borderColor: selectedNodeId === entity.entity_id ? "#0ea5e9" : undefined,
        borderWidth: selectedNodeId === entity.entity_id ? 2 : 1,
      },
    }));
  }, [graph, selectedNodeId]);

  const selectedDetails = useMemo(() => {
    if (!selectedNodeId) return null;
    const entity = (graph?.entities || []).find((item) => item.entity_id === selectedNodeId) || null;
    const links = (graph?.relationships || []).filter((rel) => rel.source_entity_id === selectedNodeId || rel.target_entity_id === selectedNodeId);
    return { entity, links };
  }, [graph, selectedNodeId]);

  const graphStats = useMemo(() => {
    const entities = graph?.entities || [];
    const relationships = graph?.relationships || [];
    return {
      entities: entities.length,
      relationships: relationships.length,
      selectedLinks: selectedDetails?.links?.length || 0,
      providers: entities.filter((entity) => entity.entity_type === "provider").length,
    };
  }, [graph, selectedDetails]);

  const edges = useMemo(() => {
    const relationships = graph?.relationships || [];
    const connected = new Set();
    if (selectedNodeId) {
      relationships.forEach((rel) => {
        if (rel.source_entity_id === selectedNodeId) connected.add(rel.target_entity_id);
        if (rel.target_entity_id === selectedNodeId) connected.add(rel.source_entity_id);
      });
    }

    return relationships.map((rel, idx) => {
      const highlighted = selectedNodeId && (rel.source_entity_id === selectedNodeId || rel.target_entity_id === selectedNodeId || connected.has(rel.source_entity_id) || connected.has(rel.target_entity_id));
      return {
        id: edgeId(rel, idx),
        source: rel.source_entity_id,
        target: rel.target_entity_id,
        animated: Boolean(highlighted),
        style: {
          stroke: highlighted ? "#0ea5e9" : "#94a3b8",
          strokeWidth: highlighted ? 2 : 1,
        },
      };
    });
  }, [graph, selectedNodeId]);

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
            <StatusBadge key="selected" variant="outline">{selectedNodeId ? "Node selected" : "No node selected"}</StatusBadge>,
          ]}
        >
          {(graph?.entities || []).length === 0 ? (
            <p className="rounded-2xl border border-dashed border-border p-8 text-sm text-muted-foreground">No graph entities found in current snapshot.</p>
          ) : (
            <div className="relative h-[620px] overflow-hidden rounded-2xl border border-border/70 bg-background/70" data-testid="network-graph">
              <div className="absolute left-4 top-4 z-10 flex flex-wrap items-center gap-2 rounded-xl border border-border/70 bg-card/90 px-3 py-2 shadow-sm backdrop-blur">
                <Badge variant="outline" className="rounded-full px-2.5 py-1 text-[11px] font-semibold">Claims</Badge>
                <Badge variant="outline" className="rounded-full px-2.5 py-1 text-[11px] font-semibold">Providers</Badge>
                <Badge variant="outline" className="rounded-full px-2.5 py-1 text-[11px] font-semibold">Bank links</Badge>
              </div>
              <ReactFlow
                nodes={nodes}
                edges={edges}
                fitView
                onNodeClick={(_, node) => setSelectedNodeId(node.id)}
                proOptions={{ hideAttribution: true }}
              >
                <MiniMap />
                <Controls />
                <Background gap={24} size={1} />
              </ReactFlow>
            </div>
          )}
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
