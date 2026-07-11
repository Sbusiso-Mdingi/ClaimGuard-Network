from __future__ import annotations

from dataclasses import dataclass, field


@dataclass
class GraphDocument:
    entities: list[dict[str, object]] = field(default_factory=list)
    relationships: list[dict[str, object]] = field(default_factory=list)
    summary: dict[str, object] = field(default_factory=dict)


class GraphStore:
    """Abstraction layer so detection logic is not coupled to a concrete graph backend."""

    def write(self, graph: GraphDocument) -> None:  # pragma: no cover - interface
        raise NotImplementedError

    def read(self) -> GraphDocument:  # pragma: no cover - interface
        raise NotImplementedError


class InMemoryGraphStore(GraphStore):
    def __init__(self) -> None:
        self._graph = GraphDocument()

    def write(self, graph: GraphDocument) -> None:
        self._graph = graph

    def read(self) -> GraphDocument:
        return self._graph


class GremlinGraphStore(GraphStore):
    """Placeholder adapter for Cosmos DB Gremlin API integration."""

    def __init__(self, endpoint: str, database: str, graph: str) -> None:
        self.endpoint = endpoint
        self.database = database
        self.graph = graph
        self._last_graph = GraphDocument()

    def write(self, graph: GraphDocument) -> None:
        # The concrete Gremlin client/writes can be added without changing detection logic.
        self._last_graph = graph

    def read(self) -> GraphDocument:
        return self._last_graph
