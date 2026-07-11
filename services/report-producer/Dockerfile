FROM python:3.12-slim

WORKDIR /app

RUN pip install --no-cache-dir uv

COPY services/detection-engine /app/services/detection-engine
COPY services/report-producer /app/services/report-producer

WORKDIR /app/services/detection-engine
RUN uv pip install --system .

WORKDIR /app/services/report-producer
RUN uv pip install --system .

ENTRYPOINT ["claimguard-produce-report"]
