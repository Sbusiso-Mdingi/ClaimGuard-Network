from __future__ import annotations

from .prospective_model_service import FEATURE_SCHEMA_VERSION

# Operational database migrations may evolve without changing the sealed
# predictor vector consumed by the deployed model. Add a version here only
# after verifying that the snapshot projection still produces exactly the
# same feature names, order, types, defaults, and formulas.
COMPATIBLE_OPERATIONAL_SCHEMA_VERSIONS = frozenset(
    {
        "14",
        "15",
    }
)


def supports_operational_schema(version: object) -> bool:
    """Return whether an operational schema preserves the sealed model contract."""
    return str(version or "").strip() in COMPATIBLE_OPERATIONAL_SCHEMA_VERSIONS


__all__ = [
    "COMPATIBLE_OPERATIONAL_SCHEMA_VERSIONS",
    "FEATURE_SCHEMA_VERSION",
    "supports_operational_schema",
]
