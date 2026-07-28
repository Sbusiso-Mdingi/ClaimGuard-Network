#!/usr/bin/env bash
set -euo pipefail

API_NAME="${AZURE_WEBAPP_API:?AZURE_WEBAPP_API is required}"
DEADLINE_SECONDS="${API_HEALTH_DEADLINE_SECONDS:-300}"
REQUEST_TIMEOUT_SECONDS="${API_HEALTH_REQUEST_TIMEOUT_SECONDS:-10}"
RETRY_SECONDS="${API_HEALTH_RETRY_SECONDS:-5}"

fail() {
  echo "Post-restart API health verification failed: $*" >&2
  exit 1
}

require_unsigned_integer() {
  local name="$1" value="$2"
  [[ "$value" =~ ^[0-9]+$ ]] \
    || fail "$name must be an unsigned integer"
}

probe_status() {
  local url="$1" status
  status="$(
    curl \
      --silent \
      --show-error \
      --max-time "$REQUEST_TIMEOUT_SECONDS" \
      --output /dev/null \
      --write-out '%{http_code}' \
      "$url" \
      || true
  )"
  printf '%s' "${status:-000}"
}

main() {
  local health_url ready_url deadline attempt health_status ready_status

  command -v curl >/dev/null 2>&1 || fail "curl is required"
  [[ "$API_NAME" =~ ^[a-z0-9]([a-z0-9-]*[a-z0-9])?$ ]] \
    || fail "AZURE_WEBAPP_API is not a safe App Service name"
  require_unsigned_integer API_HEALTH_DEADLINE_SECONDS "$DEADLINE_SECONDS"
  require_unsigned_integer API_HEALTH_REQUEST_TIMEOUT_SECONDS \
    "$REQUEST_TIMEOUT_SECONDS"
  require_unsigned_integer API_HEALTH_RETRY_SECONDS "$RETRY_SECONDS"
  (( DEADLINE_SECONDS >= 1 && DEADLINE_SECONDS <= 300 )) \
    || fail "API_HEALTH_DEADLINE_SECONDS must be between 1 and 300"
  (( REQUEST_TIMEOUT_SECONDS >= 1 && REQUEST_TIMEOUT_SECONDS <= 10 )) \
    || fail "API_HEALTH_REQUEST_TIMEOUT_SECONDS must be between 1 and 10"
  (( RETRY_SECONDS <= 5 )) \
    || fail "API_HEALTH_RETRY_SECONDS must be no greater than 5"

  health_url="https://${API_NAME}.azurewebsites.net/health"
  ready_url="https://${API_NAME}.azurewebsites.net/ready"
  deadline=$((SECONDS + DEADLINE_SECONDS))
  attempt=0
  health_status=000
  ready_status=000

  while (( SECONDS < deadline )); do
    attempt=$((attempt + 1))
    health_status="$(probe_status "$health_url")"
    ready_status="$(probe_status "$ready_url")"
    if [ "$health_status" = "200" ] && [ "$ready_status" = "200" ]; then
      echo "Post-restart API health passed on attempt $attempt."
      return
    fi

    echo "API warm-up attempt $attempt: health=$health_status ready=$ready_status"
    if (( SECONDS < deadline )); then
      sleep "$RETRY_SECONDS"
    fi
  done

  fail \
    "deadline exceeded with health=$health_status ready=$ready_status"
}

main "$@"
