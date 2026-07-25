from __future__ import annotations

import math
from collections import Counter
from dataclasses import dataclass, replace
from datetime import date, datetime
from decimal import Decimal
from typing import Mapping, Sequence

from .snapshot import (
    ProspectiveScoringSnapshot,
    PyMySqlTenantSnapshotRepository,
    _authoritative_claim_payload,
    _canonical_job_scope,
    _database_timestamp,
    _decimal,
    _parse_date,
    _parse_timestamp,
    _positive_integer,
    _required_text,
    _stable_watermark,
)

PREDICTOR_NAMES = (
    "claimed_amount",
    "log1p_claimed_amount",
    "quantity",
    "submission_lag_days",
    "service_weekday_sin",
    "service_weekday_cos",
    "service_month_sin",
    "service_month_cos",
    "has_rendering_practitioner",
    "rendering_known_to_billing_provider",
    "provider_prior_claim_count",
    "provider_prior_unique_member_count",
    "provider_prior_amount_mean",
    "provider_prior_amount_std",
    "provider_prior_max_amount",
    "provider_prior_same_service_day_count",
    "provider_prior_same_code_count",
    "provider_prior_same_code_share",
    "provider_prior_7d_claim_count",
    "provider_prior_30d_claim_count",
    "provider_prior_90d_claim_count",
    "provider_prior_30d_amount_mean",
    "member_prior_claim_count",
    "member_prior_unique_provider_count",
    "member_prior_amount_mean",
    "member_prior_amount_std",
    "member_prior_7d_claim_count",
    "member_prior_30d_claim_count",
    "member_prior_90d_claim_count",
    "member_prior_same_service_day_provider_count",
    "member_days_since_prior_submission",
    "member_has_prior_claim",
    "pair_prior_claim_count",
    "pair_prior_same_code_count",
    "pair_days_since_prior_submission",
    "pair_has_prior_claim",
    "exact_duplicate_prior_count",
    "code_prior_claim_count",
    "code_prior_amount_mean",
    "code_prior_amount_std",
    "claimed_to_provider_prior_mean_ratio",
    "claimed_to_code_prior_mean_ratio",
    "benefit_option",
    "network_type",
    "line_type",
    "billing_code",
    "tariff_discipline",
    "diagnosis_code",
    "billing_provider_kind",
    "billing_provider_category",
    "rendering_practitioner_category",
)


@dataclass(frozen=True)
class _FeatureClaim:
    claim_id: str
    claim_version: int
    member_id: str
    provider_id: str
    service_date: date
    received_date: date
    billing_code: str
    tariff_discipline: str
    amount: Decimal
    quantity: Decimal
    created_at: datetime


def _feature_claim(row: Mapping[str, object], *, field: str) -> _FeatureClaim:
    payload = _authoritative_claim_payload(dict(row), field=field)
    return _FeatureClaim(
        claim_id=_required_text(payload.get("claim_id"), field=f"{field}.claim_id"),
        claim_version=_positive_integer(
            payload.get("claim_version"),
            field=f"{field}.claim_version",
        ),
        member_id=_required_text(payload.get("member_id"), field=f"{field}.member_id"),
        provider_id=_required_text(
            payload.get("provider_id"),
            field=f"{field}.provider_id",
        ),
        service_date=_parse_date(
            payload.get("service_date"),
            field=f"{field}.service_date",
        ),
        received_date=_parse_date(
            payload.get("received_date"),
            field=f"{field}.received_date",
        ),
        billing_code=_required_text(
            payload.get("billing_code"),
            field=f"{field}.billing_code",
        ),
        tariff_discipline=_required_text(
            payload.get("tariff_discipline"),
            field=f"{field}.tariff_discipline",
        ),
        amount=_decimal(payload.get("amount"), field=f"{field}.amount"),
        quantity=_decimal(payload.get("quantity"), field=f"{field}.quantity"),
        created_at=_parse_timestamp(row.get("created_at"), field=f"{field}.created_at"),
    )


def _mean(values: Sequence[float]) -> float:
    return sum(values) / len(values) if values else 0.0


def _std(values: Sequence[float]) -> float:
    if len(values) < 2:
        return 0.0
    mean = _mean(values)
    return math.sqrt(max(0.0, sum(value * value for value in values) / len(values) - mean * mean))


def _window(
    rows: Sequence[_FeatureClaim],
    received_date: date,
    days: int,
) -> list[_FeatureClaim]:
    return [
        row
        for row in rows
        if 0 < (received_date - row.received_date).days <= days
    ]


def _days_since(rows: Sequence[_FeatureClaim], received_date: date) -> int:
    if not rows:
        return 0
    return max(0, (received_date - max(row.received_date for row in rows)).days)


def _decimal_key(value: Decimal) -> str:
    return format(value.normalize(), "f")


def _exact_features(
    target: Mapping[str, object],
    *,
    provider: Mapping[str, object],
    history: Sequence[_FeatureClaim],
) -> dict[str, object]:
    claim_id = _required_text(target.get("claim_id"), field="target.claim_id")
    amount_decimal = _decimal(target.get("amount"), field=f"target {claim_id}.amount")
    quantity_decimal = _decimal(
        target.get("quantity"),
        field=f"target {claim_id}.quantity",
    )
    amount = float(amount_decimal)
    quantity = float(quantity_decimal)
    service_date = _parse_date(
        target.get("service_date"),
        field=f"target {claim_id}.service_date",
    )
    received_date = _parse_date(
        target.get("received_date"),
        field=f"target {claim_id}.received_date",
    )
    member_id = _required_text(
        target.get("member_id"),
        field=f"target {claim_id}.member_id",
    )
    provider_id = _required_text(
        target.get("provider_id"),
        field=f"target {claim_id}.provider_id",
    )
    billing_code = _required_text(
        target.get("billing_code"),
        field=f"target {claim_id}.billing_code",
    )
    tariff_discipline = _required_text(
        target.get("tariff_discipline"),
        field=f"target {claim_id}.tariff_discipline",
    )

    prior = [row for row in history if row.received_date < received_date]
    provider_rows = [row for row in prior if row.provider_id == provider_id]
    member_rows = [row for row in prior if row.member_id == member_id]
    pair_rows = [
        row
        for row in prior
        if row.member_id == member_id and row.provider_id == provider_id
    ]
    code_rows = [
        row
        for row in prior
        if row.tariff_discipline == tariff_discipline
        and row.billing_code == billing_code
    ]
    provider_code_rows = [
        row for row in provider_rows if row.billing_code == billing_code
    ]
    pair_code_rows = [row for row in pair_rows if row.billing_code == billing_code]

    provider_amounts = [float(row.amount) for row in provider_rows]
    member_amounts = [float(row.amount) for row in member_rows]
    code_amounts = [float(row.amount) for row in code_rows]
    provider_7 = _window(provider_rows, received_date, 7)
    provider_30 = _window(provider_rows, received_date, 30)
    provider_90 = _window(provider_rows, received_date, 90)
    member_7 = _window(member_rows, received_date, 7)
    member_30 = _window(member_rows, received_date, 30)
    member_90 = _window(member_rows, received_date, 90)

    duplicate_signature = (
        member_id,
        provider_id,
        service_date,
        billing_code,
        _decimal_key(quantity_decimal),
        _decimal_key(amount_decimal.quantize(Decimal("0.01"))),
    )
    duplicate_count = sum(
        1
        for row in prior
        if (
            row.member_id,
            row.provider_id,
            row.service_date,
            row.billing_code,
            _decimal_key(row.quantity),
            _decimal_key(row.amount.quantize(Decimal("0.01"))),
        )
        == duplicate_signature
    )

    provider_mean = _mean(provider_amounts)
    code_mean = _mean(code_amounts)
    weekday_angle = 2 * math.pi * service_date.weekday() / 7
    month_angle = 2 * math.pi * (service_date.month - 1) / 12
    rendering_id = target.get("rendering_practitioner_id")

    features: dict[str, object] = {
        "claimed_amount": amount,
        "log1p_claimed_amount": math.log1p(amount),
        "quantity": quantity,
        "submission_lag_days": (received_date - service_date).days,
        "service_weekday_sin": math.sin(weekday_angle),
        "service_weekday_cos": math.cos(weekday_angle),
        "service_month_sin": math.sin(month_angle),
        "service_month_cos": math.cos(month_angle),
        "has_rendering_practitioner": int(
            rendering_id is not None and bool(str(rendering_id).strip())
        ),
        "rendering_known_to_billing_provider": int(
            target.get("rendering_known_to_billing_provider") is True
        ),
        "provider_prior_claim_count": len(provider_rows),
        "provider_prior_unique_member_count": len(
            {row.member_id for row in provider_rows}
        ),
        "provider_prior_amount_mean": provider_mean,
        "provider_prior_amount_std": _std(provider_amounts),
        "provider_prior_max_amount": max(provider_amounts, default=0.0),
        "provider_prior_same_service_day_count": sum(
            row.service_date == service_date for row in provider_rows
        ),
        "provider_prior_same_code_count": len(provider_code_rows),
        "provider_prior_same_code_share": (
            len(provider_code_rows) / len(provider_rows) if provider_rows else 0.0
        ),
        "provider_prior_7d_claim_count": len(provider_7),
        "provider_prior_30d_claim_count": len(provider_30),
        "provider_prior_90d_claim_count": len(provider_90),
        "provider_prior_30d_amount_mean": _mean(
            [float(row.amount) for row in provider_30]
        ),
        "member_prior_claim_count": len(member_rows),
        "member_prior_unique_provider_count": len(
            {row.provider_id for row in member_rows}
        ),
        "member_prior_amount_mean": _mean(member_amounts),
        "member_prior_amount_std": _std(member_amounts),
        "member_prior_7d_claim_count": len(member_7),
        "member_prior_30d_claim_count": len(member_30),
        "member_prior_90d_claim_count": len(member_90),
        "member_prior_same_service_day_provider_count": len(
            {
                row.provider_id
                for row in member_rows
                if row.service_date == service_date
            }
        ),
        "member_days_since_prior_submission": _days_since(
            member_rows,
            received_date,
        ),
        "member_has_prior_claim": int(bool(member_rows)),
        "pair_prior_claim_count": len(pair_rows),
        "pair_prior_same_code_count": len(pair_code_rows),
        "pair_days_since_prior_submission": _days_since(pair_rows, received_date),
        "pair_has_prior_claim": int(bool(pair_rows)),
        "exact_duplicate_prior_count": duplicate_count,
        "code_prior_claim_count": len(code_rows),
        "code_prior_amount_mean": code_mean,
        "code_prior_amount_std": _std(code_amounts),
        "claimed_to_provider_prior_mean_ratio": (
            amount / provider_mean if provider_mean > 0 else 0.0
        ),
        "claimed_to_code_prior_mean_ratio": (
            amount / code_mean if code_mean > 0 else 0.0
        ),
        "benefit_option": _required_text(
            target.get("benefit_option"),
            field=f"target {claim_id}.benefit_option",
        ),
        "network_type": _required_text(
            target.get("network_type"),
            field=f"target {claim_id}.network_type",
        ),
        "line_type": _required_text(
            target.get("line_type"),
            field=f"target {claim_id}.line_type",
        ),
        "billing_code": billing_code,
        "tariff_discipline": tariff_discipline,
        "diagnosis_code": _required_text(
            target.get("diagnosis_code"),
            field=f"target {claim_id}.diagnosis_code",
        ),
        "billing_provider_kind": _required_text(
            provider.get("provider_kind"),
            field=f"provider {provider_id}.provider_kind",
        ),
        "billing_provider_category": _required_text(
            provider.get("provider_category"),
            field=f"provider {provider_id}.provider_category",
        ),
        "rendering_practitioner_category": _required_text(
            target.get("rendering_practitioner_category"),
            field=f"target {claim_id}.rendering_practitioner_category",
        ),
    }

    if tuple(features) != PREDICTOR_NAMES:
        raise ValueError("Prospective feature order differs from the sealed model contract.")
    for name, value in features.items():
        if isinstance(value, float) and not math.isfinite(value):
            raise ValueError(f"Prospective feature {name} is non-finite.")
    return features


class ProspectiveBaselineSnapshotRepository(PyMySqlTenantSnapshotRepository):
    """Adds the sealed Gate G predictor vector to the standard tenant snapshot."""

    @staticmethod
    def _load_all_history_rows(
        cursor,
        *,
        tenant_id: str,
        cutoff: datetime,
    ) -> list[dict[str, object]]:
        cursor.execute(
            """
                SELECT
                    cv.claim_id,
                    cv.claim_version,
                    cv.claim_payload,
                    cv.created_at
                FROM claim_versions cv
                INNER JOIN (
                    SELECT
                        claim_id,
                        MAX(claim_version) AS claim_version
                    FROM claim_versions
                    WHERE tenant_id = %s
                      AND created_at <= %s
                    GROUP BY claim_id
                ) latest
                    ON latest.claim_id = cv.claim_id
                   AND latest.claim_version = cv.claim_version
                WHERE cv.tenant_id = %s
                ORDER BY cv.created_at, cv.claim_id
            """,
            [
                tenant_id,
                _database_timestamp(cutoff),
                tenant_id,
            ],
        )
        return list(cursor.fetchall())

    def load_tenant_snapshot(
        self,
        *,
        tenant_id: str,
        jobs,
    ) -> ProspectiveScoringSnapshot:
        snapshot = super().load_tenant_snapshot(tenant_id=tenant_id, jobs=jobs)
        scope = _canonical_job_scope(tenant_id=tenant_id, jobs=jobs)
        connection = self.connection_factory()
        try:
            with connection.cursor() as cursor:
                rows = self._load_all_history_rows(
                    cursor,
                    tenant_id=snapshot.tenant_id,
                    cutoff=scope.context_cutoff,
                )
            connection.commit()
        except Exception:
            connection.rollback()
            raise
        finally:
            connection.close()

        target_ids = {
            _required_text(item.get("claim_id"), field="target claim_id")
            for item in snapshot.target_claims
        }
        history: list[_FeatureClaim] = []
        for index, row in enumerate(rows):
            claim = _feature_claim(row, field=f"history_rows[{index}]")
            if claim.claim_id in target_ids:
                continue
            if claim.created_at > scope.context_cutoff:
                raise ValueError("Historical feature context crossed the pinned cutoff.")
            history.append(claim)

        providers = {
            _required_text(item.get("provider_id"), field="provider.provider_id"): item
            for item in snapshot.providers
        }
        context_features: list[dict[str, object]] = []
        for target in snapshot.target_claims:
            claim_id = _required_text(target.get("claim_id"), field="target.claim_id")
            claim_version = _positive_integer(
                target.get("claim_version"),
                field=f"target {claim_id}.claim_version",
            )
            provider_id = _required_text(
                target.get("provider_id"),
                field=f"target {claim_id}.provider_id",
            )
            provider = providers.get(provider_id)
            if provider is None:
                raise ValueError(
                    f"Target claim {claim_id} references an unavailable provider."
                )
            context_features.append(
                {
                    "claim_id": claim_id,
                    "claim_version": claim_version,
                    "features": _exact_features(
                        target,
                        provider=provider,
                        history=history,
                    ),
                }
            )

        watermark = _stable_watermark(
            tenant_id=snapshot.tenant_id,
            scope=scope,
            target_claims=snapshot.target_claims,
            context_features=context_features,
        )
        return replace(
            snapshot,
            watermark=watermark,
            context_features=context_features,
        )
