from __future__ import annotations

import hashlib
import json
import math
from dataclasses import dataclass
from datetime import UTC, date, datetime, timedelta
from decimal import Decimal, InvalidOperation
from typing import TYPE_CHECKING, Callable, Iterable, Iterator, Mapping, Sequence

if TYPE_CHECKING:
    from .outbox import OutboxJob


MAX_TARGET_CLAIMS = 10_000
TARGET_QUERY_BATCH_SIZE = 500
CONTEXT_LOOKBACK_DAYS = 365
SUPPORTED_PAYLOAD_SCHEMA_VERSION = 2
SUPPORTED_STRATEGIES = frozenset(
    {
        "deterministic_rules",
        "approved_model",
    }
)


@dataclass(frozen=True, order=True)
class ClaimVersionRef:
    claim_id: str
    claim_version: int


@dataclass(frozen=True)
class ProspectiveScoringSnapshot:
    tenant_id: str
    tenant_slug: str | None
    tenant_display_name: str | None

    detection_strategy_id: int
    detection_strategy: str
    model_deployment_id: str | None

    captured_at: str
    context_cutoff_at: str
    watermark: str
    source_job_ids: tuple[str, ...]

    schemes: list[dict[str, object]]
    members: list[dict[str, object]]
    providers: list[dict[str, object]]

    target_claims: list[dict[str, object]]
    context_features: list[dict[str, object]]


@dataclass(frozen=True)
class _JobScope:
    detection_strategy_id: int
    strategy_type: str
    model_deployment_id: str | None
    context_cutoff: datetime
    targets: tuple[ClaimVersionRef, ...]
    source_job_ids: tuple[str, ...]


@dataclass(frozen=True)
class _HistoricalClaim:
    claim_id: str
    claim_version: int
    member_id: str
    provider_id: str
    billing_code: str
    service_date: date
    received_date: date
    amount: Decimal
    created_at: datetime


def _required_text(
    value: object,
    *,
    field: str,
) -> str:
    rendered = str(value or "").strip()

    if not rendered:
        raise ValueError(f"{field} is required.")

    return rendered


def _optional_text(
    value: object,
) -> str | None:
    rendered = str(value or "").strip()
    return rendered or None


def _positive_integer(
    value: object,
    *,
    field: str,
) -> int:
    if isinstance(value, bool):
        raise ValueError(
            f"{field} must be a positive integer."
        )

    try:
        parsed = int(value)
    except (TypeError, ValueError) as error:
        raise ValueError(
            f"{field} must be a positive integer."
        ) from error

    valid_representations = {
        str(parsed),
        f"{parsed}.0",
    }

    if (
        parsed <= 0
        or str(value).strip() not in valid_representations
    ):
        raise ValueError(
            f"{field} must be a positive integer."
        )

    return parsed


def _parse_timestamp(
    value: object,
    *,
    field: str,
) -> datetime:
    if isinstance(value, datetime):
        parsed = value

    elif isinstance(value, date):
        parsed = datetime.combine(
            value,
            datetime.min.time(),
            tzinfo=UTC,
        )

    else:
        rendered = str(value or "").strip()

        if not rendered:
            raise ValueError(
                f"{field} is required."
            )

        try:
            parsed = datetime.fromisoformat(
                rendered.replace(
                    "Z",
                    "+00:00",
                )
            )
        except ValueError as error:
            raise ValueError(
                f"{field} must be an ISO timestamp."
            ) from error

    if parsed.tzinfo is None:
        parsed = parsed.replace(
            tzinfo=UTC
        )

    return parsed.astimezone(
        UTC
    )


def _parse_date(
    value: object,
    *,
    field: str,
) -> date:
    if isinstance(value, datetime):
        return value.date()

    if isinstance(value, date):
        return value

    try:
        return date.fromisoformat(
            str(value or "").strip()
        )
    except ValueError as error:
        raise ValueError(
            f"{field} must be an ISO calendar date."
        ) from error


def _database_timestamp(
    value: datetime,
) -> datetime:
    return value.astimezone(
        UTC
    ).replace(
        tzinfo=None
    )


def _decimal(
    value: object,
    *,
    field: str,
) -> Decimal:
    try:
        parsed = Decimal(
            str(value)
        )
    except (
        InvalidOperation,
        TypeError,
        ValueError,
    ) as error:
        raise ValueError(
            f"{field} must be a finite decimal."
        ) from error

    if (
        not parsed.is_finite()
        or parsed <= 0
    ):
        raise ValueError(
            f"{field} must be greater than zero."
        )

    return parsed


def _decode_json_object(
    value: object,
    *,
    field: str,
) -> dict[str, object]:
    decoded = value

    if isinstance(
        decoded,
        (bytes, bytearray),
    ):
        try:
            decoded = decoded.decode(
                "utf-8"
            )
        except UnicodeDecodeError as error:
            raise ValueError(
                f"{field} is not valid UTF-8 JSON."
            ) from error

    if isinstance(
        decoded,
        str,
    ):
        try:
            decoded = json.loads(
                decoded
            )
        except json.JSONDecodeError as error:
            raise ValueError(
                f"{field} is not valid JSON."
            ) from error

    if not isinstance(
        decoded,
        dict,
    ):
        raise ValueError(
            f"{field} must be a JSON object."
        )

    return dict(decoded)


def _chunks(
    values: Sequence[ClaimVersionRef],
    size: int,
) -> Iterator[Sequence[ClaimVersionRef]]:
    for start in range(
        0,
        len(values),
        size,
    ):
        yield values[
            start : start + size
        ]


def _canonical_job_scope(
    *,
    tenant_id: str,
    jobs: Sequence["OutboxJob"],
) -> _JobScope:
    if not jobs:
        raise ValueError(
            "At least one outbox job is required."
        )

    strategy_ids: set[int] = set()
    strategy_types: set[str] = set()
    deployment_ids: set[str | None] = set()
    cutoffs: set[datetime] = set()
    targets: set[ClaimVersionRef] = set()
    job_ids: set[str] = set()

    for job in jobs:
        job_id = _required_text(
            getattr(
                job,
                "id",
                None,
            ),
            field="outbox job id",
        )

        job_ids.add(
            job_id
        )

        job_tenant_id = _required_text(
            getattr(
                job,
                "tenant_id",
                None,
            ),
            field=(
                f"outbox job {job_id} "
                "tenant_id"
            ),
        )

        if job_tenant_id != tenant_id:
            raise ValueError(
                "A prospective snapshot cannot "
                "cross tenant boundaries."
            )

        strategy_id = _positive_integer(
            getattr(
                job,
                "detection_strategy_id",
                None,
            ),
            field=(
                f"outbox job {job_id} "
                "detection_strategy_id"
            ),
        )

        strategy_type = _required_text(
            getattr(
                job,
                "strategy_type",
                None,
            ),
            field=(
                f"outbox job {job_id} "
                "strategy_type"
            ),
        )

        deployment_id = _optional_text(
            getattr(
                job,
                "model_deployment_id",
                None,
            )
        )

        if strategy_type not in SUPPORTED_STRATEGIES:
            raise ValueError(
                f"Outbox job {job_id} has "
                "an unsupported strategy."
            )

        if (
            strategy_type == "approved_model"
            and deployment_id is None
        ):
            raise ValueError(
                f"Outbox job {job_id} is missing "
                "its pinned deployment."
            )

        if (
            strategy_type == "deterministic_rules"
            and deployment_id is not None
        ):
            raise ValueError(
                f"Outbox job {job_id} cannot attach "
                "a deployment to deterministic rules."
            )

        payload = getattr(
            job,
            "payload",
            None,
        )

        if not isinstance(
            payload,
            dict,
        ):
            raise ValueError(
                f"Outbox job {job_id} payload "
                "must be an object."
            )

        schema_version = _positive_integer(
            payload.get(
                "schema_version"
            ),
            field=(
                f"outbox job {job_id} "
                "payload schema_version"
            ),
        )

        if (
            schema_version
            != SUPPORTED_PAYLOAD_SCHEMA_VERSION
        ):
            raise ValueError(
                f"Outbox job {job_id} payload "
                "schema is unsupported."
            )

        dataset_scope = _required_text(
            payload.get(
                "dataset_scope"
            ),
            field=(
                f"outbox job {job_id} "
                "dataset_scope"
            ),
        )

        if (
            dataset_scope
            != "triggering_claim_versions"
        ):
            raise ValueError(
                f"Outbox job {job_id} dataset scope "
                "must be triggering_claim_versions."
            )

        cutoff = _parse_timestamp(
            payload.get(
                "context_cutoff_at"
            ),
            field=(
                f"outbox job {job_id} "
                "context_cutoff_at"
            ),
        )

        raw_targets = payload.get(
            "targets"
        )

        if (
            not isinstance(
                raw_targets,
                list,
            )
            or not raw_targets
        ):
            raise ValueError(
                f"Outbox job {job_id} must contain "
                "target claim versions."
            )

        for index, target in enumerate(
            raw_targets
        ):
            if (
                not isinstance(
                    target,
                    dict,
                )
                or frozenset(target)
                != {
                    "claim_id",
                    "claim_version",
                }
            ):
                raise ValueError(
                    f"Outbox job {job_id} "
                    f"targets[{index}] has "
                    "an incompatible shape."
                )

            targets.add(
                ClaimVersionRef(
                    claim_id=_required_text(
                        target.get(
                            "claim_id"
                        ),
                        field=(
                            f"outbox job {job_id} "
                            f"targets[{index}].claim_id"
                        ),
                    ),
                    claim_version=_positive_integer(
                        target.get(
                            "claim_version"
                        ),
                        field=(
                            f"outbox job {job_id} "
                            f"targets[{index}].claim_version"
                        ),
                    ),
                )
            )

        strategy_ids.add(
            strategy_id
        )
        strategy_types.add(
            strategy_type
        )
        deployment_ids.add(
            deployment_id
        )
        cutoffs.add(
            cutoff
        )

    if (
        len(strategy_ids) != 1
        or len(strategy_types) != 1
        or len(deployment_ids) != 1
    ):
        raise ValueError(
            "Coalesced jobs must share "
            "one pinned strategy."
        )

    if len(cutoffs) != 1:
        raise ValueError(
            "Coalesced jobs must share "
            "one context cutoff."
        )

    if (
        not targets
        or len(targets) > MAX_TARGET_CLAIMS
    ):
        raise ValueError(
            "The target claim-version count "
            "is unsupported."
        )

    return _JobScope(
        detection_strategy_id=next(
            iter(strategy_ids)
        ),
        strategy_type=next(
            iter(strategy_types)
        ),
        model_deployment_id=next(
            iter(deployment_ids)
        ),
        context_cutoff=next(
            iter(cutoffs)
        ),
        targets=tuple(
            sorted(targets)
        ),
        source_job_ids=tuple(
            sorted(job_ids)
        ),
    )


def _authoritative_claim_payload(
    row: Mapping[str, object],
    *,
    field: str,
) -> dict[str, object]:
    claim_id = _required_text(
        row.get(
            "claim_id"
        ),
        field=(
            f"{field}.claim_id"
        ),
    )

    claim_version = _positive_integer(
        row.get(
            "claim_version"
        ),
        field=(
            f"{field}.claim_version"
        ),
    )

    payload = _decode_json_object(
        row.get(
            "claim_payload"
        ),
        field=(
            f"{field}.claim_payload"
        ),
    )

    payload.pop(
        "tenant_id",
        None,
    )

    payload_claim_id = _optional_text(
        payload.get(
            "claim_id"
        )
    )

    if (
        payload_claim_id is not None
        and payload_claim_id != claim_id
    ):
        raise ValueError(
            f"{field}.claim_payload claim_id "
            "does not match its row."
        )

    payload_claim_version = payload.get(
        "claim_version"
    )

    if (
        payload_claim_version is not None
        and _positive_integer(
            payload_claim_version,
            field=(
                f"{field}.claim_payload."
                "claim_version"
            ),
        )
        != claim_version
    ):
        raise ValueError(
            f"{field}.claim_payload claim_version "
            "does not match its row."
        )

    payload["claim_id"] = claim_id
    payload["claim_version"] = claim_version

    return payload


def _historical_claim(
    row: Mapping[str, object],
    *,
    field: str,
) -> _HistoricalClaim:
    payload = _authoritative_claim_payload(
        row,
        field=field,
    )

    return _HistoricalClaim(
        claim_id=_required_text(
            payload.get(
                "claim_id"
            ),
            field=(
                f"{field}.claim_id"
            ),
        ),
        claim_version=_positive_integer(
            payload.get(
                "claim_version"
            ),
            field=(
                f"{field}.claim_version"
            ),
        ),
        member_id=_required_text(
            payload.get(
                "member_id"
            ),
            field=(
                f"{field}.member_id"
            ),
        ),
        provider_id=_required_text(
            payload.get(
                "provider_id"
            ),
            field=(
                f"{field}.provider_id"
            ),
        ),
        billing_code=_required_text(
            payload.get(
                "billing_code"
            ),
            field=(
                f"{field}.billing_code"
            ),
        ),
        service_date=_parse_date(
            payload.get(
                "service_date"
            ),
            field=(
                f"{field}.service_date"
            ),
        ),
        received_date=_parse_date(
            payload.get(
                "received_date"
            ),
            field=(
                f"{field}.received_date"
            ),
        ),
        amount=_decimal(
            payload.get(
                "amount"
            ),
            field=(
                f"{field}.amount"
            ),
        ),
        created_at=_parse_timestamp(
            row.get(
                "created_at"
            ),
            field=(
                f"{field}.created_at"
            ),
        ),
    )


def _within(
    rows: Iterable[_HistoricalClaim],
    *,
    cutoff: datetime,
    days: int,
) -> list[_HistoricalClaim]:
    start = cutoff - timedelta(
        days=days
    )

    return [
        row
        for row in rows
        if start <= row.created_at <= cutoff
    ]


def _count_and_amount(
    rows: Iterable[_HistoricalClaim],
) -> tuple[int, Decimal]:
    materialized = list(rows)

    return (
        len(materialized),
        sum(
            (
                row.amount
                for row in materialized
            ),
            Decimal("0"),
        ),
    )


def _money(
    value: Decimal,
) -> float:
    return float(
        value.quantize(
            Decimal("0.01")
        )
    )


def _ratio(
    value: Decimal,
) -> float:
    rendered = float(value)

    if not math.isfinite(
        rendered
    ):
        raise ValueError(
            "A generated context feature "
            "is non-finite."
        )

    return round(
        rendered,
        6,
    )


def _days_since_latest(
    rows: Sequence[_HistoricalClaim],
    cutoff: datetime,
) -> int | None:
    if not rows:
        return None

    latest = max(
        row.created_at
        for row in rows
    )

    return max(
        0,
        (
            cutoff.date()
            - latest.date()
        ).days,
    )


def _context_for_target(
    target: Mapping[str, object],
    *,
    history: Sequence[_HistoricalClaim],
    cutoff: datetime,
) -> dict[str, object]:
    claim_id = _required_text(
        target.get(
            "claim_id"
        ),
        field="target claim_id",
    )

    claim_version = _positive_integer(
        target.get(
            "claim_version"
        ),
        field=(
            f"target {claim_id} "
            "claim_version"
        ),
    )

    member_id = _required_text(
        target.get(
            "member_id"
        ),
        field=(
            f"target {claim_id} member_id"
        ),
    )

    provider_id = _required_text(
        target.get(
            "provider_id"
        ),
        field=(
            f"target {claim_id} provider_id"
        ),
    )

    billing_code = _required_text(
        target.get(
            "billing_code"
        ),
        field=(
            f"target {claim_id} billing_code"
        ),
    )

    amount = _decimal(
        target.get(
            "amount"
        ),
        field=(
            f"target {claim_id} amount"
        ),
    )

    service_date = _parse_date(
        target.get(
            "service_date"
        ),
        field=(
            f"target {claim_id} service_date"
        ),
    )

    received_date = _parse_date(
        target.get(
            "received_date"
        ),
        field=(
            f"target {claim_id} received_date"
        ),
    )

    member = [
        row
        for row in history
        if row.member_id == member_id
    ]

    provider = [
        row
        for row in history
        if row.provider_id == provider_id
    ]

    pair = [
        row
        for row in history
        if (
            row.member_id == member_id
            and row.provider_id == provider_id
        )
    ]

    billing = [
        row
        for row in history
        if row.billing_code == billing_code
    ]

    provider_billing = [
        row
        for row in provider
        if row.billing_code == billing_code
    ]

    duplicate_like = [
        row
        for row in history
        if (
            row.member_id == member_id
            and row.provider_id == provider_id
            and row.billing_code == billing_code
            and row.service_date == service_date
            and row.amount == amount
        )
    ]

    windows = {
        "member30": _within(
            member,
            cutoff=cutoff,
            days=30,
        ),
        "member90": _within(
            member,
            cutoff=cutoff,
            days=90,
        ),
        "member365": _within(
            member,
            cutoff=cutoff,
            days=365,
        ),
        "provider7": _within(
            provider,
            cutoff=cutoff,
            days=7,
        ),
        "provider30": _within(
            provider,
            cutoff=cutoff,
            days=30,
        ),
        "provider90": _within(
            provider,
            cutoff=cutoff,
            days=90,
        ),
        "provider365": _within(
            provider,
            cutoff=cutoff,
            days=365,
        ),
        "pair365": _within(
            pair,
            cutoff=cutoff,
            days=365,
        ),
        "billing90": _within(
            billing,
            cutoff=cutoff,
            days=90,
        ),
        "providerBilling90": _within(
            provider_billing,
            cutoff=cutoff,
            days=90,
        ),
        "duplicate365": _within(
            duplicate_like,
            cutoff=cutoff,
            days=365,
        ),
    }

    totals = {
        name: _count_and_amount(rows)
        for name, rows in windows.items()
    }

    member_mean = (
        totals["member365"][1]
        / totals["member365"][0]
        if totals["member365"][0]
        else None
    )

    provider_mean = (
        totals["provider365"][1]
        / totals["provider365"][0]
        if totals["provider365"][0]
        else None
    )

    return {
        "claim_id": claim_id,
        "claim_version": claim_version,
        "features": {
            "historyWindowDays": (
                CONTEXT_LOOKBACK_DAYS
            ),
            "contextCutoffAt": (
                cutoff.isoformat()
            ),
            "claim": {
                "submissionLagDays": (
                    received_date
                    - service_date
                ).days,
                "duplicateLikeClaimCount365d": (
                    len(
                        windows["duplicate365"]
                    )
                ),
                "amountToMemberMean365d": (
                    _ratio(
                        amount / member_mean
                    )
                    if (
                        member_mean is not None
                        and member_mean > 0
                    )
                    else None
                ),
                "amountToProviderMean365d": (
                    _ratio(
                        amount / provider_mean
                    )
                    if (
                        provider_mean is not None
                        and provider_mean > 0
                    )
                    else None
                ),
            },
            "member": {
                "claimCount30d": (
                    totals["member30"][0]
                ),
                "claimAmount30d": (
                    _money(
                        totals["member30"][1]
                    )
                ),
                "claimCount90d": (
                    totals["member90"][0]
                ),
                "claimAmount90d": (
                    _money(
                        totals["member90"][1]
                    )
                ),
                "claimCount365d": (
                    totals["member365"][0]
                ),
                "claimAmount365d": (
                    _money(
                        totals["member365"][1]
                    )
                ),
                "distinctProviderCount90d": (
                    len(
                        {
                            row.provider_id
                            for row
                            in windows["member90"]
                        }
                    )
                ),
                "daysSincePreviousClaim": (
                    _days_since_latest(
                        member,
                        cutoff,
                    )
                ),
            },
            "provider": {
                "claimCount7d": (
                    totals["provider7"][0]
                ),
                "claimAmount7d": (
                    _money(
                        totals["provider7"][1]
                    )
                ),
                "claimCount30d": (
                    totals["provider30"][0]
                ),
                "claimAmount30d": (
                    _money(
                        totals["provider30"][1]
                    )
                ),
                "claimCount90d": (
                    totals["provider90"][0]
                ),
                "claimAmount90d": (
                    _money(
                        totals["provider90"][1]
                    )
                ),
                "claimCount365d": (
                    totals["provider365"][0]
                ),
                "claimAmount365d": (
                    _money(
                        totals["provider365"][1]
                    )
                ),
                "distinctMemberCount90d": (
                    len(
                        {
                            row.member_id
                            for row
                            in windows["provider90"]
                        }
                    )
                ),
                "daysSincePreviousClaim": (
                    _days_since_latest(
                        provider,
                        cutoff,
                    )
                ),
            },
            "memberProviderPair": {
                "claimCount365d": (
                    len(
                        windows["pair365"]
                    )
                ),
            },
            "billingCode": {
                "tenantClaimCount90d": (
                    len(
                        windows["billing90"]
                    )
                ),
                "providerClaimCount90d": (
                    len(
                        windows["providerBilling90"]
                    )
                ),
            },
        },
    }


def _stable_watermark(
    *,
    tenant_id: str,
    scope: _JobScope,
    target_claims: Sequence[
        Mapping[str, object]
    ],
    context_features: Sequence[
        Mapping[str, object]
    ],
) -> str:
    digest = hashlib.sha256(
        json.dumps(
            {
                "tenant_id": tenant_id,
                "detection_strategy_id": (
                    scope.detection_strategy_id
                ),
                "strategy_type": (
                    scope.strategy_type
                ),
                "model_deployment_id": (
                    scope.model_deployment_id
                ),
                "context_cutoff_at": (
                    scope.context_cutoff.isoformat()
                ),
                "targets": list(
                    target_claims
                ),
                "context_features": list(
                    context_features
                ),
            },
            sort_keys=True,
            separators=(
                ",",
                ":",
            ),
            default=str,
        ).encode(
            "utf-8"
        )
    ).hexdigest()

    return (
        "prospective:"
        f"{scope.context_cutoff.isoformat()}:"
        f"targets:{len(target_claims)}:"
        f"sha256:{digest}"
    )


class PyMySqlTenantSnapshotRepository:
    """
    Loads exact immutable target claim versions and
    aggregate historical context for prospective scoring.
    """

    def __init__(
        self,
        connection_factory: Callable[
            [],
            object,
        ],
        allowed_tenant_ids: (
            frozenset[str] | None
        ) = None,
    ) -> None:
        self.connection_factory = (
            connection_factory
        )
        self.allowed_tenant_ids = (
            allowed_tenant_ids
        )

    def _require_allowed_tenant(
        self,
        tenant_id: str,
    ) -> str:
        canonical = _required_text(
            tenant_id,
            field="tenant_id",
        )

        if (
            self.allowed_tenant_ids
            is not None
            and canonical
            not in self.allowed_tenant_ids
        ):
            raise ValueError(
                "Snapshot tenant is outside "
                "the verified data-plane scope."
            )

        return canonical

    @staticmethod
    def _load_target_rows(
        cursor,
        *,
        tenant_id: str,
        targets: Sequence[
            ClaimVersionRef
        ],
    ) -> list[dict[str, object]]:
        rows: list[
            dict[str, object]
        ] = []

        for batch in _chunks(
            targets,
            TARGET_QUERY_BATCH_SIZE,
        ):
            placeholders = ", ".join(
                ["(%s, %s)"] * len(batch)
            )

            params: list[object] = [
                tenant_id
            ]

            for target in batch:
                params.extend(
                    [
                        target.claim_id,
                        target.claim_version,
                    ]
                )

            cursor.execute(
                f"""
                    SELECT
                        claim_id,
                        claim_version,
                        claim_payload,
                        created_at
                    FROM claim_versions
                    WHERE tenant_id = %s
                      AND (
                        claim_id,
                        claim_version
                      ) IN ({placeholders})
                    ORDER BY
                        claim_id,
                        claim_version
                """,
                params,
            )

            rows.extend(
                cursor.fetchall()
            )

        return rows

    @staticmethod
    def _load_history_rows(
        cursor,
        *,
        tenant_id: str,
        cutoff: datetime,
    ) -> list[dict[str, object]]:
        start = cutoff - timedelta(
            days=CONTEXT_LOOKBACK_DAYS
        )

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
                        MAX(claim_version)
                            AS claim_version
                    FROM claim_versions
                    WHERE tenant_id = %s
                      AND created_at >= %s
                      AND created_at <= %s
                    GROUP BY claim_id
                ) latest
                    ON latest.claim_id
                        = cv.claim_id
                   AND latest.claim_version
                        = cv.claim_version
                WHERE cv.tenant_id = %s
                ORDER BY
                    cv.created_at,
                    cv.claim_id,
                    cv.claim_version
            """,
            [
                tenant_id,
                _database_timestamp(
                    start
                ),
                _database_timestamp(
                    cutoff
                ),
                tenant_id,
            ],
        )

        return list(
            cursor.fetchall()
        )

    def load_tenant_snapshot(
        self,
        *,
        tenant_id: str,
        jobs: list["OutboxJob"],
    ) -> ProspectiveScoringSnapshot:
        canonical_tenant_id = (
            self._require_allowed_tenant(
                tenant_id
            )
        )

        scope = _canonical_job_scope(
            tenant_id=canonical_tenant_id,
            jobs=jobs,
        )

        connection = (
            self.connection_factory()
        )

        try:
            with connection.cursor() as cursor:
                cursor.execute(
                    "SET TRANSACTION ISOLATION "
                    "LEVEL REPEATABLE READ"
                )

            connection.begin()

            with connection.cursor() as cursor:
                cursor.execute(
                    """
                        SELECT
                            tenant_id,
                            tenant_slug,
                            tenant_name
                        FROM tenants
                        WHERE tenant_id = %s
                          AND status = 'active'
                        LIMIT 1
                    """,
                    [
                        canonical_tenant_id
                    ],
                )

                tenant = cursor.fetchone()

                if not tenant:
                    raise ValueError(
                        "The canonical tenant is "
                        "unavailable for snapshot export."
                    )

                cursor.execute(
                    """
                        SELECT
                            scheme_id,
                            scheme_name
                        FROM schemes
                        WHERE tenant_id = %s
                        ORDER BY scheme_id
                    """,
                    [
                        canonical_tenant_id
                    ],
                )

                schemes = list(
                    cursor.fetchall()
                )

                cursor.execute(
                    """
                        SELECT
                            member_id,
                            scheme_id,
                            first_name,
                            last_name,
                            date_of_birth,
                            gender,
                            identity_number,
                            banking_detail,
                            home_region,
                            home_lat,
                            home_lon,
                            join_date
                        FROM members
                        WHERE tenant_id = %s
                        ORDER BY member_id
                    """,
                    [
                        canonical_tenant_id
                    ],
                )

                members = list(
                    cursor.fetchall()
                )

                cursor.execute(
                    """
                        SELECT
                            provider_id,
                            scheme_id,
                            practice_number,
                            specialty,
                            practice_name,
                            banking_detail,
                            practice_region,
                            practice_lat,
                            practice_lon,
                            provider_kind,
                            provider_category
                        FROM providers
                        WHERE tenant_id = %s
                        ORDER BY provider_id
                    """,
                    [
                        canonical_tenant_id
                    ],
                )

                providers = list(
                    cursor.fetchall()
                )

                target_rows = (
                    self._load_target_rows(
                        cursor,
                        tenant_id=(
                            canonical_tenant_id
                        ),
                        targets=scope.targets,
                    )
                )

                history_rows = (
                    self._load_history_rows(
                        cursor,
                        tenant_id=(
                            canonical_tenant_id
                        ),
                        cutoff=(
                            scope.context_cutoff
                        ),
                    )
                )

            connection.commit()

        except Exception:
            connection.rollback()
            raise

        finally:
            connection.close()

        target_by_ref: dict[
            ClaimVersionRef,
            dict[str, object],
        ] = {}

        for index, row in enumerate(
            target_rows
        ):
            target_created_at = (
                _parse_timestamp(
                    row.get(
                        "created_at"
                    ),
                    field=(
                        f"target_rows[{index}]"
                        ".created_at"
                    ),
                )
            )

            if (
                target_created_at
                > scope.context_cutoff
            ):
                raise ValueError(
                    "A pinned target claim version "
                    "was created after its cutoff."
                )

            payload = (
                _authoritative_claim_payload(
                    row,
                    field=(
                        f"target_rows[{index}]"
                    ),
                )
            )

            reference = ClaimVersionRef(
                claim_id=_required_text(
                    payload.get(
                        "claim_id"
                    ),
                    field=(
                        "target claim_id"
                    ),
                ),
                claim_version=_positive_integer(
                    payload.get(
                        "claim_version"
                    ),
                    field=(
                        "target claim_version"
                    ),
                ),
            )

            if reference in target_by_ref:
                raise ValueError(
                    "The target query returned "
                    "a duplicate claim version."
                )

            target_by_ref[
                reference
            ] = payload

        if (
            set(target_by_ref)
            != set(scope.targets)
        ):
            missing = sorted(
                set(scope.targets)
                - set(target_by_ref)
            )

            details = ", ".join(
                (
                    f"{target.claim_id}@"
                    f"{target.claim_version}"
                )
                for target in missing
            )

            raise ValueError(
                "Pinned target claim versions "
                "are unavailable"
                + (
                    f": {details}"
                    if details
                    else "."
                )
            )

        target_claims = [
            target_by_ref[target]
            for target in scope.targets
        ]

        target_ids = {
            target.claim_id
            for target in scope.targets
        }

        history: list[
            _HistoricalClaim
        ] = []

        for index, row in enumerate(
            history_rows
        ):
            claim = _historical_claim(
                row,
                field=(
                    f"history_rows[{index}]"
                ),
            )

            if claim.claim_id in target_ids:
                continue

            if (
                claim.created_at
                > scope.context_cutoff
            ):
                raise ValueError(
                    "Historical context crossed "
                    "the pinned cutoff."
                )

            history.append(
                claim
            )

        context_features = [
            _context_for_target(
                target,
                history=history,
                cutoff=(
                    scope.context_cutoff
                ),
            )
            for target in target_claims
        ]

        watermark = _stable_watermark(
            tenant_id=canonical_tenant_id,
            scope=scope,
            target_claims=target_claims,
            context_features=context_features,
        )

        logical_time = (
            scope.context_cutoff.isoformat()
        )

        return ProspectiveScoringSnapshot(
            tenant_id=canonical_tenant_id,
            tenant_slug=_optional_text(
                tenant.get(
                    "tenant_slug"
                )
            ),
            tenant_display_name=_optional_text(
                tenant.get(
                    "tenant_name"
                )
            ),
            detection_strategy_id=(
                scope.detection_strategy_id
            ),
            detection_strategy=(
                scope.strategy_type
            ),
            model_deployment_id=(
                scope.model_deployment_id
            ),
            captured_at=logical_time,
            context_cutoff_at=logical_time,
            watermark=watermark,
            source_job_ids=(
                scope.source_job_ids
            ),
            schemes=schemes,
            members=members,
            providers=providers,
            target_claims=target_claims,
            context_features=context_features,
        )
