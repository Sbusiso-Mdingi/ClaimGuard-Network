from __future__ import annotations

import json
from typing import Callable, Any

class PyMySqlDetectionResultsRepository:
    """Stores and retrieves immutable detection results for claims."""

    def __init__(self, connection_factory: Callable[[], Any], allowed_tenant_ids: frozenset[str] | None = None) -> None:
        self.connection_factory = connection_factory
        self.allowed_tenant_ids = allowed_tenant_ids

    def _verify_tenant(self, tenant_id: str) -> str:
        canonical = str(tenant_id or "").strip()
        if not canonical:
            raise ValueError("tenant_id is required.")
        if self.allowed_tenant_ids is not None and canonical not in self.allowed_tenant_ids:
            raise ValueError("Tenant is outside the verified worker data-plane scope.")
        return canonical

    def save_results(self, tenant_id: str, results: list[dict[str, Any]]) -> None:
        if not results:
            return
        canonical_tenant_id = self._verify_tenant(tenant_id)
        connection = self.connection_factory()
        try:
            with connection.cursor() as cursor:
                for result in results:
                    payload = result["result_payload"]
                    cursor.execute(
                        """
                        INSERT INTO claim_detection_results (
                            tenant_id, claim_id, claim_version, detection_strategy_id,
                            strategy_type, model_deployment_id, scored_at, result_payload
                        ) VALUES (%s, %s, %s, %s, %s, %s, UTC_TIMESTAMP(3), %s)
                        ON DUPLICATE KEY UPDATE
                            detection_strategy_id = VALUES(detection_strategy_id),
                            strategy_type = VALUES(strategy_type),
                            model_deployment_id = VALUES(model_deployment_id),
                            scored_at = VALUES(scored_at),
                            result_payload = VALUES(result_payload)
                        """,
                        [
                            canonical_tenant_id,
                            result["claim_id"],
                            result["claim_version"],
                            result["detection_strategy_id"],
                            result["strategy_type"],
                            result.get("model_deployment_id"),
                            json.dumps(payload) if not isinstance(payload, str) else payload,
                        ]
                    )
            connection.commit()
        except Exception:
            connection.rollback()
            raise
        finally:
            connection.close()

    def results_exist(self, tenant_id: str, claim_id: str, claim_version: int) -> bool:
        canonical_tenant_id = self._verify_tenant(tenant_id)
        connection = self.connection_factory()
        try:
            with connection.cursor() as cursor:
                cursor.execute(
                    """
                    SELECT 1 FROM claim_detection_results
                    WHERE tenant_id = %s AND claim_id = %s AND claim_version = %s
                    LIMIT 1
                    """,
                    [canonical_tenant_id, claim_id, claim_version]
                )
                return cursor.fetchone() is not None
        finally:
            connection.close()

    def load_results_for_report(self, tenant_id: str, claim_ids: list[str]) -> list[dict[str, Any]]:
        if not claim_ids:
            return []
        canonical_tenant_id = self._verify_tenant(tenant_id)
        connection = self.connection_factory()
        try:
            with connection.cursor() as cursor:
                format_strings = ','.join(['%s'] * len(claim_ids))
                query = f"""
                    SELECT claim_id, claim_version, detection_strategy_id, strategy_type,
                           model_deployment_id, scored_at, result_payload
                    FROM claim_detection_results
                    WHERE tenant_id = %s AND claim_id IN ({format_strings})
                """
                cursor.execute(query, [canonical_tenant_id, *claim_ids])
                rows = cursor.fetchall()
                results = []
                for row in rows:
                    payload = row["result_payload"]
                    results.append({
                        "claim_id": row["claim_id"],
                        "claim_version": row["claim_version"],
                        "detection_strategy_id": row["detection_strategy_id"],
                        "strategy_type": row["strategy_type"],
                        "model_deployment_id": row["model_deployment_id"],
                        "scored_at": row["scored_at"],
                        "result_payload": json.loads(payload) if isinstance(payload, str) else payload
                    })
                return results
        finally:
            connection.close()
