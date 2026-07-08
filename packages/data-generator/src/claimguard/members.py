"""
Member generation (spec §5 `Member`).

One addition beyond the literal spec schema: a `gender` column. It's not
in the spec's Member table, but it's needed for two things the spec *does*
ask for — gender-appropriate name generation, and the age/gender-inconsistent
variant of the membership-substitution fraud archetype (§7). Rather than
bury a gender inference inside the ID-number digits, it's an explicit,
visible column. Flagged here and in the data dictionary so it's easy to
drop if you'd rather stick to the exact schema.
"""
from __future__ import annotations

import datetime as dt
from dataclasses import dataclass

import numpy as np

from .config import RunContext
from .geography import Location, sample_location
from .identifiers import SequentialId, synthetic_banking_detail, synthetic_sa_id_number
from .reference_data import AGE_BANDS


@dataclass
class Member:
    member_id: str
    scheme_id: str
    first_name: str
    last_name: str
    date_of_birth: dt.date
    gender: str                    # "F" / "M" — extension beyond spec, see module docstring
    synthetic_id_number: str
    synthetic_banking_detail: str
    home_location: Location
    join_date: dt.date

    # --- derived helpers, not exported columns ---
    def age_on(self, reference: dt.date) -> int:
        return reference.year - self.date_of_birth.year - (
            (reference.month, reference.day) < (self.date_of_birth.month, self.date_of_birth.day)
        )

    def to_row(self) -> dict:
        return {
            "member_id": self.member_id,
            "scheme_id": self.scheme_id,
            "first_name": self.first_name,
            "last_name": self.last_name,
            "date_of_birth": self.date_of_birth.isoformat(),
            "gender": self.gender,
            "synthetic_id_number": self.synthetic_id_number,
            "synthetic_banking_detail": self.synthetic_banking_detail,
            "home_region": self.home_location.region,
            "home_lat": round(self.home_location.lat, 5),
            "home_lon": round(self.home_location.lon, 5),
            "join_date": self.join_date.isoformat(),
        }


def _sample_age(rng: np.random.Generator) -> int:
    shares = [b[2] for b in AGE_BANDS]
    idx = rng.choice(len(AGE_BANDS), p=shares)
    lo, hi, _, _ = AGE_BANDS[idx]
    return int(rng.integers(lo, hi + 1))


def _sample_dob(rng: np.random.Generator, reference_date: dt.date) -> dt.date:
    age = _sample_age(rng)
    year = reference_date.year - age
    month = int(rng.integers(1, 13))
    import calendar
    day = int(rng.integers(1, calendar.monthrange(year, month)[1] + 1))
    return dt.date(year, month, day)


def _sample_join_date(rng: np.random.Generator, window_start: dt.date, window_months: int) -> dt.date:
    """~85% joined before the window (long-standing members), ~15% join partway through."""
    if rng.random() < 0.85:
        days_before = int(rng.integers(0, 5 * 365))
        return window_start - dt.timedelta(days=days_before)
    else:
        # join partway through the window
        total_days = window_months * 30
        offset = int(rng.integers(0, total_days))
        return window_start + dt.timedelta(days=offset)


def generate_members(ctx: RunContext, scheme_id: str, n: int) -> list[Member]:
    rng = ctx.rng
    seq = SequentialId("{scheme}-M{n:05d}")
    members = []
    reference_date = ctx.config.start_date
    for _ in range(n):
        is_female = rng.random() < 0.5
        gender = "F" if is_female else "M"
        first_name = ctx.fake.first_name_female() if is_female else ctx.fake.first_name_male()
        last_name = ctx.fake.last_name()
        dob = _sample_dob(rng, reference_date)
        member = Member(
            member_id=seq.next(scheme=scheme_id),
            scheme_id=scheme_id,
            first_name=first_name,
            last_name=last_name,
            date_of_birth=dob,
            gender=gender,
            synthetic_id_number=synthetic_sa_id_number(rng, dob, is_female),
            synthetic_banking_detail=synthetic_banking_detail(rng),
            home_location=sample_location(rng, scatter_sigma_deg=0.12),
            join_date=_sample_join_date(rng, reference_date, ctx.config.num_months),
        )
        members.append(member)
    return members
