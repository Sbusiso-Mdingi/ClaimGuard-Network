"""
Config loading + reproducible randomness setup.

Everything that touches randomness in this generator pulls its Generator
from here, and there is exactly one place (`build_rng`) where the seed
is applied to both numpy and Faker. Keeping it centralized is what makes
the "identical output given the same seed" acceptance criterion (spec §13)
actually hold.
"""
from __future__ import annotations

import datetime as dt
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional

import numpy as np
import yaml
from faker import Faker


@dataclass
class SchemeConfig:
    id: str
    name: str


@dataclass
class Config:
    seed: int
    locale: str
    currency_symbol: str
    schemes: list[SchemeConfig]
    members_per_scheme: int
    providers_per_scheme: int
    start_date: dt.date
    num_months: int
    avg_claims_per_active_member_per_month: float
    fraud: dict
    cross_scheme_evasion: dict
    data_dir: Path
    raw: dict = field(repr=False, default_factory=dict)  # original parsed yaml, for provenance copy
    _config_source_path: Path = field(repr=False, default=None)

    @property
    def scheme_ids(self) -> list[str]:
        return [s.id for s in self.schemes]


def load_config(path: str | Path) -> Config:
    path = Path(path)
    with open(path, "r") as f:
        raw = yaml.safe_load(f)

    schemes = [SchemeConfig(id=s["id"], name=s["name"]) for s in raw["schemes"]]
    start_date = dt.date.fromisoformat(raw["time"]["start_date"])

    return Config(
        seed=raw["seed"],
        locale=raw.get("locale", "en_US"),
        currency_symbol=raw.get("currency_symbol", "$"),
        schemes=schemes,
        members_per_scheme=raw["volumes"]["members_per_scheme"],
        providers_per_scheme=raw["volumes"]["providers_per_scheme"],
        start_date=start_date,
        num_months=raw["time"]["num_months"],
        avg_claims_per_active_member_per_month=raw["claims"]["avg_claims_per_active_member_per_month"],
        fraud=raw["fraud"],
        cross_scheme_evasion=raw["cross_scheme_evasion"],
        data_dir=Path(raw["output"]["data_dir"]),
        raw=raw,
        _config_source_path=path,
    )


class RunContext:
    """
    Bundles the seeded numpy Generator and a seeded Faker instance so every
    module draws randomness from the same, explicitly-passed source rather
    than global state. Pass this one object around instead of a bare seed.
    """

    def __init__(self, config: Config):
        self.config = config
        self.rng: np.random.Generator = np.random.default_rng(config.seed)
        # Faker's *instance* seeding (not the deprecated global Faker.seed)
        # keeps this reproducible regardless of what else touches Faker.
        self.fake = Faker(config.locale)
        self.fake.seed_instance(config.seed)

    def month_start(self, month_index: int) -> dt.date:
        """month_index is 1-based (1..num_months)."""
        return _add_months(self.config.start_date, month_index - 1)

    def month_date_range(self, month_index: int) -> tuple[dt.date, dt.date]:
        import calendar
        start = self.month_start(month_index)
        last_day = calendar.monthrange(start.year, start.month)[1]
        return start, start.replace(day=last_day)

    def random_date_in_month(self, month_index: int) -> dt.date:
        start, end = self.month_date_range(month_index)
        span = (end - start).days
        offset = int(self.rng.integers(0, span + 1))
        return start + dt.timedelta(days=offset)


def _add_months(date: dt.date, n: int) -> dt.date:
    import calendar
    month_index = date.month - 1 + n
    year = date.year + month_index // 12
    month = month_index % 12 + 1
    day = min(date.day, calendar.monthrange(year, month)[1])
    return date.replace(year=year, month=month, day=day)
