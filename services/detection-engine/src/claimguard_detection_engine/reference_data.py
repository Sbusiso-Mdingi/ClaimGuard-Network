"""Static reference data for Phase 4 detection logic."""

from __future__ import annotations

import math
from dataclasses import dataclass


@dataclass(frozen=True)
class BillingCode:
    code: str
    description: str
    weight: float
    gender_restriction: str | None = None
    min_age: int | None = None
    max_age: int | None = None


@dataclass(frozen=True)
class Specialty:
    name: str
    claim_share: float
    provider_share: float
    severity_mu: float
    severity_sigma: float
    monthly_capacity_baseline: float
    codes: tuple[BillingCode, ...]

    @property
    def code_weights(self) -> dict[str, float]:
        return {code.code: code.weight for code in self.codes}


SPECIALTIES: dict[str, Specialty] = {
    "GP": Specialty(
        name="GP",
        claim_share=0.30,
        provider_share=0.28,
        severity_mu=math.log(450),
        severity_sigma=0.40,
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
        name="Dentist",
        claim_share=0.10,
        provider_share=0.14,
        severity_mu=math.log(900),
        severity_sigma=0.50,
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
        name="Physiotherapist",
        claim_share=0.08,
        provider_share=0.10,
        severity_mu=math.log(400),
        severity_sigma=0.35,
        monthly_capacity_baseline=110,
        codes=(
            BillingCode("PHY01", "Initial assessment", 0.20),
            BillingCode("PHY02", "Follow-up session", 0.55),
            BillingCode("PHY03", "Sports injury rehab", 0.15),
            BillingCode("PHY04", "Post-surgical rehab", 0.10),
        ),
    ),
    "Specialist": Specialty(
        name="Specialist",
        claim_share=0.15,
        provider_share=0.18,
        severity_mu=math.log(1500),
        severity_sigma=0.45,
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
        name="Pharmacy",
        claim_share=0.25,
        provider_share=0.18,
        severity_mu=math.log(350),
        severity_sigma=0.60,
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
        name="Optometrist",
        claim_share=0.07,
        provider_share=0.08,
        severity_mu=math.log(1200),
        severity_sigma=0.50,
        monthly_capacity_baseline=65,
        codes=(
            BillingCode("OPT01", "Eye test", 0.45),
            BillingCode("OPT02", "Spectacle lenses", 0.30),
            BillingCode("OPT03", "Frames", 0.15),
            BillingCode("OPT04", "Contact lenses", 0.10),
        ),
    ),
    "Psychologist": Specialty(
        name="Psychologist",
        claim_share=0.05,
        provider_share=0.04,
        severity_mu=math.log(850),
        severity_sigma=0.30,
        monthly_capacity_baseline=55,
        codes=(
            BillingCode("PSY01", "Initial assessment", 0.20),
            BillingCode("PSY02", "Therapy session", 0.70),
            BillingCode("PSY03", "Psychometric testing", 0.10),
        ),
    ),
}

CODE_LOOKUP = {code.code: code for specialty in SPECIALTIES.values() for code in specialty.codes}
