# syntax=docker/dockerfile:1
FROM ghcr.io/astral-sh/uv:0.12.0@sha256:606e70c71c852d03f611b1e56a195d08648507018a7057fab82c4974c4eae105 AS uv
FROM python:3.11.13-slim-bookworm@sha256:cec9aa7aa96eea4fa036e9b82be1e6b325f2e3707f462d885868df51ec0a4b47 AS builder

ENV UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy

COPY --from=uv /uv /usr/local/bin/uv

WORKDIR /opt/claimguard
COPY services/detection-engine ./services/detection-engine
COPY services/report-producer ./services/report-producer

WORKDIR /opt/claimguard/services/report-producer
RUN uv sync --frozen --no-dev --no-editable

FROM python:3.11.13-slim-bookworm@sha256:cec9aa7aa96eea4fa036e9b82be1e6b325f2e3707f462d885868df51ec0a4b47

ENV PATH=/opt/claimguard/venv/bin:$PATH \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

RUN groupadd --system --gid 10001 claimguard \
    && useradd --system --uid 10001 --gid claimguard \
       --home-dir /nonexistent --shell /usr/sbin/nologin claimguard

COPY --from=builder \
    /opt/claimguard/services/report-producer/.venv \
    /opt/claimguard/venv

USER 10001:10001
WORKDIR /opt/claimguard

ENTRYPOINT ["python", "-m", "claimguard_report_producer.cli"]
CMD ["worker", "once"]
