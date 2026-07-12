"""
Builds deterministic synthetic investigator workflow artifacts for demo use.

These outputs do not change the producer/consumer architecture or detection
contracts. They simply provide realistic, fully synthetic investigation
outcomes (confirmed, under investigation, dismissed) that can be narrated in
demo flows and consumed by seed tooling.
"""
from __future__ import annotations

import json
from collections import defaultdict
from datetime import date
from pathlib import Path


INVESTIGATORS = [
    "Ava Ndlovu",
    "Thabo Mokoena",
    "Lerato Naidoo",
    "Daniel Jacobs",
    "Maya Petersen",
]


def _row_pick(claim_rows: list[dict], *, provider_id: str | None = None, member_id: str | None = None) -> dict | None:
    rows = claim_rows
    if provider_id is not None:
        rows = [row for row in rows if row.get("provider_id") == provider_id]
    if member_id is not None:
        rows = [row for row in rows if row.get("member_id") == member_id]
    if not rows:
        return None
    return sorted(rows, key=lambda row: (row.get("service_date", ""), row.get("claim_id", "")))[0]


def _member_label(member) -> str:
    return f"{member.first_name} {member.last_name}" if member else "Unknown Member"


def _provider_label(provider) -> str:
    return provider.practice_name if provider else "Unknown Provider"


def _new_case(case_index: int, *, investigator: str, scheme_id: str, scheme_name: str, provider_id: str | None, provider_name: str,
              member_ids: list[str], member_names: list[str], claim_id: str | None, scenario_type: str, evidence_summary: str,
              triggered_rules: list[str], status: str, final_decision: str | None, decision_date: str | None) -> dict:
    return {
        "investigation_id": f"INV-{case_index:04d}",
        "investigator": investigator,
        "scheme_id": scheme_id,
        "scheme": scheme_name,
        "provider_id": provider_id,
        "provider": provider_name,
        "members": member_ids,
        "member_names": member_names,
        "claim_id": claim_id,
        "scenario_type": scenario_type,
        "evidence_summary": evidence_summary,
        "triggered_rules": triggered_rules,
        "investigation_status": status,
        "final_decision": final_decision,
        "decision_date": decision_date,
        "synthetic": True,
    }


def build_investigation_reports(*, states: dict, ground_truth: dict, scheme_names: dict[str, str]) -> dict:
    members_by_scheme: dict[str, dict] = {
        sid: {member.member_id: member for member in state.members}
        for sid, state in states.items()
    }
    providers_by_scheme: dict[str, dict] = {
        sid: {provider.provider_id: provider for provider in state.providers}
        for sid, state in states.items()
    }

    single = sorted(
        ground_truth.get("single_scheme_fraud", []),
        key=lambda rec: (rec.get("scheme_id", ""), rec.get("archetype", ""), rec.get("entity_id", "")),
    )
    rings = sorted(
        ground_truth.get("collusion_rings", []),
        key=lambda rec: (rec.get("scheme_id", ""), rec.get("ring_provider", "")),
    )
    cross = sorted(
        ground_truth.get("cross_scheme_evasion", []),
        key=lambda rec: (rec.get("original", {}).get("provider_id", ""), rec.get("reappeared_as", {}).get("provider_id", "")),
    )

    cases: list[dict] = []
    case_index = 1

    upcoding_by_scheme = defaultdict(list)
    ghost_by_scheme = defaultdict(list)
    geo_by_scheme = defaultdict(list)
    demo_by_scheme = defaultdict(list)

    for rec in single:
        archetype = rec.get("archetype")
        scheme_id = rec.get("scheme_id")
        if archetype == "up_coding":
            upcoding_by_scheme[scheme_id].append(rec)
        elif archetype == "ghost_claiming":
            ghost_by_scheme[scheme_id].append(rec)
        elif archetype == "membership_substitution" and rec.get("variant") == "geographic":
            geo_by_scheme[scheme_id].append(rec)
        elif archetype == "membership_substitution" and rec.get("variant") == "demographic":
            demo_by_scheme[scheme_id].append(rec)

    # Confirmed fraud cases: one up-coding + one collusion ring per scheme.
    for scheme_id in sorted(states.keys()):
        scheme_name = scheme_names.get(scheme_id, scheme_id)
        investigator = INVESTIGATORS[(case_index - 1) % len(INVESTIGATORS)]

        if upcoding_by_scheme[scheme_id]:
            rec = upcoding_by_scheme[scheme_id][0]
            provider_id = rec["entity_id"]
            claim = _row_pick(states[scheme_id].claim_rows, provider_id=provider_id)
            member_id = claim.get("member_id") if claim else None
            member = members_by_scheme[scheme_id].get(member_id) if member_id else None
            provider = providers_by_scheme[scheme_id].get(provider_id)

            cases.append(
                _new_case(
                    case_index,
                    investigator=investigator,
                    scheme_id=scheme_id,
                    scheme_name=scheme_name,
                    provider_id=provider_id,
                    provider_name=_provider_label(provider),
                    member_ids=[member_id] if member_id else [],
                    member_names=[_member_label(member)] if member_id else [],
                    claim_id=claim.get("claim_id") if claim else None,
                    scenario_type="duplicate_billing_and_repeat_offender",
                    evidence_summary=(
                        "Provider pattern showed sustained high-value repeat billing relative to peers. "
                        "Linked claim cadence and repeated claimant touchpoints supported fraud confirmation."
                    ),
                    triggered_rules=["repeat_offenders", "unusually_connected_entities"],
                    status="CONFIRMED_FRAUD",
                    final_decision="Fraud confirmed",
                    decision_date=(claim.get("service_date") if claim else date.today().isoformat()),
                )
            )
            case_index += 1

        ring = next((rec for rec in rings if rec.get("scheme_id") == scheme_id), None)
        if ring:
            provider_id = ring["ring_provider"]
            member_ids = list(ring.get("ring_members", []))[:3]
            provider = providers_by_scheme[scheme_id].get(provider_id)
            member_names = [_member_label(members_by_scheme[scheme_id].get(mid)) for mid in member_ids]
            claim = _row_pick(states[scheme_id].claim_rows, provider_id=provider_id)

            cases.append(
                _new_case(
                    case_index,
                    investigator=INVESTIGATORS[(case_index - 1) % len(INVESTIGATORS)],
                    scheme_id=scheme_id,
                    scheme_name=scheme_name,
                    provider_id=provider_id,
                    provider_name=_provider_label(provider),
                    member_ids=member_ids,
                    member_names=member_names,
                    claim_id=claim.get("claim_id") if claim else None,
                    scenario_type="provider_member_collusion_ring",
                    evidence_summary=(
                        "A tight ring displayed repeated member-provider cycles with clustered values and "
                        "reused banking attributes. Circular relationship review met confirmation threshold."
                    ),
                    triggered_rules=["circular_relationships", "reused_bank_accounts", "shared_addresses"],
                    status="CONFIRMED_FRAUD",
                    final_decision="Fraud confirmed",
                    decision_date=(claim.get("service_date") if claim else date.today().isoformat()),
                )
            )
            case_index += 1

    # Under investigation: geographic substitution, demographic substitution, cross-scheme evasion.
    for scheme_id in sorted(states.keys()):
        scheme_name = scheme_names.get(scheme_id, scheme_id)
        investigator = INVESTIGATORS[(case_index - 1) % len(INVESTIGATORS)]

        if geo_by_scheme[scheme_id]:
            rec = geo_by_scheme[scheme_id][0]
            member_id = rec.get("entity_id")
            member = members_by_scheme[scheme_id].get(member_id)
            provider_ids = rec.get("provider_ids", [])
            provider = providers_by_scheme[scheme_id].get(provider_ids[0]) if provider_ids else None
            claim = _row_pick(states[scheme_id].claim_rows, member_id=member_id)

            cases.append(
                _new_case(
                    case_index,
                    investigator=investigator,
                    scheme_id=scheme_id,
                    scheme_name=scheme_name,
                    provider_id=provider_ids[0] if provider_ids else None,
                    provider_name=_provider_label(provider),
                    member_ids=[member_id] if member_id else [],
                    member_names=[_member_label(member)] if member_id else [],
                    claim_id=claim.get("claim_id") if claim else None,
                    scenario_type="impossible_treatment_timeline",
                    evidence_summary=(
                        f"Same-day treatment chain across distant providers (~{rec.get('distance_km', 'n/a')} km) "
                        "is under analyst review pending supporting documents."
                    ),
                    triggered_rules=["suspicious_relationship_chains", "shared_addresses"],
                    status="UNDER_INVESTIGATION",
                    final_decision=None,
                    decision_date=None,
                )
            )
            case_index += 1

        if demo_by_scheme[scheme_id]:
            rec = demo_by_scheme[scheme_id][0]
            member_id = rec.get("entity_id")
            member = members_by_scheme[scheme_id].get(member_id)
            provider_id = rec.get("provider_id")
            provider = providers_by_scheme[scheme_id].get(provider_id)
            claim = _row_pick(states[scheme_id].claim_rows, member_id=member_id, provider_id=provider_id)

            cases.append(
                _new_case(
                    case_index,
                    investigator=INVESTIGATORS[(case_index - 1) % len(INVESTIGATORS)],
                    scheme_id=scheme_id,
                    scheme_name=scheme_name,
                    provider_id=provider_id,
                    provider_name=_provider_label(provider),
                    member_ids=[member_id] if member_id else [],
                    member_names=[_member_label(member)] if member_id else [],
                    claim_id=claim.get("claim_id") if claim else None,
                    scenario_type="shared_device_and_demographic_anomaly",
                    evidence_summary=(
                        "Demographic code mismatch was detected alongside clustered artifact reuse in the "
                        "current graph snapshot; evidence collection remains in progress."
                    ),
                    triggered_rules=["shared_devices", "repeat_offenders"],
                    status="UNDER_INVESTIGATION",
                    final_decision=None,
                    decision_date=None,
                )
            )
            case_index += 1

    for rec in cross[:3]:
        source_scheme = rec.get("original", {}).get("scheme_id")
        target_scheme = rec.get("reappeared_as", {}).get("scheme_id")
        target_provider_id = rec.get("reappeared_as", {}).get("provider_id")
        state = states.get(target_scheme)
        claim = _row_pick(state.claim_rows, provider_id=target_provider_id) if state else None
        provider = providers_by_scheme.get(target_scheme, {}).get(target_provider_id)
        member_id = claim.get("member_id") if claim else None
        member = members_by_scheme.get(target_scheme, {}).get(member_id) if member_id else None

        cases.append(
            _new_case(
                case_index,
                investigator=INVESTIGATORS[(case_index - 1) % len(INVESTIGATORS)],
                scheme_id=target_scheme,
                scheme_name=scheme_names.get(target_scheme, target_scheme),
                provider_id=target_provider_id,
                provider_name=_provider_label(provider),
                member_ids=[member_id] if member_id else [],
                member_names=[_member_label(member)] if member_id else [],
                claim_id=claim.get("claim_id") if claim else None,
                scenario_type="cross_scheme_reappearance",
                evidence_summary=(
                    f"Provider reappeared from scheme {source_scheme} to {target_scheme} with preserved "
                    "banking and behavior fingerprints. Case is active pending final legal review."
                ),
                triggered_rules=["reused_bank_accounts", "circular_relationships"],
                status="UNDER_INVESTIGATION",
                final_decision=None,
                decision_date=None,
            )
        )
        case_index += 1

    # Dismissed: legitimate claims sampled from non-fraud entities.
    fraud_provider_ids = {rec.get("entity_id") for rec in single if rec.get("entity_type") == "provider"}
    fraud_provider_ids.update({rec.get("ring_provider") for rec in rings})
    fraud_member_ids = {rec.get("entity_id") for rec in single if rec.get("entity_type") == "member"}
    for ring in rings:
        fraud_member_ids.update(ring.get("ring_members", []))

    for scheme_id in sorted(states.keys()):
        scheme_name = scheme_names.get(scheme_id, scheme_id)
        legitimate_rows = [
            row
            for row in sorted(states[scheme_id].claim_rows, key=lambda item: (item.get("service_date", ""), item.get("claim_id", "")))
            if row.get("provider_id") not in fraud_provider_ids and row.get("member_id") not in fraud_member_ids
        ]
        for row in legitimate_rows[:2]:
            provider = providers_by_scheme[scheme_id].get(row.get("provider_id"))
            member = members_by_scheme[scheme_id].get(row.get("member_id"))
            cases.append(
                _new_case(
                    case_index,
                    investigator=INVESTIGATORS[(case_index - 1) % len(INVESTIGATORS)],
                    scheme_id=scheme_id,
                    scheme_name=scheme_name,
                    provider_id=row.get("provider_id"),
                    provider_name=_provider_label(provider),
                    member_ids=[row.get("member_id")],
                    member_names=[_member_label(member)],
                    claim_id=row.get("claim_id"),
                    scenario_type="legitimate_claim_review",
                    evidence_summary=(
                        "Documentation and treatment chronology were consistent with expected utilization. "
                        "No corroborating fraud indicators remained after review."
                    ),
                    triggered_rules=["none"],
                    status="DISMISSED",
                    final_decision="Fraud not confirmed",
                    decision_date=row.get("service_date"),
                )
            )
            case_index += 1

    summary = {
        "synthetic": True,
        "total_reports": len(cases),
        "status_breakdown": {
            "confirmed_fraud": len([c for c in cases if c["investigation_status"] == "CONFIRMED_FRAUD"]),
            "under_investigation": len([c for c in cases if c["investigation_status"] == "UNDER_INVESTIGATION"]),
            "dismissed": len([c for c in cases if c["investigation_status"] == "DISMISSED"]),
        },
    }

    return {
        "summary": summary,
        "reports": cases,
    }


def write_investigation_reports(path: str | Path, payload: dict) -> None:
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "w") as handle:
        json.dump(payload, handle, indent=2)


def write_investigation_markdown(path: str | Path, payload: dict) -> None:
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    reports = payload.get("reports", [])

    lines = [
        "# Synthetic Investigator Workflow Cases",
        "",
        "All entries in this file are synthetic and fictional, generated for ClaimGuard proof-of-concept demonstrations.",
        "",
        f"Total cases: {len(reports)}",
        f"- Confirmed fraud: {payload.get('summary', {}).get('status_breakdown', {}).get('confirmed_fraud', 0)}",
        f"- Under investigation: {payload.get('summary', {}).get('status_breakdown', {}).get('under_investigation', 0)}",
        f"- Dismissed: {payload.get('summary', {}).get('status_breakdown', {}).get('dismissed', 0)}",
        "",
        "## Cases",
        "",
    ]

    for report in reports:
        lines.extend(
            [
                f"### {report['investigation_id']} - {report['investigation_status']}",
                f"- Investigator: {report['investigator']}",
                f"- Scheme: {report['scheme']}",
                f"- Provider: {report['provider']}",
                f"- Members: {', '.join(report['member_names']) if report['member_names'] else 'None'}",
                f"- Scenario: {report['scenario_type']}",
                f"- Triggered rules: {', '.join(report['triggered_rules'])}",
                f"- Evidence summary: {report['evidence_summary']}",
                f"- Final decision: {report['final_decision'] or 'Pending'}",
                f"- Decision date: {report['decision_date'] or 'Pending'}",
                "",
            ]
        )

    with open(path, "w") as handle:
        handle.write("\n".join(lines))
