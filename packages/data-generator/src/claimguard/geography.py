"""
Location scatter + distance calculations.

Members and providers are scattered in small clusters around a handful of
real city centers (see reference_data.REGIONS). Cluster spread is ~10km;
distances between hub cities are hundreds of km. That gap is what makes
the membership-substitution fraud check (">200km apart same day") a clean,
unambiguous signal rather than a fuzzy one.
"""
from __future__ import annotations

import math
from dataclasses import dataclass

import numpy as np

from .reference_data import REGIONS, Region


@dataclass(frozen=True)
class Location:
    region: str
    lat: float
    lon: float


def haversine_km(a: Location, b: Location) -> float:
    R = 6371.0
    lat1, lon1, lat2, lon2 = map(math.radians, (a.lat, a.lon, b.lat, b.lon))
    dlat = lat2 - lat1
    dlon = lon2 - lon1
    h = math.sin(dlat / 2) ** 2 + math.cos(lat1) * math.cos(lat2) * math.sin(dlon / 2) ** 2
    return 2 * R * math.asin(math.sqrt(h))


def sample_region(rng: np.random.Generator) -> Region:
    weights = [r.weight for r in REGIONS]
    idx = rng.choice(len(REGIONS), p=weights)
    return REGIONS[idx]


def sample_location(rng: np.random.Generator, scatter_sigma_deg: float = 0.10) -> Location:
    region = sample_region(rng)
    lat = region.lat + rng.normal(0, scatter_sigma_deg)
    lon = region.lon + rng.normal(0, scatter_sigma_deg)
    return Location(region=region.name, lat=lat, lon=lon)
