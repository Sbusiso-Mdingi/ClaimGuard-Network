from __future__ import annotations

from collections import Counter, defaultdict
from dataclasses import dataclass
import json
import urllib.request
from typing import Callable


@dataclass(frozen=True)
class RuleHit:
    rule_id: str
    title: str
    weight: int
    evidence: list[str]


@dataclass(frozen=True)
class GraphForRules:
    entities: list[dict[str, object]]
    relationships: list[dict[str, object]]
    claim_counts: dict[str, int]


RuleFn = Callable[[GraphForRules], list[RuleHit]]


def _entity_lookup(graph: GraphForRules) -> dict[str, dict[str, object]]:
    return {str(entity["entity_id"]): entity for entity in graph.entities}


def _artifact_sharing_hits(graph: GraphForRules, entity_type: str, rule_id: str, title: str, weight: int) -> list[RuleHit]:
    entity_by_id = _entity_lookup(graph)
    artifact_to_claimants: dict[str, set[str]] = defaultdict(set)

    for rel in graph.relationships:
        if rel.get("relationship_type") != "observed_with":
            continue
        source = str(rel.get("source_entity_id"))
        target = str(rel.get("target_entity_id"))
        target_entity = entity_by_id.get(target)
        if not target_entity or target_entity.get("entity_type") != entity_type:
            continue
        artifact_to_claimants[target].add(source)

    hits: list[RuleHit] = []
    for artifact_id in sorted(artifact_to_claimants):
        claimants = sorted(artifact_to_claimants[artifact_id])
        if len(claimants) < 2:
            continue
        hits.append(
            RuleHit(
                rule_id=rule_id,
                title=title,
                weight=weight,
                evidence=[f"{artifact_id} linked to {', '.join(claimants[:5])}"],
            )
        )

    return hits


def rule_shared_devices(graph: GraphForRules) -> list[RuleHit]:
    return _artifact_sharing_hits(graph, "device", "shared_devices", "Shared devices detected", 10)


def rule_shared_addresses(graph: GraphForRules) -> list[RuleHit]:
    return _artifact_sharing_hits(graph, "address", "shared_addresses", "Shared addresses detected", 9)


def rule_reused_bank_accounts(graph: GraphForRules) -> list[RuleHit]:
    return _artifact_sharing_hits(graph, "bank_account", "reused_bank_accounts", "Reused bank accounts detected", 12)


def rule_reused_phone_numbers(graph: GraphForRules) -> list[RuleHit]:
    return _artifact_sharing_hits(graph, "phone", "reused_phone_numbers", "Reused phone numbers detected", 8)


def rule_reused_emails(graph: GraphForRules) -> list[RuleHit]:
    return _artifact_sharing_hits(graph, "email", "reused_emails", "Reused emails detected", 7)


def rule_repeat_offenders(graph: GraphForRules) -> list[RuleHit]:
    hits: list[RuleHit] = []
    for claimant_id in sorted(graph.claim_counts):
        count = graph.claim_counts[claimant_id]
        if count < 3:
            continue
        hits.append(
            RuleHit(
                rule_id="repeat_offenders",
                title="Repeat offenders detected",
                weight=8,
                evidence=[f"{claimant_id} appears in {count} claims"],
            )
        )
    return hits


def _claimant_projection(graph: GraphForRules) -> tuple[set[str], dict[str, set[str]]]:
    entity_by_id = _entity_lookup(graph)
    artifact_to_claimants: dict[str, set[str]] = defaultdict(set)
    claimants: set[str] = set()

    for rel in graph.relationships:
        if rel.get("relationship_type") != "observed_with":
            continue
        source = str(rel.get("source_entity_id"))
        target = str(rel.get("target_entity_id"))
        target_entity = entity_by_id.get(target)
        source_entity = entity_by_id.get(source)
        if not source_entity or source_entity.get("entity_type") != "claimant":
            continue
        if not target_entity or target_entity.get("entity_type") == "claimant":
            continue
        claimants.add(source)
        artifact_to_claimants[target].add(source)

    adjacency: dict[str, set[str]] = defaultdict(set)
    for linked_claimants in artifact_to_claimants.values():
        if len(linked_claimants) < 2:
            continue
        as_list = sorted(linked_claimants)
        for left in as_list:
            for right in as_list:
                if left == right:
                    continue
                adjacency[left].add(right)

    return claimants, adjacency


def rule_suspicious_relationship_chains(graph: GraphForRules) -> list[RuleHit]:
    claimants, adjacency = _claimant_projection(graph)
    visited: set[str] = set()
    hits: list[RuleHit] = []

    for root in sorted(claimants):
        if root in visited:
            continue
        queue = [root]
        component: list[str] = []
        visited.add(root)
        while queue:
            node = queue.pop(0)
            component.append(node)
            for nxt in sorted(adjacency.get(node, set())):
                if nxt in visited:
                    continue
                visited.add(nxt)
                queue.append(nxt)
        if len(component) >= 3:
            hits.append(
                RuleHit(
                    rule_id="suspicious_relationship_chains",
                    title="Suspicious relationship chains detected",
                    weight=9,
                    evidence=[f"connected claimant chain: {', '.join(component[:6])}"],
                )
            )

    return hits


def rule_unusually_connected_entities(graph: GraphForRules) -> list[RuleHit]:
    degree = Counter()
    for rel in graph.relationships:
        source = str(rel.get("source_entity_id"))
        target = str(rel.get("target_entity_id"))
        degree[source] += 1
        degree[target] += 1

    hits: list[RuleHit] = []
    for entity_id, count in sorted(degree.items()):
        if count < 4:
            continue
        hits.append(
            RuleHit(
                rule_id="unusually_connected_entities",
                title="Unusually connected entities detected",
                weight=8,
                evidence=[f"{entity_id} has graph degree {count}"],
            )
        )

    return hits


def rule_circular_relationships(graph: GraphForRules) -> list[RuleHit]:
    nodes: set[str] = set()
    adjacency: dict[str, set[str]] = defaultdict(set)
    edge_count = 0

    for rel in graph.relationships:
        left = str(rel.get("source_entity_id"))
        right = str(rel.get("target_entity_id"))
        nodes.add(left)
        nodes.add(right)
        adjacency[left].add(right)
        adjacency[right].add(left)
        edge_count += 1

    # In an undirected component, cycles exist when edges >= nodes in that component.
    visited: set[str] = set()
    hits: list[RuleHit] = []
    for root in sorted(nodes):
        if root in visited:
            continue
        queue = [root]
        component_nodes: set[str] = set()
        component_edges = 0
        while queue:
            node = queue.pop(0)
            if node in visited:
                continue
            visited.add(node)
            component_nodes.add(node)
            neighbors = adjacency.get(node, set())
            component_edges += len(neighbors)
            for nxt in sorted(neighbors):
                if nxt not in visited:
                    queue.append(nxt)
        undirected_edges = component_edges // 2
        if undirected_edges >= len(component_nodes) and len(component_nodes) >= 3:
            hits.append(
                RuleHit(
                    rule_id="circular_relationships",
                    title="Circular relationships detected",
                    weight=10,
                    evidence=[
                        f"component with {len(component_nodes)} nodes and {undirected_edges} edges forms a cycle"
                    ],
                )
            )

    return hits


DEFAULT_RULES: list[RuleFn] = [
    rule_shared_devices,
    rule_shared_addresses,
    rule_reused_bank_accounts,
    rule_reused_phone_numbers,
    rule_reused_emails,
    rule_suspicious_relationship_chains,
    rule_unusually_connected_entities,
    rule_repeat_offenders,
    rule_circular_relationships,
]


class RuleEngine:
    def __init__(self, rules: list[RuleFn] | None = None) -> None:
        self._rules = rules or DEFAULT_RULES

    def evaluate(self, graph: GraphForRules, strategy: str = "deterministic_rules", ml_endpoint_url: str | None = None) -> list[RuleHit]:
        if strategy == "ml_endpoint":
            if not ml_endpoint_url:
                raise ValueError("ml_endpoint_url must be provided when strategy is 'ml_endpoint'")
            
            payload = json.dumps({
                "entities": graph.entities,
                "relationships": graph.relationships,
                "claim_counts": graph.claim_counts,
            }).encode("utf-8")
            
            req = urllib.request.Request(
                ml_endpoint_url,
                data=payload,
                headers={"Content-Type": "application/json"},
                method="POST"
            )
            
            try:
                with urllib.request.urlopen(req, timeout=30) as response:
                    data = json.loads(response.read().decode("utf-8"))
                    hits = []
                    for h in data.get("hits", []):
                        hits.append(RuleHit(
                            rule_id=str(h.get("rule_id", "")),
                            title=str(h.get("title", "")),
                            weight=int(h.get("weight", 0)),
                            evidence=list(h.get("evidence", [])),
                        ))
                    return sorted(hits, key=lambda hit: (hit.rule_id, hit.evidence[0] if hit.evidence else ""))
            except Exception as e:
                raise RuntimeError(f"ML endpoint failed: {e}") from e

        hits: list[RuleHit] = []
        for rule in self._rules:
            hits.extend(rule(graph))

        # Deterministic ordering for reproducible outputs.
        return sorted(hits, key=lambda hit: (hit.rule_id, hit.evidence[0] if hit.evidence else ""))
