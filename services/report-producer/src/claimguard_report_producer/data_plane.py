from __future__ import annotations

from dataclasses import dataclass
from urllib.parse import parse_qs, unquote, urlparse


class DataPlaneRouteError(RuntimeError):
    pass


def _connect_options(database_url: str) -> dict[str, object]:
    parsed = urlparse(database_url)
    if parsed.scheme not in {"mysql", "mysql+pymysql"} or not parsed.hostname or not parsed.path.strip("/"):
        raise DataPlaneRouteError("A complete MySQL database URL is required for explicit route resolution.")
    query = parse_qs(parsed.query)
    ssl_mode = (query.get("ssl-mode") or query.get("ssl_mode") or [""])[0].lower()
    options: dict[str, object] = {
        "host": parsed.hostname,
        "port": parsed.port or 3306,
        "user": unquote(parsed.username or ""),
        "password": unquote(parsed.password or ""),
        "database": unquote(parsed.path.lstrip("/")),
        "charset": "utf8mb4",
        "autocommit": True,
    }
    if ssl_mode in {"required", "verify_ca", "verify_identity"}:
        options["ssl"] = {"check_hostname": ssl_mode == "verify_identity"}
    return options


@dataclass(frozen=True)
class WorkerDataPlaneScope:
    organisation_ids: tuple[str, ...]
    tenant_ids: frozenset[str]
    route_keys: tuple[str, ...]
    schema_version: str


def resolve_worker_data_plane_scope(
    *, control_plane_url: str, operational_url: str, organisation_ids: list[str],
    allowed_organisation_ids: frozenset[str] | None = None, environment_key: str = "legacy"
) -> WorkerDataPlaneScope:
    if len(organisation_ids) != 1:
        raise DataPlaneRouteError("Exactly one REPORT_WORKER_ORGANISATION_ID is required per worker instance.")
    if allowed_organisation_ids is None or organisation_ids[0] not in allowed_organisation_ids:
        raise DataPlaneRouteError("The report-worker organisation is outside the internal service identity scope.")
    import pymysql

    control = pymysql.connect(cursorclass=pymysql.cursors.DictCursor, **_connect_options(control_plane_url))
    tenant_ids: set[str] = set()
    route_keys: list[str] = []
    try:
        with control.cursor() as cursor:
            for organisation_id in organisation_ids:
                cursor.execute(
                    "SELECT organisation_id, status, activation_state FROM organisations WHERE organisation_id = %s LIMIT 1",
                    [organisation_id],
                )
                organisation = cursor.fetchone()
                if not organisation or organisation["status"] != "active" or organisation["activation_state"] != "activated":
                    raise DataPlaneRouteError("A report-worker organisation is inactive.")
                cursor.execute(
                    """SELECT route_id, route_type, route_generation, logical_database_identifier, database_name,
                              schema_version, provisioning_status, health_status, retired_at
                       FROM data_plane_routes WHERE organisation_id = %s AND active_route_slot = organisation_id LIMIT 2""",
                    [organisation_id],
                )
                routes = cursor.fetchall()
                if len(routes) != 1:
                    raise DataPlaneRouteError("Exactly one active report-worker route is required.")
                route = routes[0]
                if (
                    route["route_type"] != "legacy_shared"
                    or route["provisioning_status"] != "active"
                    or route["health_status"] in {"suspended", "unreachable"}
                    or route["retired_at"] is not None
                    or str(route["schema_version"] or "") != "8"
                    or route["logical_database_identifier"] != "legacy-operational-shared"
                ):
                    raise DataPlaneRouteError("The report-worker route is not an active compatible legacy_shared route.")
                operational_database = str(_connect_options(operational_url)["database"])
                if route["database_name"] and route["database_name"] != operational_database:
                    raise DataPlaneRouteError("The report-worker operational database does not match its active route.")
                cursor.execute(
                    """SELECT legacy_tenant_id, migration_status, route_id, verified_at
                       FROM legacy_tenant_mappings WHERE organisation_id = %s LIMIT 2""",
                    [organisation_id],
                )
                mappings = cursor.fetchall()
                if len(mappings) != 1 or mappings[0]["migration_status"] != "verified" or not mappings[0]["verified_at"]:
                    raise DataPlaneRouteError("A verified report-worker legacy tenant mapping is required.")
                if mappings[0]["route_id"] != route["route_id"]:
                    raise DataPlaneRouteError("The report-worker mapping and route do not match.")
                tenant_ids.add(str(mappings[0]["legacy_tenant_id"]))
                route_keys.append(f"{organisation_id}:{route['route_id']}:{route['route_generation']}")
    finally:
        control.close()

    operational = pymysql.connect(cursorclass=pymysql.cursors.DictCursor, **_connect_options(operational_url))
    try:
        with operational.cursor() as cursor:
            cursor.execute(
                """SELECT database_mode, logical_database_identifier, schema_version, environment_key, migration_version
                   FROM data_plane_metadata WHERE metadata_key = 'primary' LIMIT 1"""
            )
            metadata = cursor.fetchone()
            if (
                not metadata
                or metadata["database_mode"] != "legacy_shared"
                or metadata["logical_database_identifier"] != "legacy-operational-shared"
                or str(metadata["schema_version"]) != "8"
                or metadata["environment_key"] != environment_key
                or int(metadata["migration_version"]) != 8
            ):
                raise DataPlaneRouteError("Report-worker data-plane metadata verification failed.")
    finally:
        operational.close()

    return WorkerDataPlaneScope(tuple(organisation_ids), frozenset(tenant_ids), tuple(route_keys), "8")
