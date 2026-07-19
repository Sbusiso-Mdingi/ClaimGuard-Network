from __future__ import annotations

import math
from datetime import datetime


SUPPORTED_REPORT_CONTRACT_VERSIONS = {"1.0"}
FORBIDDEN_REPORT_FIELDS = {
    "firstname",
    "lastname",
    "dateofbirth",
    "identitynumber",
    "bankingdetail",
    "syntheticidnumber",
    "syntheticbankingdetail",
    "bankaccount",
    "email",
    "phone",
    "address",
    "ipaddress",
    "deviceid",
}


class ReportContractError(ValueError):
    pass


def _require_mapping(value: object, path: str) -> dict[str, object]:
    if not isinstance(value, dict):
        raise ReportContractError(f"{path} must be an object.")
    return value


def _require_list(value: object, path: str) -> list[object]:
    if not isinstance(value, list):
        raise ReportContractError(f"{path} must be an array.")
    return value


def _require_timestamp(value: object, path: str) -> None:
    if not isinstance(value, str) or not value.strip():
        raise ReportContractError(f"{path} must be an ISO timestamp.")
    try:
        datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError as error:
        raise ReportContractError(f"{path} must be an ISO timestamp.") from error


def _check_finite(value: object, path: str = "report") -> None:
    if isinstance(value, float) and not math.isfinite(value):
        raise ReportContractError(f"{path} contains a non-finite number.")
    if isinstance(value, dict):
        for key, item in value.items():
            _check_finite(item, f"{path}.{key}")
    elif isinstance(value, list):
        for index, item in enumerate(value):
            _check_finite(item, f"{path}[{index}]")


def _check_tenant_scope(value: object, expected_tenant_id: str, path: str = "report") -> None:
    if isinstance(value, dict):
        for key, item in value.items():
            if key in {"tenantId", "tenant_id"} and item != expected_tenant_id:
                raise ReportContractError(f"{path}.{key} is outside the canonical tenant scope.")
            _check_tenant_scope(item, expected_tenant_id, f"{path}.{key}")
    elif isinstance(value, list):
        for index, item in enumerate(value):
            _check_tenant_scope(item, expected_tenant_id, f"{path}[{index}]")


def _check_privacy(value: object, path: str = "report") -> None:
    if isinstance(value, dict):
        for key, item in value.items():
            normalized_key = "".join(character for character in key.lower() if character.isalnum())
            if normalized_key in FORBIDDEN_REPORT_FIELDS:
                raise ReportContractError(f"{path}.{key} is not permitted in a shared report artifact.")
            _check_privacy(item, f"{path}.{key}")
    elif isinstance(value, list):
        for index, item in enumerate(value):
            _check_privacy(item, f"{path}[{index}]")


def validate_detection_report(report: object, *, expected_tenant_id: str) -> dict[str, object]:
    root = _require_mapping(report, "report")
    version = root.get("contractVersion")
    if version not in SUPPORTED_REPORT_CONTRACT_VERSIONS:
        raise ReportContractError("The report contract version is unsupported.")

    metadata = _require_mapping(root.get("metadata"), "report.metadata")
    tenant = _require_mapping(metadata.get("tenant"), "report.metadata.tenant")
    if tenant.get("tenantId") != expected_tenant_id:
        raise ReportContractError("The report tenant does not match the publication partition.")
    report_id = metadata.get("reportId")
    if (
        not isinstance(report_id, str)
        or len(report_id) != 64
        or any(character not in "0123456789abcdef" for character in report_id)
    ):
        raise ReportContractError("report.metadata.reportId must be a lowercase 64-character hexadecimal digest.")
    _require_timestamp(metadata.get("generatedAt"), "report.metadata.generatedAt")
    _require_timestamp(metadata.get("snapshotCutoff"), "report.metadata.snapshotCutoff")
    source = _require_mapping(metadata.get("source"), "report.metadata.source")
    if not isinstance(source.get("watermark"), str) or not source["watermark"]:
        raise ReportContractError("report.metadata.source.watermark is required.")

    claims = _require_list(root.get("claims"), "report.claims")
    providers = _require_list(root.get("providers"), "report.providers")
    members = _require_list(root.get("members"), "report.members")
    summary = _require_mapping(root.get("summary"), "report.summary")
    included = _require_mapping(metadata.get("includedCounts"), "report.metadata.includedCounts")
    expected_counts = {"claims": len(claims), "providers": len(providers), "members": len(members)}
    if included != expected_counts or summary.get("totalClaims") != len(claims):
        raise ReportContractError("Report aggregate counts do not match the canonical entity arrays.")
    total_amount = 0.0
    for index, item in enumerate(claims):
        claim = _require_mapping(item, f"report.claims[{index}]")
        for identifier in ("claimId", "providerId", "memberId", "schemeId"):
            if not isinstance(claim.get(identifier), str) or not claim[identifier].strip():
                raise ReportContractError(f"report.claims[{index}].{identifier} is required.")
        amount = claim.get("amount")
        if isinstance(amount, bool) or not isinstance(amount, (int, float)) or not math.isfinite(float(amount)):
            raise ReportContractError(f"report.claims[{index}].amount must be a finite number.")
        total_amount += float(amount)
    summary_total = summary.get("totalClaimedAmount")
    if (
        isinstance(summary_total, bool)
        or not isinstance(summary_total, (int, float))
        or not math.isfinite(float(summary_total))
        or float(summary_total) != round(total_amount, 2)
    ):
        raise ReportContractError("Report total claimed amount is inconsistent.")

    for index, item in enumerate(providers):
        provider = _require_mapping(item, f"report.providers[{index}]")
        if not isinstance(provider.get("providerId"), str) or not provider["providerId"].strip():
            raise ReportContractError(f"report.providers[{index}].providerId is required.")
    for index, item in enumerate(members):
        member = _require_mapping(item, f"report.members[{index}]")
        if not isinstance(member.get("memberId"), str) or not member["memberId"].strip():
            raise ReportContractError(f"report.members[{index}].memberId is required.")

    graph = _require_mapping(root.get("graph"), "report.graph")
    nodes = _require_list(graph.get("nodes"), "report.graph.nodes")
    edges = _require_list(graph.get("edges"), "report.graph.edges")
    node_ids: set[str] = set()
    for index, item in enumerate(nodes):
        node = _require_mapping(item, f"report.graph.nodes[{index}]")
        node_id = node.get("entity_id")
        if not isinstance(node_id, str) or not node_id.strip():
            raise ReportContractError(f"report.graph.nodes[{index}].entity_id is required.")
        node_ids.add(node_id)
    for edge in edges:
        relationship = _require_mapping(edge, "report.graph.edges[]")
        if str(relationship.get("source_entity_id")) not in node_ids or str(
            relationship.get("target_entity_id")
        ) not in node_ids:
            raise ReportContractError("Report graph contains an edge with an unknown node.")

    _require_mapping(root.get("risk"), "report.risk")
    _require_mapping(root.get("history"), "report.history")
    _check_finite(root)
    _check_tenant_scope(root, expected_tenant_id)
    _check_privacy(root)
    return root
