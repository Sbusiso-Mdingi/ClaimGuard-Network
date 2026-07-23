from __future__ import annotations

from dataclasses import dataclass, field
from hashlib import sha256
from typing import Iterable
from urllib.parse import (
    parse_qs,
    quote,
    unquote,
    urlparse,
)


DEFAULT_SUPPORTED_SCHEMA_VERSIONS = frozenset(
    {
        "14",
    }
)

_SUPPORTED_ROUTE_TYPES = frozenset(
    {
        "legacy_shared",
        "private_database",
    }
)

_UNUSABLE_ROUTE_HEALTH_STATUSES = frozenset(
    {
        "suspended",
        "unreachable",
    }
)


class DataPlaneRouteError(RuntimeError):
    code = "DATA_PLANE_ROUTE_INVALID"


def _required_text(
    value: object,
    *,
    field: str,
    maximum: int | None = None,
) -> str:
    rendered = str(
        value or ""
    ).strip()

    if not rendered:
        raise DataPlaneRouteError(
            f"{field} is required."
        )

    if (
        maximum is not None
        and len(rendered) > maximum
    ):
        raise DataPlaneRouteError(
            f"{field} must not exceed "
            f"{maximum} characters."
        )

    return rendered


def _normalise_schema_versions(
    values: Iterable[object],
) -> frozenset[str]:
    normalised: set[str] = set()

    for raw_value in values:
        rendered = str(
            raw_value or ""
        ).strip()

        if not rendered:
            continue

        if (
            not rendered.isdigit()
            or int(rendered) <= 0
            or str(int(rendered)) != rendered
        ):
            raise DataPlaneRouteError(
                "Supported data-plane schema versions "
                "must be canonical positive integers."
            )

        normalised.add(
            rendered
        )

    if not normalised:
        raise DataPlaneRouteError(
            "At least one supported data-plane "
            "schema version is required."
        )

    return frozenset(
        normalised
    )


def _expected_migration_version(
    schema_version: str,
) -> int:
    if (
        not schema_version.isdigit()
        or int(schema_version) <= 0
        or str(int(schema_version))
        != schema_version
    ):
        raise DataPlaneRouteError(
            "The active route has an invalid "
            "schema version."
        )

    return int(
        schema_version
    )


def _connect_options(
    database_url: str,
) -> dict[str, object]:
    rendered_url = _required_text(
        database_url,
        field="database URL",
    )

    parsed = urlparse(
        rendered_url
    )

    if parsed.scheme not in {
        "mysql",
        "mysql+pymysql",
    }:
        raise DataPlaneRouteError(
            "A MySQL database URL is required "
            "for explicit route resolution."
        )

    if not parsed.hostname:
        raise DataPlaneRouteError(
            "The database URL must include a host."
        )

    database_name = unquote(
        parsed.path.lstrip(
            "/"
        )
    ).strip()

    if not database_name:
        raise DataPlaneRouteError(
            "The database URL must include "
            "a database name."
        )

    query = parse_qs(
        parsed.query
    )

    ssl_mode = str(
        (
            query.get(
                "ssl-mode"
            )
            or query.get(
                "ssl_mode"
            )
            or [""]
        )[0]
    ).strip().lower()

    options: dict[
        str,
        object,
    ] = {
        "host":
            parsed.hostname,

        "port":
            parsed.port or 3306,

        "user":
            unquote(
                parsed.username
                or ""
            ),

        "password":
            unquote(
                parsed.password
                or ""
            ),

        "database":
            database_name,

        "charset":
            "utf8mb4",

        "autocommit":
            True,

        "connect_timeout":
            15,

        "read_timeout":
            60,

        "write_timeout":
            60,
    }

    if ssl_mode in {
        "required",
        "require",
        "verify_ca",
        "verify_identity",
    }:
        options["ssl"] = {
            "check_hostname":
                ssl_mode
                == "verify_identity",
        }

    return options


def _parse_secret_reference(
    reference: str,
) -> tuple[
    str,
    str,
    str | None,
]:
    parsed = urlparse(
        _required_text(
            reference,
            field="secret reference",
        )
    )

    segments = [
        segment
        for segment in parsed.path.split(
            "/"
        )
        if segment
    ]

    if (
        parsed.scheme != "https"
        or not parsed.hostname
        or len(segments)
        not in {
            2,
            3,
        }
        or segments[0] != "secrets"
    ):
        raise DataPlaneRouteError(
            "A private route contains an invalid "
            "Key Vault secret reference."
        )

    secret_name = _required_text(
        segments[1],
        field="secret name",
        maximum=127,
    )

    secret_version = (
        _required_text(
            segments[2],
            field="secret version",
            maximum=64,
        )
        if len(segments) == 3
        else None
    )

    vault_url = (
        f"{parsed.scheme}://"
        f"{parsed.netloc}"
    )

    return (
        vault_url,
        secret_name,
        secret_version,
    )


def _resolve_private_operational_url(
    *,
    secret_reference: str,
    expected_database_name: str | None,
    credential=None,
    secret_client_factory=None,
) -> str:
    references = [
        value.strip()
        for value in str(
            secret_reference
            or ""
        ).split(",")
        if value.strip()
    ]

    if len(references) != 4:
        raise DataPlaneRouteError(
            "A private route must reference "
            "username, password, host, and "
            "database secrets."
        )

    if credential is None:
        try:
            from azure.identity import (
                DefaultAzureCredential,
            )
        except ModuleNotFoundError as error:
            raise DataPlaneRouteError(
                "azure-identity is required for "
                "private route resolution."
            ) from error

        credential = (
            DefaultAzureCredential()
        )

    if secret_client_factory is None:
        try:
            from azure.keyvault.secrets import (
                SecretClient,
            )
        except ModuleNotFoundError as error:
            raise DataPlaneRouteError(
                "azure-keyvault-secrets is required "
                "for private route resolution."
            ) from error

        secret_client_factory = (
            SecretClient
        )

    clients: dict[
        str,
        object,
    ] = {}

    values: list[
        str
    ] = []

    for reference in references:
        (
            vault_url,
            secret_name,
            secret_version,
        ) = _parse_secret_reference(
            reference
        )

        client = clients.get(
            vault_url
        )

        if client is None:
            client = secret_client_factory(
                vault_url=vault_url,
                credential=credential,
            )

            clients[
                vault_url
            ] = client

        try:
            secret = client.get_secret(
                secret_name,
                version=secret_version,
            )
        except Exception as error:
            raise DataPlaneRouteError(
                "A private-route database secret "
                "could not be resolved."
            ) from error

        value = str(
            getattr(
                secret,
                "value",
                "",
            )
            or ""
        )

        if not value:
            raise DataPlaneRouteError(
                "A private-route secret resolved "
                "without a value."
            )

        values.append(
            value
        )

    (
        username,
        password,
        host,
        database_name,
    ) = values

    username = _required_text(
        username,
        field="private database username",
    )

    password = _required_text(
        password,
        field="private database password",
    )

    host = _required_text(
        host,
        field="private database host",
        maximum=255,
    )

    database_name = _required_text(
        database_name,
        field="private database name",
        maximum=128,
    )

    if any(
        character in host
        for character in "/?#@:"
    ):
        raise DataPlaneRouteError(
            "The private route database host "
            "is invalid."
        )

    canonical_expected_database = (
        str(
            expected_database_name
            or ""
        ).strip()
        or None
    )

    if (
        canonical_expected_database
        and database_name
        != canonical_expected_database
    ):
        raise DataPlaneRouteError(
            "The private route database secret "
            "does not match the active route."
        )

    return (
        "mysql://"
        f"{quote(username, safe='')}:"
        f"{quote(password, safe='')}@"
        f"{host}:3306/"
        f"{quote(database_name, safe='')}"
        "?ssl-mode=require"
    )


@dataclass(frozen=True)
class WorkerDataPlaneScope:
    organisation_ids: tuple[
        str,
        ...
    ]

    tenant_ids: frozenset[
        str
    ]

    route_keys: tuple[
        str,
        ...
    ]

    schema_version: str

    migration_version: int

    route_type: str

    operational_url: str = field(
        repr=False
    )

    connection_fingerprint: str = field(
        repr=False
    )


def discover_active_worker_organisation_ids(
    *,
    control_plane_url: str,
    supported_schema_versions: (
        frozenset[str]
        | set[str]
        | tuple[str, ...]
    ) = DEFAULT_SUPPORTED_SCHEMA_VERSIONS,
) -> tuple[str, ...]:
    canonical_schema_versions = (
        _normalise_schema_versions(
            supported_schema_versions
        )
    )

    try:
        import pymysql
    except ModuleNotFoundError as error:
        raise DataPlaneRouteError(
            "pymysql is required for "
            "worker-route discovery."
        ) from error

    control = pymysql.connect(
        cursorclass=(
            pymysql.cursors.DictCursor
        ),
        **_connect_options(
            control_plane_url
        ),
    )

    try:
        with control.cursor() as cursor:
            placeholders = ",".join(
                [
                    "%s"
                ]
                * len(
                    canonical_schema_versions
                )
            )

            cursor.execute(
                f"""
                    SELECT
                      o.organisation_id
                    FROM organisations o

                    INNER JOIN data_plane_routes r
                      ON r.organisation_id =
                           o.organisation_id
                     AND r.active_route_slot =
                           o.organisation_id

                    INNER JOIN worker_routing_status w
                      ON w.organisation_id =
                           o.organisation_id
                     AND w.worker_type =
                           'report-worker'

                    WHERE o.organisation_type =
                            'medical_scheme'

                      AND o.status = 'active'

                      AND o.activation_state =
                            'activated'

                      AND r.route_type IN (
                        'legacy_shared',
                        'private_database'
                      )

                      AND r.provisioning_status =
                            'active'

                      AND r.health_status NOT IN (
                        'suspended',
                        'unreachable'
                      )

                      AND r.retired_at IS NULL

                      AND r.schema_version IN (
                        {placeholders}
                      )

                      AND w.status = 'ready'

                    ORDER BY
                      o.organisation_id
                """,
                sorted(
                    canonical_schema_versions
                ),
            )

            rows = cursor.fetchall()

    finally:
        control.close()

    organisation_ids = tuple(
        _required_text(
            row.get(
                "organisation_id"
            ),
            field="organisation_id",
            maximum=64,
        )
        for row in rows
    )

    if (
        len(
            set(
                organisation_ids
            )
        )
        != len(
            organisation_ids
        )
    ):
        raise DataPlaneRouteError(
            "Active report-worker discovery "
            "returned duplicate organisations."
        )

    return organisation_ids


def _load_active_organisation(
    cursor,
    organisation_id: str,
) -> Mapping[str, object]:
    cursor.execute(
        """
            SELECT
              organisation_id,
              canonical_slug,
              status,
              activation_state
            FROM organisations
            WHERE organisation_id = %s
            LIMIT 1
        """,
        [
            organisation_id
        ],
    )

    organisation = (
        cursor.fetchone()
    )

    if (
        not organisation
        or organisation.get(
            "status"
        ) != "active"
        or organisation.get(
            "activation_state"
        ) != "activated"
    ):
        raise DataPlaneRouteError(
            "The report-worker organisation "
            "is inactive."
        )

    return organisation


def _load_active_route(
    cursor,
    organisation_id: str,
) -> Mapping[str, object]:
    cursor.execute(
        """
            SELECT
              route_id,
              route_type,
              route_generation,
              logical_database_identifier,
              database_name,
              secret_reference,
              schema_version,
              provisioning_status,
              health_status,
              retired_at
            FROM data_plane_routes
            WHERE organisation_id = %s
              AND active_route_slot =
                    organisation_id
            LIMIT 2
        """,
        [
            organisation_id
        ],
    )

    routes = cursor.fetchall()

    if len(routes) != 1:
        raise DataPlaneRouteError(
            "Exactly one active report-worker "
            "route is required."
        )

    return routes[0]


def _validate_active_route(
    route: Mapping[str, object],
    *,
    supported_schema_versions: frozenset[str],
) -> tuple[
    str,
    str,
    int,
]:
    route_type = _required_text(
        route.get(
            "route_type"
        ),
        field="route_type",
        maximum=64,
    )

    if (
        route_type
        not in _SUPPORTED_ROUTE_TYPES
    ):
        raise DataPlaneRouteError(
            "The report-worker route type "
            "is unsupported."
        )

    schema_version = _required_text(
        route.get(
            "schema_version"
        ),
        field="route.schema_version",
        maximum=32,
    )

    migration_version = (
        _expected_migration_version(
            schema_version
        )
    )

    health_status = _required_text(
        route.get(
            "health_status"
        ),
        field="route.health_status",
        maximum=64,
    )

    if (
        route.get(
            "provisioning_status"
        )
        != "active"
        or health_status
        in _UNUSABLE_ROUTE_HEALTH_STATUSES
        or route.get(
            "retired_at"
        )
        is not None
        or schema_version
        not in supported_schema_versions
    ):
        raise DataPlaneRouteError(
            "The report-worker route is not "
            "active and compatible."
        )

    return (
        route_type,
        schema_version,
        migration_version,
    )


def _resolve_legacy_scope(
    cursor,
    *,
    organisation_id: str,
    route: Mapping[str, object],
    operational_url: str,
) -> tuple[
    str,
    frozenset[str],
    str,
]:
    logical_identifier = _required_text(
        route.get(
            "logical_database_identifier"
        ),
        field=(
            "route.logical_database_identifier"
        ),
        maximum=255,
    )

    if (
        logical_identifier
        != "legacy-operational-shared"
    ):
        raise DataPlaneRouteError(
            "The legacy report-worker route "
            "has the wrong logical database identity."
        )

    selected_operational_url = (
        _required_text(
            operational_url,
            field="MYSQL_URL",
        )
    )

    operational_database = str(
        _connect_options(
            selected_operational_url
        )["database"]
    )

    route_database = str(
        route.get(
            "database_name"
        )
        or ""
    ).strip()

    if (
        route_database
        and route_database
        != operational_database
    ):
        raise DataPlaneRouteError(
            "The report-worker operational "
            "database does not match its "
            "active route."
        )

    cursor.execute(
        """
            SELECT
              legacy_tenant_id,
              migration_status,
              route_id,
              verified_at
            FROM legacy_tenant_mappings
            WHERE organisation_id = %s
            LIMIT 2
        """,
        [
            organisation_id
        ],
    )

    mappings = cursor.fetchall()

    if (
        len(mappings) != 1
        or mappings[0].get(
            "migration_status"
        )
        != "verified"
        or not mappings[0].get(
            "verified_at"
        )
    ):
        raise DataPlaneRouteError(
            "A verified report-worker legacy "
            "tenant mapping is required."
        )

    route_id = _required_text(
        route.get(
            "route_id"
        ),
        field="route_id",
        maximum=128,
    )

    if (
        mappings[0].get(
            "route_id"
        )
        != route_id
    ):
        raise DataPlaneRouteError(
            "The report-worker mapping and route "
            "do not match."
        )

    tenant_id = _required_text(
        mappings[0].get(
            "legacy_tenant_id"
        ),
        field="legacy_tenant_id",
        maximum=64,
    )

    return (
        selected_operational_url,
        frozenset(
            {
                tenant_id
            }
        ),
        logical_identifier,
    )


def _resolve_private_scope(
    *,
    organisation_id: str,
    route: Mapping[str, object],
    credential,
    secret_client_factory,
) -> tuple[
    str,
    frozenset[str],
    str,
]:
    logical_identifier = _required_text(
        route.get(
            "logical_database_identifier"
        ),
        field=(
            "route.logical_database_identifier"
        ),
        maximum=255,
    )

    expected_identifier = (
        f"private:{organisation_id}"
    )

    if (
        logical_identifier
        != expected_identifier
    ):
        raise DataPlaneRouteError(
            "The private report-worker route "
            "has the wrong logical database identity."
        )

    selected_operational_url = (
        _resolve_private_operational_url(
            secret_reference=str(
                route.get(
                    "secret_reference"
                )
                or ""
            ),

            expected_database_name=(
                str(
                    route.get(
                        "database_name"
                    )
                    or ""
                ).strip()
                or None
            ),

            credential=credential,

            secret_client_factory=(
                secret_client_factory
            ),
        )
    )

    return (
        selected_operational_url,
        frozenset(
            {
                organisation_id
            }
        ),
        logical_identifier,
    )


def _verify_operational_metadata(
    *,
    operational_url: str,
    expected_route_type: str,
    expected_logical_identifier: str,
    expected_schema_version: str,
    expected_migration_version: int,
    expected_environment: str,
) -> None:
    try:
        import pymysql
    except ModuleNotFoundError as error:
        raise DataPlaneRouteError(
            "pymysql is required for "
            "operational metadata verification."
        ) from error

    operational = pymysql.connect(
        cursorclass=(
            pymysql.cursors.DictCursor
        ),
        **_connect_options(
            operational_url
        ),
    )

    try:
        with operational.cursor() as cursor:
            cursor.execute(
                """
                    SELECT
                      database_mode,
                      logical_database_identifier,
                      schema_version,
                      environment_key,
                      migration_version
                    FROM data_plane_metadata
                    WHERE metadata_key = 'primary'
                    LIMIT 2
                """
            )

            rows = cursor.fetchall()

    finally:
        operational.close()

    if len(rows) != 1:
        raise DataPlaneRouteError(
            "Exactly one operational data-plane "
            "metadata row is required."
        )

    metadata = rows[0]

    try:
        actual_migration_version = int(
            metadata.get(
                "migration_version"
            )
        )
    except (
        TypeError,
        ValueError,
    ) as error:
        raise DataPlaneRouteError(
            "The operational migration version "
            "is invalid."
        ) from error

    if (
        metadata.get(
            "database_mode"
        )
        != expected_route_type

        or metadata.get(
            "logical_database_identifier"
        )
        != expected_logical_identifier

        or str(
            metadata.get(
                "schema_version"
            )
            or ""
        )
        != expected_schema_version

        or metadata.get(
            "environment_key"
        )
        != expected_environment

        or actual_migration_version
        != expected_migration_version
    ):
        raise DataPlaneRouteError(
            "Report-worker data-plane metadata "
            "verification failed."
        )


def resolve_worker_data_plane_scope(
    *,
    control_plane_url: str,
    operational_url: str,
    organisation_ids: list[str],
    allowed_organisation_ids: (
        frozenset[str] | None
    ) = None,
    environment_key: str = "legacy",
    private_environment_key: str = "production",
    supported_schema_versions: (
        frozenset[str]
        | set[str]
        | tuple[str, ...]
    ) = DEFAULT_SUPPORTED_SCHEMA_VERSIONS,
    credential=None,
    secret_client_factory=None,
) -> WorkerDataPlaneScope:
    canonical_schema_versions = (
        _normalise_schema_versions(
            supported_schema_versions
        )
    )

    canonical_organisation_ids = [
        _required_text(
            value,
            field="organisation ID",
            maximum=64,
        )
        for value in organisation_ids
    ]

    if (
        len(
            canonical_organisation_ids
        )
        != 1
    ):
        raise DataPlaneRouteError(
            "Exactly one "
            "REPORT_WORKER_ORGANISATION_ID "
            "is required per worker instance."
        )

    organisation_id = (
        canonical_organisation_ids[0]
    )

    if (
        allowed_organisation_ids is None
        or organisation_id
        not in allowed_organisation_ids
    ):
        raise DataPlaneRouteError(
            "The report-worker organisation "
            "is outside the internal service "
            "identity scope."
        )

    expected_legacy_environment = (
        _required_text(
            environment_key,
            field="environment_key",
            maximum=64,
        )
    )

    expected_private_environment = (
        _required_text(
            private_environment_key,
            field="private_environment_key",
            maximum=64,
        )
    )

    try:
        import pymysql
    except ModuleNotFoundError as error:
        raise DataPlaneRouteError(
            "pymysql is required for "
            "data-plane route resolution."
        ) from error

    control = pymysql.connect(
        cursorclass=(
            pymysql.cursors.DictCursor
        ),
        **_connect_options(
            control_plane_url
        ),
    )

    try:
        with control.cursor() as cursor:
            _load_active_organisation(
                cursor,
                organisation_id,
            )

            route = _load_active_route(
                cursor,
                organisation_id,
            )

            (
                route_type,
                schema_version,
                migration_version,
            ) = _validate_active_route(
                route,
                supported_schema_versions=(
                    canonical_schema_versions
                ),
            )

            if (
                route_type
                == "legacy_shared"
            ):
                (
                    selected_operational_url,
                    tenant_ids,
                    logical_identifier,
                ) = _resolve_legacy_scope(
                    cursor,
                    organisation_id=(
                        organisation_id
                    ),
                    route=route,
                    operational_url=(
                        operational_url
                    ),
                )

                expected_environment = (
                    expected_legacy_environment
                )

            else:
                (
                    selected_operational_url,
                    tenant_ids,
                    logical_identifier,
                ) = _resolve_private_scope(
                    organisation_id=(
                        organisation_id
                    ),
                    route=route,
                    credential=credential,
                    secret_client_factory=(
                        secret_client_factory
                    ),
                )

                expected_environment = (
                    expected_private_environment
                )

    finally:
        control.close()

    _verify_operational_metadata(
        operational_url=(
            selected_operational_url
        ),

        expected_route_type=(
            route_type
        ),

        expected_logical_identifier=(
            logical_identifier
        ),

        expected_schema_version=(
            schema_version
        ),

        expected_migration_version=(
            migration_version
        ),

        expected_environment=(
            expected_environment
        ),
    )

    route_id = _required_text(
        route.get(
            "route_id"
        ),
        field="route_id",
        maximum=128,
    )

    route_generation_value = (
        route.get(
            "route_generation"
        )
    )

    if isinstance(
        route_generation_value,
        bool,
    ):
        raise DataPlaneRouteError(
            "The active route generation is invalid."
        )

    try:
        route_generation = int(
            route_generation_value
        )
    except (
        TypeError,
        ValueError,
    ) as error:
        raise DataPlaneRouteError(
            "The active route generation is invalid."
        ) from error

    if route_generation <= 0:
        raise DataPlaneRouteError(
            "The active route generation is invalid."
        )

    route_key = (
        f"{organisation_id}:"
        f"{route_id}:"
        f"{route_generation}"
    )

    connection_fingerprint = (
        sha256(
            selected_operational_url.encode(
                "utf-8"
            )
        ).hexdigest()
    )

    return WorkerDataPlaneScope(
        organisation_ids=(
            organisation_id,
        ),

        tenant_ids=(
            tenant_ids
        ),

        route_keys=(
            route_key,
        ),

        schema_version=(
            schema_version
        ),

        migration_version=(
            migration_version
        ),

        route_type=(
            route_type
        ),

        operational_url=(
            selected_operational_url
        ),

        connection_fingerprint=(
            connection_fingerprint
        ),
    )
