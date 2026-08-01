import React, { useMemo } from "react";
import ReactFlow, { Background, Controls, MarkerType, MiniMap } from "reactflow";
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
    return entities.map((entity, idx) => {
      const isProvider = entity.entity_type === "provider";
      const selected = selectedNodeId === entity.entity_id;
      return {
        id: entity.entity_id,
        position: { x: (idx % 6) * 210, y: Math.floor(idx / 6) * 140 },
        data: {
          label: (
            <div className="max-w-[170px] text-left">
              <p className="text-[10px] font-semibold uppercase tracking-[0.12em] opacity-70">{isProvider ? "Provider" : "Member"}</p>
              <p className="mt-1 break-all text-xs font-semibold">{entity.value || entity.entity_id}</p>
              <p className="mt-1 text-[10px] opacity-70">{entity.claim_count || 0} claim links · max risk {Number.isFinite(entity.max_risk_score) ? entity.max_risk_score : "—"}</p>
            </div>
          ),
        },
        type: "default",
        style: {
          background: isProvider ? "#0f2942" : "#e8f7f6",
          borderColor: selected ? "#06b6d4" : isProvider ? "#1e557a" : "#83d4cf",
          borderWidth: selected ? 3 : 1,
          color: isProvider ? "#f8fafc" : "#12343b",
          minWidth: 190,
          boxShadow: selected ? "0 0 0 4px rgba(6,182,212,0.16)" : "0 8px 22px rgba(15,41,66,0.08)",
        },
      };
    });
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

    const aggregated = new Map();
    relationships.forEach((rel) => {
      const key = `${rel.source_entity_id}\u0000${rel.target_entity_id}`;
      const current = aggregated.get(key) || {
        ...rel,
        claimCount: 0,
        maxRiskScore: null,
      };
      current.claimCount += 1;
      if (Number.isFinite(rel.risk_score)) {
        current.maxRiskScore = current.maxRiskScore === null
          ? rel.risk_score
          : Math.max(current.maxRiskScore, rel.risk_score);
      }
      current.review_recommended = current.review_recommended || rel.review_recommended === true;
      aggregated.set(key, current);
    });

    return Array.from(aggregated.values()).map((rel, idx) => {
      const highlighted = selectedNodeId && (rel.source_entity_id === selectedNodeId || rel.target_entity_id === selectedNodeId || connected.has(rel.source_entity_id) || connected.has(rel.target_entity_id));
      const riskStroke = rel.review_recommended || (rel.maxRiskScore ?? 0) >= 75
        ? "#e11d48"
        : (rel.maxRiskScore ?? 0) >= 40
          ? "#d97706"
          : "#94a3b8";
      return {
        id: edgeId(rel, idx),
        source: rel.source_entity_id,
        target: rel.target_entity_id,
        animated: Boolean(highlighted),
        label: rel.claimCount > 1 ? `${rel.claimCount} claims` : undefined,
        markerEnd: { type: MarkerType.ArrowClosed, color: highlighted ? "#0891b2" : riskStroke },
        style: {
          stroke: highlighted ? "#0891b2" : riskStroke,
          strokeWidth: highlighted ? 3 : rel.review_recommended ? 2.5 : 1.5,
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
          <Badge variant="outline" className="rounded-full px-2.5 py-1 text-[11px] font-semibold">Members</Badge>
          <Badge variant="outline" className="rounded-full px-2.5 py-1 text-[11px] font-semibold">Providers</Badge>
          <Badge variant="outline" className="rounded-full border-rose-300 px-2.5 py-1 text-[11px] font-semibold text-rose-700">Review signals</Badge>
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
