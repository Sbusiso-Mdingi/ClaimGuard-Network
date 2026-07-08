"""
Synthetic identifier generation.

IMPORTANT: every value produced here is randomly generated filler with no
link to any real person, account, or registry. `synthetic_id_number`
follows the *shape* of a South African ID number (13 digits, DOB-prefixed,
Luhn check digit) purely so downstream fields look internally consistent
in a demo — it is not, and must never be treated as, a real ID validator
or generator.
"""
from __future__ import annotations

import datetime as dt

import numpy as np

from .reference_data import BANK_NAMES


def _luhn_check_digit(digits: str) -> str:
    total = 0
    parity = len(digits) % 2
    for i, d in enumerate(digits):
        n = int(d)
        if i % 2 == parity:
            n *= 2
            if n > 9:
                n -= 9
        total += n
    return str((10 - (total % 10)) % 10)


def synthetic_sa_id_number(rng: np.random.Generator, date_of_birth: dt.date, is_female: bool) -> str:
    """13-digit, SA-ID-shaped synthetic string: YYMMDD SSSS C 8 Z."""
    yy = date_of_birth.strftime("%y")
    mm = date_of_birth.strftime("%m")
    dd = date_of_birth.strftime("%d")
    seq = rng.integers(0, 5000) if is_female else rng.integers(5000, 10000)
    citizenship = rng.integers(0, 2)
    body = f"{yy}{mm}{dd}{seq:04d}{citizenship}8"
    return body + _luhn_check_digit(body)


def synthetic_banking_detail(rng: np.random.Generator) -> str:
    bank = BANK_NAMES[rng.integers(0, len(BANK_NAMES))]
    account = "".join(str(d) for d in rng.integers(0, 10, size=10))
    return f"{bank}|{account}"


def synthetic_practice_number(rng: np.random.Generator) -> str:
    return "".join(str(d) for d in rng.integers(0, 10, size=7))


class SequentialId:
    """Simple monotonic counter for scheme-local or global IDs."""

    def __init__(self, prefix_template: str, start: int = 1):
        self.prefix_template = prefix_template  # e.g. "{scheme}-M{n:05d}"
        self._next = start

    def next(self, **kwargs) -> str:
        value = self.prefix_template.format(n=self._next, **kwargs)
        self._next += 1
        return value

    def peek_next_n(self) -> int:
        return self._next
