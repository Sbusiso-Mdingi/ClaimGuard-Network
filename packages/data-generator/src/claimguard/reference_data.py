"""
Static domain reference data: specialties, their billing-code "fingerprints",
severity baselines, geographic hub regions, and bank names.

These are hand-set, illustrative parameters (per spec §2 / §12 — Phase 1
does not fit distributions to real data, because there is no real data).
They're kept here rather than in generation_config.yaml because they're
domain reference tables, not run-to-run knobs — the things you'd tune
between runs (volumes, fraud counts, seed) live in the YAML; the things
that define "what a GP claim looks like" live here.
"""
from __future__ import annotations

import math
from dataclasses import dataclass


@dataclass(frozen=True)
class BillingCode:
    code: str
    description: str
    weight: float                      # relative frequency within its specialty
    gender_restriction: str | None = None   # "F", "M", or None
    min_age: int | None = None
    max_age: int | None = None


@dataclass(frozen=True)
class Specialty:
    name: str
    claim_share: float                 # this specialty's share of all claims, scheme-wide
    provider_share: float              # this specialty's share of the 250 providers
    severity_mu: float                 # log-normal mu for ln(amount), specialty baseline
    severity_sigma: float              # log-normal sigma for ln(amount)
    monthly_capacity_baseline: float   # baseline "plausible" claims/month for one provider
    codes: tuple[BillingCode, ...]

    @property
    def code_weights(self) -> dict[str, float]:
        return {c.code: c.weight for c in self.codes}

SPECIALTIES: dict[str, Specialty] = {
    "GP": Specialty(
        name="GP", claim_share=0.30, provider_share=0.28,
        severity_mu=math.log(450), severity_sigma=0.40,
        monthly_capacity_baseline=140,
        codes=(
            BillingCode("GP01", "Consultation - short", 0.35),
            BillingCode("GP02", "Consultation - standard", 0.30),
            BillingCode("GP03", "Consultation - extended", 0.15),
            BillingCode("GP04", "Wound care / dressing", 0.08),
            BillingCode("GP05", "Vaccination / injection", 0.07),
            BillingCode("GP06", "Paediatric wellness visit", 0.05, min_age=0, max_age=12),
        ),
    ),
    "Dentist": Specialty(
        name="Dentist", claim_share=0.10, provider_share=0.14,
        severity_mu=math.log(900), severity_sigma=0.50,
        monthly_capacity_baseline=90,
        codes=(
            BillingCode("DEN01", "Check-up & clean", 0.40),
            BillingCode("DEN02", "Filling", 0.25),
            BillingCode("DEN03", "Extraction", 0.12),
            BillingCode("DEN04", "Root canal", 0.08),
            BillingCode("DEN05", "X-ray", 0.10),
            BillingCode("DEN06", "Crown", 0.05),
        ),
    ),
    "Physiotherapist": Specialty(
        name="Physiotherapist", claim_share=0.08, provider_share=0.10,
        severity_mu=math.log(400), severity_sigma=0.35,
        monthly_capacity_baseline=110,
        codes=(
            BillingCode("PHY01", "Initial assessment", 0.20),
            BillingCode("PHY02", "Follow-up session", 0.55),
            BillingCode("PHY03", "Sports injury rehab", 0.15),
            BillingCode("PHY04", "Post-surgical rehab", 0.10),
        ),
    ),
    "Specialist": Specialty(
        name="Specialist", claim_share=0.15, provider_share=0.18,
        severity_mu=math.log(1500), severity_sigma=0.45,
        monthly_capacity_baseline=70,
        codes=(
            BillingCode("SPE01", "Consultation - new patient", 0.30),
            BillingCode("SPE02", "Consultation - follow-up", 0.35),
            BillingCode("SPE03", "Diagnostic procedure", 0.15),
            BillingCode("SPE04", "Minor surgical procedure", 0.08),
            BillingCode("SPE05", "Obstetric checkup", 0.06, gender_restriction="F", min_age=15, max_age=45),
            BillingCode("SPE06", "Prostate screening", 0.04, gender_restriction="M", min_age=40, max_age=95),
            BillingCode("SPE07", "Cardiology work-up", 0.02),
        ),
    ),
    "Pharmacy": Specialty(
        name="Pharmacy", claim_share=0.25, provider_share=0.18,
        severity_mu=math.log(350), severity_sigma=0.60,
        monthly_capacity_baseline=200,
        codes=(
            BillingCode("PHA01", "Acute medication dispensing", 0.45),
            BillingCode("PHA02", "Chronic medication dispensing", 0.35),
            BillingCode("PHA03", "Over-the-counter dispensing", 0.10),
            BillingCode("PHA04", "Vaccination dispensing", 0.05),
            BillingCode("PHA05", "Medical device / appliance", 0.05),
        ),
    ),
    "Optometrist": Specialty(
        name="Optometrist", claim_share=0.07, provider_share=0.08,
        severity_mu=math.log(1200), severity_sigma=0.50,
        monthly_capacity_baseline=65,
        codes=(
            BillingCode("OPT01", "Eye test", 0.45),
            BillingCode("OPT02", "Spectacle lenses", 0.30),
            BillingCode("OPT03", "Frames", 0.15),
            BillingCode("OPT04", "Contact lenses", 0.10),
        ),
    ),
    "Psychologist": Specialty(
        name="Psychologist", claim_share=0.05, provider_share=0.04,
        severity_mu=math.log(850), severity_sigma=0.30,
        monthly_capacity_baseline=55,
        codes=(
            BillingCode("PSY01", "Initial assessment", 0.20),
            BillingCode("PSY02", "Therapy session", 0.70),
            BillingCode("PSY03", "Psychometric testing", 0.10),
        ),
    ),
}

assert abs(sum(s.claim_share for s in SPECIALTIES.values()) - 1.0) < 1e-9
assert abs(sum(s.provider_share for s in SPECIALTIES.values()) - 1.0) < 1e-9

WORKING_DAYS_PER_MONTH = 22  # used to convert monthly_capacity_baseline -> a daily figure


# --- Age bands (drive claim frequency, per spec §6: "older members claim
#     slightly more often") ---------------------------------------------
# (min_age, max_age, population_share, monthly_poisson_lambda)
AGE_BANDS = [
    (0, 17, 0.10, 0.25),
    (18, 30, 0.20, 0.30),
    (31, 45, 0.25, 0.35),
    (46, 60, 0.25, 0.45),
    (61, 75, 0.15, 0.55),
    (76, 90, 0.05, 0.65),
]
# Weighted-average lambda works out to 0.40, matching §4's stated
# "~0.4 avg claims per active member per month".


def lambda_for_age(age: int) -> float:
    for lo, hi, _, lam in AGE_BANDS:
        if lo <= age <= hi:
            return lam
    return AGE_BANDS[-1][3] if age > AGE_BANDS[-1][1] else AGE_BANDS[0][3]


# --- Geographic hubs -----------------------------------------------------
# Real city centers used only as scatter points for synthetic members/
# providers; no real individuals or addresses are involved. Distances
# between hubs matter because the membership-substitution fraud archetype
# (§7) depends on genuinely-distant provider pairs existing in the data.
@dataclass(frozen=True)
class Region:
    name: str
    lat: float
    lon: float
    weight: float


REGIONS: tuple[Region, ...] = (
    Region("Johannesburg", -26.2041, 28.0473, 0.28),
    Region("Cape Town", -33.9249, 18.4241, 0.22),
    Region("Durban", -29.8587, 31.0218, 0.16),
    Region("Pretoria", -25.7479, 28.2293, 0.14),
    Region("Gqeberha", -33.9608, 25.6022, 0.10),
    Region("Bloemfontein", -29.0852, 26.1596, 0.10),
)

# Johannesburg <-> Pretoria are ~55km apart (neighbouring cities) — the one
# pair NOT safely over the 200km membership-substitution threshold. Every
# other region pair is comfortably >200km apart. Fraud injection filters on
# actual computed distance (see geography.py) rather than trusting this list
# blindly, but it's what makes that filtering fast rather than exhaustive.
CLOSE_REGION_PAIRS = {("Johannesburg", "Pretoria"), ("Pretoria", "Johannesburg")}

BANK_NAMES = [
    "FNB", "Standard Bank", "ABSA", "Nedbank", "Capitec", "Discovery Bank", "TymeBank",
]
