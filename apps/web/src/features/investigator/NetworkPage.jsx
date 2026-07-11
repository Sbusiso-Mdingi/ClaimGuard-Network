import React, { useMemo, useState } from "react";
import ReactFlow, { Background, Controls, MiniMap } from "reactflow";
import "reactflow/dist/style.css";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../../components/ui/card";

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

  const selectedDetails = useMemo(() => {
    if (!selectedNodeId) return null;
    const entity = (graph?.entities || []).find((item) => item.entity_id === selectedNodeId) || null;
    const links = (graph?.relationships || []).filter((rel) => rel.source_entity_id === selectedNodeId || rel.target_entity_id === selectedNodeId);
    return { entity, links };
  }, [graph, selectedNodeId]);

  return (
    <div className="grid gap-4 xl:grid-cols-[2fr_1fr]">
      <Card>
        <CardHeader>
          <CardTitle>Network Graph</CardTitle>
          <CardDescription>Zoom, pan, select nodes, and highlight connected entities.</CardDescription>
        </CardHeader>
        <CardContent>
          {(graph?.entities || []).length === 0 ? (
            <p className="rounded-md border border-dashed border-border p-6 text-sm text-muted-foreground">No graph entities found in current snapshot.</p>
          ) : (
            <div className="h-[560px] rounded-md border border-border" data-testid="network-graph">
              <ReactFlow
                nodes={nodes}
                edges={edges}
                fitView
                onNodeClick={(_, node) => setSelectedNodeId(node.id)}
                proOptions={{ hideAttribution: true }}
              >
                <MiniMap />
                <Controls />
                <Background />
              </ReactFlow>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Node Details</CardTitle>
          <CardDescription>Selected node and immediate relationship context.</CardDescription>
        </CardHeader>
        <CardContent>
          {!selectedDetails ? (
            <p className="text-sm text-muted-foreground">Select a node to inspect connected entities.</p>
          ) : (
            <div className="space-y-3 text-sm">
              <div>
                <p className="font-semibold">{selectedDetails.entity?.entity_id}</p>
                <p className="text-xs text-muted-foreground">{selectedDetails.entity?.entity_type}</p>
              </div>
              <div>
                <p className="mb-1 text-xs uppercase text-muted-foreground">Connected relationships</p>
                <div className="space-y-1">
                  {selectedDetails.links.map((rel, idx) => (
                    <div key={`${rel.source_entity_id}-${rel.target_entity_id}-${idx}`} className="rounded border border-border p-2 text-xs">
                      {rel.source_entity_id} → {rel.target_entity_id}
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
