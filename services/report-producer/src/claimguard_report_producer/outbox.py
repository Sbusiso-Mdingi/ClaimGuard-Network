from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Callable
from urllib.parse import parse_qs, unquote, urlparse


@dataclass(frozen=True)
class OutboxJob:
    id: str
    tenant_id: str
    job_type: str
    aggregate_type: str
    aggregate_id: str
    correlation_id: str
    payload: object
    status: str
    attempt_count: int
    max_attempts: int


def _map_job(row: dict[str, object]) -> OutboxJob:
    payload = row.get("payload")
    if isinstance(payload, (bytes, bytearray)):
        payload = payload.decode("utf-8")
    if isinstance(payload, str):
        try:
            payload = json.loads(payload)
        except json.JSONDecodeError:
            pass

    return OutboxJob(
        id=str(row.get("id") or ""),
        tenant_id=str(row.get("tenant_id") or ""),
        job_type=str(row.get("job_type") or ""),
        aggregate_type=str(row.get("aggregate_type") or ""),
        aggregate_id=str(row.get("aggregate_id") or ""),
        correlation_id=str(row.get("correlation_id") or ""),
        payload=payload,
        status=str(row.get("status") or ""),
        attempt_count=int(row.get("attempt_count") or 0),
        max_attempts=int(row.get("max_attempts") or 0),
    )


class PyMySqlOutboxRepository:
    def __init__(self, connection_factory: Callable[[], object], allowed_tenant_ids: frozenset[str] | None = None) -> None:
        self.connection_factory = connection_factory
        self.allowed_tenant_ids = allowed_tenant_ids

    @classmethod
    def from_url(cls, database_url: str, *, allowed_tenant_ids: frozenset[str] | None = None) -> "PyMySqlOutboxRepository":
        if not database_url:
            raise ValueError("MYSQL_URL is required for report worker mode.")

        parsed = urlparse(database_url)
        if parsed.scheme not in {"mysql", "mysql+pymysql"}:
            raise ValueError("MYSQL_URL must use the mysql scheme.")
        if not parsed.hostname or not parsed.path.strip("/"):
            raise ValueError("MYSQL_URL must include a host and database name.")

        query = parse_qs(parsed.query)
        ssl_mode = (query.get("ssl-mode") or query.get("ssl_mode") or [""])[0].lower()
        connect_options: dict[str, object] = {
            "host": parsed.hostname,
            "port": parsed.port or 3306,
            "user": unquote(parsed.username or ""),
            "password": unquote(parsed.password or ""),
            "database": unquote(parsed.path.lstrip("/")),
            "charset": "utf8mb4",
            "autocommit": False,
        }
        if ssl_mode in {"required", "verify_ca", "verify_identity"}:
            connect_options["ssl"] = {"check_hostname": ssl_mode == "verify_identity"}

        def connection_factory():
            import pymysql

            return pymysql.connect(
                cursorclass=pymysql.cursors.DictCursor,
                **connect_options,
            )

        return cls(connection_factory, allowed_tenant_ids)

    def _require_allowed_tenant(self, tenant_id: str) -> None:
        if self.allowed_tenant_ids is not None and tenant_id not in self.allowed_tenant_ids:
            raise ValueError("Outbox tenant is outside the verified worker data-plane scope.")

    def recover_expired_leases(self, cursor) -> int:
        return cursor.execute(
            f"""
            UPDATE claim_processing_outbox
            SET
              status = CASE
                WHEN attempt_count >= max_attempts THEN 'dead_letter'
                ELSE 'retry'
              END,
              available_at = UTC_TIMESTAMP(3),
              leased_at = NULL,
              lease_expires_at = NULL,
              leased_by = NULL,
              last_error = 'Worker lease expired before completion.',
              failure_code = 'WORKER_LEASE_EXPIRED',
              completed_at = CASE
                WHEN attempt_count >= max_attempts THEN UTC_TIMESTAMP(3)
                ELSE NULL
              END
            WHERE status = 'processing'
              {"AND tenant_id IN (" + ", ".join(["%s"] * len(self.allowed_tenant_ids)) + ")" if self.allowed_tenant_ids else ""}
              AND lease_expires_at IS NOT NULL
              AND lease_expires_at <= UTC_TIMESTAMP(3)
            """,
            list(self.allowed_tenant_ids or []),
        )

    def lease_next_available_jobs(
        self,
        *,
        worker_id: str,
        limit: int,
        lease_seconds: int,
    ) -> list[OutboxJob]:
        safe_limit = max(1, min(int(limit), 100))
        safe_lease_seconds = max(1, min(int(lease_seconds), 86400))
        connection = self.connection_factory()

        try:
            connection.begin()
            with connection.cursor() as cursor:
                self.recover_expired_leases(cursor)
                cursor.execute(
                    f"""
                    SELECT id
                    FROM claim_processing_outbox
                    WHERE status IN ('pending', 'retry')
                      {"AND tenant_id IN (" + ", ".join(["%s"] * len(self.allowed_tenant_ids)) + ")" if self.allowed_tenant_ids else ""}
                      AND available_at <= UTC_TIMESTAMP(3)
                    ORDER BY available_at ASC, created_at ASC
                    LIMIT {safe_limit}
                    FOR UPDATE SKIP LOCKED
                    """,
                    list(self.allowed_tenant_ids or []),
                )
                ids = [str(row["id"]) for row in cursor.fetchall()]
                if not ids:
                    connection.commit()
                    return []

                placeholders = ", ".join(["%s"] * len(ids))
                cursor.execute(
                    f"""
                    UPDATE claim_processing_outbox
                    SET
                      status = 'processing',
                      attempt_count = attempt_count + 1,
                      leased_at = UTC_TIMESTAMP(3),
                      lease_expires_at = DATE_ADD(UTC_TIMESTAMP(3), INTERVAL %s SECOND),
                      leased_by = %s,
                      last_error = NULL,
                      failure_code = NULL,
                      failed_watermark = NULL
                    WHERE id IN ({placeholders})
                    """,
                    [safe_lease_seconds, worker_id, *ids],
                )
                cursor.execute(
                    f"""
                    SELECT *
                    FROM claim_processing_outbox
                    WHERE id IN ({placeholders})
                      AND status = 'processing'
                      AND leased_by = %s
                    ORDER BY available_at ASC, created_at ASC
                    """,
                    [*ids, worker_id],
                )
                jobs = [_map_job(row) for row in cursor.fetchall()]
                for job in jobs:
                    self._require_allowed_tenant(job.tenant_id)
            connection.commit()
            return jobs
        except Exception:
            connection.rollback()
            raise
        finally:
            connection.close()

    def _transition(
        self,
        *,
        sql: str,
        params: list[object],
    ) -> bool:
        connection = self.connection_factory()
        try:
            with connection.cursor() as cursor:
                affected = cursor.execute(sql, params)
            connection.commit()
            return affected == 1
        except Exception:
            connection.rollback()
            raise
        finally:
            connection.close()

    def mark_completed(self, *, job: OutboxJob, worker_id: str) -> bool:
        self._require_allowed_tenant(job.tenant_id)
        return self._transition(
            sql="""
                UPDATE claim_processing_outbox
                SET
                  status = 'completed',
                  completed_at = UTC_TIMESTAMP(3),
                  leased_at = NULL,
                  lease_expires_at = NULL,
                  leased_by = NULL,
                  last_error = NULL,
                  failure_code = NULL,
                  failed_watermark = NULL
                WHERE id = %s AND tenant_id = %s
                  AND status = 'processing' AND leased_by = %s
            """,
            params=[job.id, job.tenant_id, worker_id],
        )

    def mark_completed_many(
        self,
        *,
        jobs: list[OutboxJob],
        worker_id: str,
        report_id: str,
        watermark: str,
    ) -> bool:
        if not jobs:
            return True
        tenant_ids = {job.tenant_id for job in jobs}
        if len(tenant_ids) != 1:
            raise ValueError("Coalesced outbox completion cannot cross tenant boundaries.")
        self._require_allowed_tenant(next(iter(tenant_ids)))
        connection = self.connection_factory()
        try:
            connection.begin()
            with connection.cursor() as cursor:
                affected = 0
                for job in jobs:
                    affected += cursor.execute(
                        """
                        UPDATE claim_processing_outbox
                        SET
                          status = 'completed',
                          completed_at = UTC_TIMESTAMP(3),
                          covered_report_id = %s,
                          covered_watermark = %s,
                          covered_at = UTC_TIMESTAMP(3),
                          leased_at = NULL,
                          lease_expires_at = NULL,
                          leased_by = NULL,
                          last_error = NULL,
                          failure_code = NULL,
                          failed_watermark = NULL
                        WHERE id = %s AND tenant_id = %s
                          AND status = 'processing' AND leased_by = %s
                        """,
                        [report_id, watermark, job.id, job.tenant_id, worker_id],
                    )
            if affected != len(jobs):
                connection.rollback()
                return False
            connection.commit()
            return True
        except Exception:
            connection.rollback()
            raise
        finally:
            connection.close()

    def mark_retry(
        self,
        *,
        job: OutboxJob,
        worker_id: str,
        delay_seconds: int,
        last_error: str,
        failure_code: str | None = None,
        failed_watermark: str | None = None,
    ) -> bool:
        self._require_allowed_tenant(job.tenant_id)
        return self._transition(
            sql="""
                UPDATE claim_processing_outbox
                SET
                  status = 'retry',
                  available_at = DATE_ADD(UTC_TIMESTAMP(3), INTERVAL %s SECOND),
                  leased_at = NULL,
                  lease_expires_at = NULL,
                  leased_by = NULL,
                  last_error = %s,
                  failure_code = %s,
                  failed_watermark = %s
                WHERE id = %s AND tenant_id = %s
                  AND status = 'processing' AND leased_by = %s
            """,
            params=[
                max(1, min(int(delay_seconds), 86400)),
                last_error[:255],
                (failure_code or last_error)[:64],
                failed_watermark[:1024] if failed_watermark else None,
                job.id,
                job.tenant_id,
                worker_id,
            ],
        )

    def mark_dead_letter(
        self,
        *,
        job: OutboxJob,
        worker_id: str,
        last_error: str,
        failure_code: str | None = None,
        failed_watermark: str | None = None,
    ) -> bool:
        self._require_allowed_tenant(job.tenant_id)
        return self._transition(
            sql="""
                UPDATE claim_processing_outbox
                SET
                  status = 'dead_letter',
                  completed_at = UTC_TIMESTAMP(3),
                  leased_at = NULL,
                  lease_expires_at = NULL,
                  leased_by = NULL,
                  last_error = %s,
                  failure_code = %s,
                  failed_watermark = %s
                WHERE id = %s AND tenant_id = %s
                  AND status = 'processing' AND leased_by = %s
            """,
            params=[
                last_error[:255],
                (failure_code or last_error)[:64],
                failed_watermark[:1024] if failed_watermark else None,
                job.id,
                job.tenant_id,
                worker_id,
            ],
        )
