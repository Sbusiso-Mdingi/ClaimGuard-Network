from __future__ import annotations

from dataclasses import dataclass, field
from hashlib import sha256
from urllib.parse import parse_qs, quote, unquote, urlparse


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
    if ssl_mode in {"required", "require", "verify_ca", "verify_identity"}:
        options["ssl"] = {"check_hostname": ssl_mode == "verify_identity"}
    return options


def _parse_secret_reference(reference: str) -> tuple[str, str, str | None]:
    parsed = urlparse(reference)
    segments = [segment for segment in parsed.path.split("/") if segment]
    if parsed.scheme != "https" or not parsed.hostname or len(segments) not in {2, 3} or segments[0] != "secrets":
        raise DataPlaneRouteError("A private route contains an invalid Key Vault secret reference.")
    vault_url = f"{parsed.scheme}://{parsed.netloc}"
    return vault_url, segments[1], segments[2] if len(segments) == 3 else None


def _resolve_private_operational_url(
    *,
    secret_reference: str,
    expected_database_name: str | None,
    credential=None,
    secret_client_factory=None,
) -> str:
    references = [value.strip() for value in str(secret_reference or "").split(",") if value.strip()]
    if len(references) != 4:
        raise DataPlaneRouteError(
            "A private route must reference username, password, host, and database secrets."
        )

    if credential is None:
        try:
            from azure.identity import DefaultAzureCredential
        except ModuleNotFoundError as error:
            raise DataPlaneRouteError("azure-identity is required for private route resolution.") from error
        credential = DefaultAzureCredential()
    if secret_client_factory is None:
        try:
            from azure.keyvault.secrets import SecretClient
        except ModuleNotFoundError as error:
            raise DataPlaneRouteError("azure-keyvault-secrets is required for private route resolution.") from error
        secret_client_factory = SecretClient

    clients: dict[str, object] = {}
    values: list[str] = []
    for reference in references:
        vault_url, secret_name, secret_version = _parse_secret_reference(reference)
        client = clients.get(vault_url)
        if client is None:
            client = secret_client_factory(vault_url=vault_url, credential=credential)
            clients[vault_url] = client
        secret = client.get_secret(secret_name, version=secret_version)
        value = str(getattr(secret, "value", "") or "")
        if not value:
            raise DataPlaneRouteError("A private route secret resolved without a value.")
        values.append(value)

    username, password, host, database_name = values
    if expected_database_name and database_name != expected_database_name:
        raise DataPlaneRouteError("The private route database secret does not match the active route.")
    if not host or any(character in host for character in "/?#@"):
        raise DataPlaneRouteError("The private route database host is invalid.")
    return (
        f"mysql://{quote(username, safe='')}:{quote(password, safe='')}@{host}:3306/"
        f"{quote(database_name, safe='')}?ssl-mode=require"
    )


@dataclass(frozen=True)
class WorkerDataPlaneScope:
    organisation_ids: tuple[str, ...]
    tenant_ids: frozenset[str]
    route_keys: tuple[str, ...]
    schema_version: str
    route_type: str
    operational_url: str = field(repr=False)
    connection_fingerprint: str = field(repr=False)


def discover_active_worker_organisation_ids(
    *,
    control_plane_url: str,
    supported_schema_versions: frozenset[str] = frozenset({"10"}),
) -> tuple[str, ...]:
    if not supported_schema_versions:
        raise DataPlaneRouteError("At least one supported data-plane schema version is required.")
    import pymysql

    control = pymysql.connect(cursorclass=pymysql.cursors.DictCursor, **_connect_options(control_plane_url))
    try:
        with control.cursor() as cursor:
            placeholders = ",".join(["%s"] * len(supported_schema_versions))
            cursor.execute(
                f"""SELECT o.organisation_id
                    FROM organisations o
                    JOIN data_plane_routes r
                      ON r.organisation_id = o.organisation_id
                     AND r.active_route_slot = o.organisation_id
                    JOIN worker_routing_status w
                      ON w.organisation_id = o.organisation_id
                     AND w.worker_type = 'report-worker'
                    WHERE o.organisation_type = 'medical_scheme'
                      AND o.status = 'active' AND o.activation_state = 'activated'
                      AND r.route_type IN ('legacy_shared', 'private_database')
                      AND r.provisioning_status = 'active'
                      AND r.health_status NOT IN ('suspended', 'unreachable')
                      AND r.retired_at IS NULL
                      AND r.schema_version IN ({placeholders})
                      AND w.status = 'ready'
                    ORDER BY o.organisation_id""",
                sorted(supported_schema_versions),
            )
            rows = cursor.fetchall()
    finally:
        control.close()
    organisation_ids = tuple(str(row["organisation_id"]) for row in rows)
    if len(set(organisation_ids)) != len(organisation_ids):
        raise DataPlaneRouteError("Active report-worker organisation discovery returned duplicate routes.")
    return organisation_ids


def resolve_worker_data_plane_scope(
    *,
    control_plane_url: str,
    operational_url: str,
    organisation_ids: list[str],
    allowed_organisation_ids: frozenset[str] | None = None,
    environment_key: str = "legacy",
    private_environment_key: str = "production",
    supported_schema_versions: frozenset[str] = frozenset({"10"}),
    credential=None,
    secret_client_factory=None,
) -> WorkerDataPlaneScope:
    if len(organisation_ids) != 1:
        raise DataPlaneRouteError("Exactly one REPORT_WORKER_ORGANISATION_ID is required per worker instance.")
    if allowed_organisation_ids is None or organisation_ids[0] not in allowed_organisation_ids:
        raise DataPlaneRouteError("The report-worker organisation is outside the internal service identity scope.")
    import pymysql

    organisation_id = organisation_ids[0]
    control = pymysql.connect(cursorclass=pymysql.cursors.DictCursor, **_connect_options(control_plane_url))
    try:
        with control.cursor() as cursor:
            cursor.execute(
                "SELECT organisation_id, canonical_slug, status, activation_state "
                "FROM organisations WHERE organisation_id = %s LIMIT 1",
                [organisation_id],
            )
            organisation = cursor.fetchone()
            if not organisation or organisation["status"] != "active" or organisation["activation_state"] != "activated":
                raise DataPlaneRouteError("A report-worker organisation is inactive.")
            cursor.execute(
                """SELECT route_id, route_type, route_generation, logical_database_identifier, database_name,
                          secret_reference, schema_version, provisioning_status, health_status, retired_at
                   FROM data_plane_routes WHERE organisation_id = %s AND active_route_slot = organisation_id LIMIT 2""",
                [organisation_id],
            )
            routes = cursor.fetchall()
            if len(routes) != 1:
                raise DataPlaneRouteError("Exactly one active report-worker route is required.")
            route = routes[0]
            route_type = str(route["route_type"] or "")
            schema_version = str(route["schema_version"] or "")
            if (
                route_type not in {"legacy_shared", "private_database"}
                or route["provisioning_status"] != "active"
                or route["health_status"] in {"suspended", "unreachable"}
                or route["retired_at"] is not None
                or schema_version not in supported_schema_versions
            ):
                raise DataPlaneRouteError("The report-worker route is not active and compatible.")

            if route_type == "legacy_shared":
                if route["logical_database_identifier"] != "legacy-operational-shared":
                    raise DataPlaneRouteError("The legacy report-worker route has the wrong logical database identity.")
                selected_operational_url = operational_url
                operational_database = str(_connect_options(selected_operational_url)["database"])
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
                tenant_ids = frozenset({str(mappings[0]["legacy_tenant_id"])})
                expected_environment = environment_key
            else:
                if route["logical_database_identifier"] != f"private:{organisation_id}":
                    raise DataPlaneRouteError("The private report-worker route has the wrong logical database identity.")
                selected_operational_url = _resolve_private_operational_url(
                    secret_reference=str(route["secret_reference"] or ""),
                    expected_database_name=str(route["database_name"] or "") or None,
                    credential=credential,
                    secret_client_factory=secret_client_factory,
                )
                tenant_ids = frozenset({organisation_id})
                expected_environment = private_environment_key
    finally:
        control.close()

    operational = pymysql.connect(
        cursorclass=pymysql.cursors.DictCursor,
        **_connect_options(selected_operational_url),
    )
    try:
        with operational.cursor() as cursor:
            cursor.execute(
                """SELECT database_mode, logical_database_identifier, schema_version, environment_key, migration_version
                   FROM data_plane_metadata WHERE metadata_key = 'primary' LIMIT 1"""
            )
            metadata = cursor.fetchone()
            if (
                not metadata
                or metadata["database_mode"] != route_type
                or metadata["logical_database_identifier"] != route["logical_database_identifier"]
                or str(metadata["schema_version"]) != schema_version
                or metadata["environment_key"] != expected_environment
                or int(metadata["migration_version"]) != 10
            ):
                raise DataPlaneRouteError("Report-worker data-plane metadata verification failed.")
    finally:
        operational.close()

    route_key = f"{organisation_id}:{route['route_id']}:{route['route_generation']}"
    return WorkerDataPlaneScope(
        (organisation_id,),
        tenant_ids,
        (route_key,),
        schema_version,
        route_type,
        selected_operational_url,
        sha256(selected_operational_url.encode("utf-8")).hexdigest(),
    )
