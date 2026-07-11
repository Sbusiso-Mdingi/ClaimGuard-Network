import React, { useRef, useEffect, useMemo, useState } from "react";
import DetailPanel from "./DetailPanel";

function buildGraphFromReport(report, filteredFindings) {
  const nodes = new Map();
  const links = [];

  for (const scheme of report.schemes || []) {
    const id = `scheme:${scheme.scheme_id}`;
    nodes.set(id, { id, type: "scheme", label: scheme.scheme_id, scheme_id: scheme.scheme_id });
  }

  for (const f of filteredFindings || []) {
    const schemeKey = `scheme:${f._scheme_id}`;
    const providerKey = f.provider_id ? `provider:${f.provider_id}:${f._scheme_id}` : null;
    const entityKey = f.entity_id ? `entity:${f.entity_id}:${f._scheme_id}` : (f.member_id ? `entity:${f.member_id}:${f._scheme_id}` : null);
    const findingKey = f.detection_id ? `finding:${f.detection_id}` : `finding:${Math.random().toString(36).slice(2)}`;

    if (providerKey && !nodes.has(providerKey)) nodes.set(providerKey, { id: providerKey, type: "provider", label: f.provider_id, provider_id: f.provider_id, scheme_id: f._scheme_id });
    if (entityKey && !nodes.has(entityKey)) nodes.set(entityKey, { id: entityKey, type: "entity", label: f.entity_id || f.member_id, entity_id: f.entity_id || f.member_id, scheme_id: f._scheme_id });
    if (!nodes.has(findingKey)) nodes.set(findingKey, { id: findingKey, type: "finding", label: f.detection_id || "finding", detection_id: f.detection_id, score: f.score, scheme_id: f._scheme_id });

    if (schemeKey && providerKey) links.push({ source: schemeKey, target: providerKey, type: "scheme-provider" });
    if (providerKey && entityKey) links.push({ source: providerKey, target: entityKey, type: "provider-entity" });
    if (entityKey) links.push({ source: entityKey, target: findingKey, type: "entity-finding" });
    if (providerKey) links.push({ source: providerKey, target: findingKey, type: "provider-finding" });
  }

  return { nodes: Array.from(nodes.values()), links };
}

function usePanZoom(containerRef) {
  const [transform, setTransform] = useState({ x: 0, y: 0, k: 1 });
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    let isPanning = false;
    let start = null;

    function onWheel(e) {
      e.preventDefault();
      const delta = e.deltaY > 0 ? 0.9 : 1.1;
      setTransform((t) => ({ ...t, k: Math.max(0.2, Math.min(4, t.k * delta)) }));
    }

    function onDown(e) {
      isPanning = true;
      start = { x: e.clientX, y: e.clientY };
      el.style.cursor = 'grabbing';
    }

    function onMove(e) {
      if (!isPanning || !start) return;
      const dx = e.clientX - start.x;
      const dy = e.clientY - start.y;
      start = { x: e.clientX, y: e.clientY };
      setTransform((t) => ({ ...t, x: t.x + dx, y: t.y + dy }));
    }

    function onUp() {
      isPanning = false;
      el.style.cursor = 'default';
    }

    el.addEventListener('wheel', onWheel, { passive: false });
    el.addEventListener('mousedown', onDown);
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);

    return () => {
      el.removeEventListener('wheel', onWheel);
      el.removeEventListener('mousedown', onDown);
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, [containerRef]);

  return [transform, setTransform];
}

export default function NetworkGraph({ report, filteredFindings, filters, onNavigate }) {
  const containerRef = useRef(null);
  const [selected, setSelected] = useState(null);
  const [hovered, setHovered] = useState(null);

  const graph = useMemo(() => buildGraphFromReport(report || { schemes: [] }, filteredFindings || []), [report, filteredFindings]);

  // simple deterministic layout: columns by type and bucket by scheme/provider
  const layout = useMemo(() => {
    const cols = { scheme: 0, provider: 1, entity: 2, finding: 3 };
    const buckets = {};
    for (const n of graph.nodes) {
      const col = cols[n.type] ?? 3;
      const key = `${col}:${n.scheme_id || 'global'}`;
      buckets[key] = buckets[key] || [];
      buckets[key].push(n);
    }

    const nodesWithPos = graph.nodes.map((n) => ({ ...n }));

    const width = containerRef.current ? containerRef.current.clientWidth : 800;
    const height = 500;
    const colWidth = Math.max(160, Math.floor(width / 5));

    Object.keys(buckets).forEach((k) => {
      const [colStr, schemeId] = k.split(":");
      const col = parseInt(colStr, 10);
      const list = buckets[k];
      const x = 40 + col * colWidth;
      for (let i = 0; i < list.length; i++) {
        const n = list[i];
        const y = 40 + (i * (height - 80)) / Math.max(1, list.length - 1);
        const target = nodesWithPos.find((m) => m.id === n.id);
        if (target) {
          target.x = x + (Math.random() - 0.5) * 20;
          target.y = y + (Math.random() - 0.5) * 10;
        }
      }
    });

    return { nodes: nodesWithPos, links: graph.links };
  }, [graph, containerRef.current]);

  const [transform] = usePanZoom(containerRef);

  const counts = useMemo(() => {
    const c = { scheme: 0, provider: 0, entity: 0, finding: 0 };
    for (const n of graph.nodes) c[n.type] = (c[n.type] || 0) + 1;
    return c;
  }, [graph.nodes]);

  function handleNodeClick(n) {
    setSelected(n);
    if (onNavigate) {
      if (n.type === 'scheme') onNavigate({ type: 'scheme', schemeId: n.scheme_id });
      if (n.type === 'provider') onNavigate({ type: 'provider', schemeId: n.scheme_id, providerId: n.provider_id });
      if (n.type === 'entity') onNavigate({ type: 'entity', schemeId: n.scheme_id, providerId: null, entityId: n.entity_id });
      if (n.type === 'finding') onNavigate({ type: 'finding', schemeId: n.scheme_id, detectionId: n.detection_id });
    }
  }

  return (
    <div className="panel network-graph" style={{ display: 'flex', gap: 12 }}>
      <div style={{ flex: 1, overflow: 'hidden' }} ref={containerRef}>
        <svg width="100%" height={500} style={{ background: '#fafafa' }}>
          <g transform={`translate(${transform.x},${transform.y}) scale(${transform.k})`}>
            {/* links */}
            {layout.links.map((l, i) => {
              const s = layout.nodes.find((n) => n.id === l.source) || layout.nodes.find((n) => n.id === (l.source.id || l.source));
              const t = layout.nodes.find((n) => n.id === l.target) || layout.nodes.find((n) => n.id === (l.target.id || l.target));
              if (!s || !t) return null;
              return <line key={i} x1={s.x} y1={s.y} x2={t.x} y2={t.y} stroke="#bbb" strokeWidth={1} />;
            })}

            {/* nodes */}
            {layout.nodes.map((n) => {
              const fill = n.type === 'scheme' ? '#1f77b4' : n.type === 'provider' ? '#ff7f0e' : n.type === 'entity' ? '#2ca02c' : '#d62728';
              const r = n.type === 'finding' ? 4 : n.type === 'entity' ? 7 : n.type === 'provider' ? 9 : 12;
              return (
                <g key={n.id} transform={`translate(${n.x},${n.y})`} onMouseEnter={() => setHovered(n)} onMouseLeave={() => setHovered(null)} onClick={() => handleNodeClick(n)} style={{ cursor: 'pointer' }}>
                  <circle r={r} fill={fill} stroke={selected && selected.id === n.id ? '#000' : '#222'} strokeWidth={selected && selected.id === n.id ? 1.5 : 0.5} />
                  <text x={r + 6} y={4} fontSize={10}>{n.label}</text>
                </g>
              );
            })}
          </g>
        </svg>
      </div>

      <div style={{ width: 320 }}>
        <DetailPanel title="Graph Legend" meta={`${counts.scheme} schemes`}>
          <ul>
            <li>Scheme: blue ({counts.scheme})</li>
            <li>Provider: orange ({counts.provider})</li>
            <li>Entity: green ({counts.entity})</li>
            <li>Finding: red ({counts.finding})</li>
          </ul>
        </DetailPanel>

        {selected && (
          <DetailPanel title={`Selected: ${selected.label || selected.id}`} meta={selected.type}>
            <pre style={{ whiteSpace: 'pre-wrap' }}>{JSON.stringify(selected, null, 2)}</pre>
            <div style={{ marginTop: 8 }}>
              {selected.type === 'scheme' && <button onClick={() => onNavigate && onNavigate({ type: 'scheme', schemeId: selected.scheme_id })}>Open scheme</button>}
              {selected.type === 'provider' && <button onClick={() => onNavigate && onNavigate({ type: 'provider', schemeId: selected.scheme_id, providerId: selected.provider_id })}>Open provider</button>}
              {selected.type === 'entity' && <button onClick={() => onNavigate && onNavigate({ type: 'entity', schemeId: selected.scheme_id, providerId: null, entityId: selected.entity_id })}>Open entity</button>}
              {selected.type === 'finding' && <button onClick={() => onNavigate && onNavigate({ type: 'finding', schemeId: selected.scheme_id, detectionId: selected.detection_id })}>Open finding</button>}
            </div>
          </DetailPanel>
        )}
      </div>
    </div>
  );
}
