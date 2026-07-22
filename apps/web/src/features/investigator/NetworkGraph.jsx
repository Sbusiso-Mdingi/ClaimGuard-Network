import React, { useMemo } from "react";
import ReactFlow, { Background, Controls, MiniMap } from "reactflow";
import "reactflow/dist/style.css";
import { Badge } from "../../components/ui/badge";

function edgeId(rel, index) {
  return `${rel.source_entity_id}-${rel.target_entity_id}-${rel.claim_id || index}`;
}

export function NetworkGraph({ 
  graph, 
  height = "620px", 
  className = "",
  compact = false,
  showControls = true,
  showMiniMap = true,
  selectedNodeId = null,
  onNodeSelect = undefined
}) {
  const nodes = useMemo(() => {
    const entities = graph?.nodes || [];
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

  const edges = useMemo(() => {
    const relationships = graph?.edges || [];
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

  if ((graph?.nodes || []).length === 0) {
    return (
      <p className="rounded-2xl border border-dashed border-border p-8 text-sm text-muted-foreground">
        No graph entities found in current snapshot.
      </p>
    );
  }

  return (
    <div className={`relative overflow-hidden rounded-2xl border border-border/70 bg-background/70 ${className}`} style={{ height }} data-testid="network-graph">
      {!compact && (
        <div className="absolute left-4 top-4 z-10 flex flex-wrap items-center gap-2 rounded-xl border border-border/70 bg-card px-3 py-2">
          <Badge variant="outline" className="rounded-full px-2.5 py-1 text-[11px] font-semibold">Claims</Badge>
          <Badge variant="outline" className="rounded-full px-2.5 py-1 text-[11px] font-semibold">Providers</Badge>
          <Badge variant="outline" className="rounded-full px-2.5 py-1 text-[11px] font-semibold">Bank links</Badge>
        </div>
      )}
      <ReactFlow
        nodes={nodes}
        edges={edges}
        fitView
        onNodeClick={onNodeSelect ? (_, node) => onNodeSelect(node.id) : undefined}
        proOptions={{ hideAttribution: true }}
      >
        {showMiniMap && !compact && <MiniMap />}
        {showControls && <Controls showInteractive={!compact} />}
        <Background gap={24} size={1} />
      </ReactFlow>
    </div>
  );
}
