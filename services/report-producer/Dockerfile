# syntax=docker/dockerfile:1
FROM ghcr.io/astral-sh/uv:0.11.28@sha256:5c3ab83183a73c5d319a77009eb425b60d5bb937f339fb7876788ebf567baf48 AS uv
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
