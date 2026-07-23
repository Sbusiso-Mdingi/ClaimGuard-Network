from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, date, datetime
import hashlib
import json
from typing import Callable


def _iso_timestamp(value: object) -> str:
    if isinstance(value, datetime):
        resolved = value if value.tzinfo else value.replace(tzinfo=UTC)
        return resolved.astimezone(UTC).isoformat()
    if isinstance(value, date):
        return f"{value.isoformat()}T00:00:00+00:00"
    rendered = str(value or "").strip()
    if not rendered:
        raise ValueError("Snapshot timestamp is unavailable.")
    return rendered.replace(" ", "T") + ("+00:00" if "+" not in rendered and not rendered.endswith("Z") else "")


@dataclass(frozen=True)
class TenantSnapshot:
    tenant_id: str
    tenant_slug: str | None
    tenant_display_name: str | None
    detection_strategy: str
    model_deployment_id: str | None
    captured_at: str
    watermark: str
    schemes: list[dict[str, object]]
    members: list[dict[str, object]]
    providers: list[dict[str, object]]
    claims: list[dict[str, object]]


class PyMySqlTenantSnapshotRepository:
    """Exports one tenant corpus from a short repeatable-read transaction."""

    def __init__(self, connection_factory: Callable[[], object], allowed_tenant_ids: frozenset[str] | None = None) -> None:
        self.connection_factory = connection_factory
        self.allowed_tenant_ids = allowed_tenant_ids

    def load_tenant_snapshot(self, *, tenant_id: str) -> TenantSnapshot:
        canonical_tenant_id = str(tenant_id or "").strip()
        if not canonical_tenant_id:
            raise ValueError("tenant_id is required for a tenant snapshot.")
        if self.allowed_tenant_ids is not None and canonical_tenant_id not in self.allowed_tenant_ids:
            raise ValueError("Snapshot tenant is outside the verified worker data-plane scope.")

        connection = self.connection_factory()
        try:
            with connection.cursor() as cursor:
                cursor.execute("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ")
            connection.begin()
            with connection.cursor() as cursor:
                cursor.execute(
                    """
                    SELECT t.tenant_id, t.tenant_slug, t.tenant_name, UTC_TIMESTAMP(3) AS captured_at,
                           ds.strategy_type, ds.model_deployment_id
                    FROM tenants t
                    LEFT JOIN detection_strategies ds ON ds.tenant_id = t.tenant_id AND ds.is_active = 1
                    WHERE t.tenant_id = %s AND t.status = 'active'
                    LIMIT 1
                    """,
                    [canonical_tenant_id],
                )
                tenant = cursor.fetchone()
                if not tenant:
                    raise ValueError("The canonical outbox tenant is unavailable for snapshot export.")

                cursor.execute(
                    """
                    SELECT scheme_id, scheme_name
                    FROM schemes
                    WHERE tenant_id = %s
                    ORDER BY scheme_id
                    """,
                    [canonical_tenant_id],
                )
                schemes = list(cursor.fetchall())

                cursor.execute(
                    """
                    SELECT member_id, scheme_id, first_name, last_name, date_of_birth, gender,
                      identity_number, banking_detail, home_region, home_lat,
                      home_lon, join_date
                    FROM members
                    WHERE tenant_id = %s
                    ORDER BY member_id
                    """,
                    [canonical_tenant_id],
                )
                members = list(cursor.fetchall())

                cursor.execute(
                    """
                    SELECT provider_id, scheme_id, practice_number, specialty, practice_name,
                      banking_detail, practice_region, practice_lat, practice_lon,
                      provider_kind, provider_category
                    FROM providers
                    WHERE tenant_id = %s
                    ORDER BY provider_id
                    """,
                    [canonical_tenant_id],
                )
                providers = list(cursor.fetchall())

                cursor.execute(
                    """
                    SELECT claim_id, scheme_id, member_id, provider_id, service_date,
                      received_date, billing_code, amount, quantity, benefit_option,
                      network_type, line_type, tariff_discipline, diagnosis_code,
                      rendering_practitioner_id, rendering_practitioner_category,
                      rendering_known_to_billing_provider, created_at, updated_at
                    FROM claims
                    WHERE tenant_id = %s
                    ORDER BY claim_id
                    """,
                    [canonical_tenant_id],
                )
                claims = list(cursor.fetchall())
            connection.commit()
        except Exception:
            connection.rollback()
            raise
        finally:
            connection.close()

        max_updated = max((_iso_timestamp(claim.get("updated_at")) for claim in claims), default="none")
        corpus_digest = hashlib.sha256(
            json.dumps(
                {"schemes": schemes, "members": members, "providers": providers, "claims": claims},
                sort_keys=True,
                separators=(",", ":"),
                default=str,
            ).encode("utf-8")
        ).hexdigest()
        watermark = f"claims-updated:{max_updated}:count:{len(claims)}:corpus-sha256:{corpus_digest}"
        return TenantSnapshot(
            tenant_id=canonical_tenant_id,
            tenant_slug=str(tenant.get("tenant_slug") or "") or None,
            tenant_display_name=str(tenant.get("tenant_name") or "") or None,
            detection_strategy=str(tenant.get("strategy_type") or "deterministic_rules"),
            model_deployment_id=str(tenant.get("model_deployment_id") or "") or None,
            captured_at=_iso_timestamp(tenant.get("captured_at")),
            watermark=watermark,
            schemes=schemes,
            members=members,
            providers=providers,
            claims=claims,
        )
