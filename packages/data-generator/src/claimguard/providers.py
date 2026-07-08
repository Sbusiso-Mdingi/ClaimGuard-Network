"""
Provider generation (spec §5 `Provider`).

Beyond the exported columns, each Provider carries three *internal*
generation parameters that never get written to providers.csv (the spec's
Provider schema doesn't list them) but drive claims.py and the fraud
modules:

- `billing_fingerprint`: a probability vector over that provider's
  specialty's billing codes, individually perturbed from the specialty
  baseline. This is the "characteristic fingerprint" spec §6 asks for,
  and it's what the up-coding archetype leaves untouched and the
  cross-scheme evasion mechanic (§8) deliberately carries forward.
- `severity_avg`: this provider's own average claim amount (used to
  derive their personal log-normal mu). Up-coding fraud overrides this
  directly. Peer mean/SD for the "2.5-4 SD above peer mean" rule (§7)
  are computed from the *non-fraud* providers in the same specialty.
- `capacity_weight`: individual busier/quieter multiplier used when
  claims.py decides which provider (within a specialty, near a member)
  absorbs a given claim.

`active_from_month` / `active_until_month` (1-indexed, inclusive) default
to the full run and are only narrowed by the cross-scheme evasion
mechanic (the exited original's `active_until_month`, the reappeared
identity's `active_from_month`).
"""
from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np

from .config import RunContext
from .geography import Location, sample_location
from .identifiers import SequentialId, synthetic_banking_detail, synthetic_practice_number
from .reference_data import SPECIALTIES, Specialty

FINGERPRINT_CONCENTRATION = 50.0   # individual variation around specialty base fingerprint
PEER_AVG_CV = 0.15                 # provider-to-provider variation in average claim amount


@dataclass
class Provider:
    provider_id: str
    scheme_id: str
    practice_number: str
    specialty: str
    practice_name: str
    synthetic_banking_detail: str
    practice_location: Location

    # internal generation parameters (not exported to providers.csv)
    billing_fingerprint: dict = field(repr=False, default_factory=dict)
    severity_avg: float = field(repr=False, default=0.0)
    capacity_weight: float = field(repr=False, default=1.0)
    active_from_month: int = field(repr=False, default=1)
    active_until_month: int = field(repr=False, default=9999)

    def severity_mu_sigma(self) -> tuple[float, float]:
        import math
        spec = SPECIALTIES[self.specialty]
        mu = math.log(max(self.severity_avg, 1.0)) - (spec.severity_sigma ** 2) / 2
        return mu, spec.severity_sigma

    def to_row(self) -> dict:
        return {
            "provider_id": self.provider_id,
            "scheme_id": self.scheme_id,
            "practice_number": self.practice_number,
            "specialty": self.specialty,
            "practice_name": self.practice_name,
            "synthetic_banking_detail": self.synthetic_banking_detail,
            "practice_region": self.practice_location.region,
            "practice_lat": round(self.practice_location.lat, 5),
            "practice_lon": round(self.practice_location.lon, 5),
        }


_PRACTICE_NAME_TEMPLATES = {
    "GP": "{name} Family Practice",
    "Dentist": "{name} Dental Practice",
    "Physiotherapist": "{name} Physiotherapy",
    "Specialist": "{name} Specialist Centre",
    "Pharmacy": "{name} Pharmacy",
    "Optometrist": "{name} Optometrists",
    "Psychologist": "{name} Psychology Practice",
}


def generate_practice_name(rng: np.random.Generator, fake, specialty: str) -> str:
    surname = fake.last_name()
    template = _PRACTICE_NAME_TEMPLATES.get(specialty, "{name} Practice")
    return template.format(name=surname)


def _sample_specialty(rng: np.random.Generator) -> Specialty:
    names = list(SPECIALTIES.keys())
    weights = [SPECIALTIES[n].provider_share for n in names]
    idx = rng.choice(len(names), p=weights)
    return SPECIALTIES[names[idx]]


def _draw_fingerprint(rng: np.random.Generator, spec: Specialty, concentration: float,
                       center: np.ndarray | None = None) -> dict:
    codes = [c.code for c in spec.codes]
    if center is None:
        center = np.array([spec.code_weights[c] for c in codes])
    alpha = np.clip(center * concentration, 1e-3, None)
    weights = rng.dirichlet(alpha)
    return dict(zip(codes, weights))


def _draw_severity_avg(rng: np.random.Generator, spec: Specialty) -> float:
    import math
    baseline = math.exp(spec.severity_mu + spec.severity_sigma ** 2 / 2)
    draw = rng.normal(baseline, baseline * PEER_AVG_CV)
    return float(max(draw, baseline * 0.3))


def generate_providers(ctx: RunContext, scheme_id: str, n: int) -> list[Provider]:
    rng = ctx.rng
    seq = SequentialId("{scheme}-P{n:04d}")
    providers = []
    for _ in range(n):
        spec = _sample_specialty(rng)
        provider = Provider(
            provider_id=seq.next(scheme=scheme_id),
            scheme_id=scheme_id,
            practice_number=synthetic_practice_number(rng),
            specialty=spec.name,
            practice_name=generate_practice_name(rng, ctx.fake, spec.name),
            synthetic_banking_detail=synthetic_banking_detail(rng),
            practice_location=sample_location(rng, scatter_sigma_deg=0.08),
            billing_fingerprint=_draw_fingerprint(rng, spec, FINGERPRINT_CONCENTRATION),
            severity_avg=_draw_severity_avg(rng, spec),
            capacity_weight=float(rng.lognormal(0, 0.3)),
        )
        providers.append(provider)
    return providers


def next_provider_id_start(existing_providers: list[Provider]) -> int:
    """Highest numeric suffix already used, so evasion-reappeared providers
    get fresh, non-colliding IDs appended after the base pool."""
    max_n = 0
    for p in existing_providers:
        try:
            n = int(p.provider_id.split("P")[-1])
            max_n = max(max_n, n)
        except ValueError:
            continue
    return max_n + 1
