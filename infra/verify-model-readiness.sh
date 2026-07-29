#!/usr/bin/env bash
set -euo pipefail

READINESS_URL="${MODEL_READINESS_URL:?MODEL_READINESS_URL is required}"
EXPECTED_DEPLOYMENT_ID="${EXPECTED_MODEL_DEPLOYMENT_ID:?EXPECTED_MODEL_DEPLOYMENT_ID is required}"
DEADLINE_SECONDS="${MODEL_READINESS_DEADLINE_SECONDS:-300}"
REQUEST_TIMEOUT_SECONDS="${MODEL_READINESS_REQUEST_TIMEOUT_SECONDS:-10}"
RETRY_SECONDS="${MODEL_READINESS_RETRY_SECONDS:-5}"
BODY_FILE=""

fail() {
  echo "Model readiness verification failed: $*" >&2
  exit 1
}

cleanup() {
  if [ -n "$BODY_FILE" ]; then
    rm -f -- "$BODY_FILE"
  fi
}

require_unsigned_integer() {
  local name="$1" value="$2"
  [[ "$value" =~ ^[0-9]+$ ]] \
    || fail "$name must be an unsigned integer"
}

probe() {
  local body_file="$1" status
  status="$(
    curl \
      --silent \
      --show-error \
      --max-time "$REQUEST_TIMEOUT_SECONDS" \
      --output "$body_file" \
      --write-out '%{http_code}' \
      "$READINESS_URL" \
      || true
  )"
  printf '%s' "${status:-000}"
}

main() {
  local deadline attempt status

  command -v curl >/dev/null 2>&1 || fail "curl is required"
  command -v jq >/dev/null 2>&1 || fail "jq is required"
  [[ "$READINESS_URL" =~ ^https://[a-z0-9]([a-z0-9-]*[a-z0-9])?\.[a-z0-9-]+\.southafricanorth\.azurecontainerapps\.io/health/ready$ ]] \
    || fail "MODEL_READINESS_URL is not a safe production readiness URL"
  [[ "$EXPECTED_DEPLOYMENT_ID" =~ ^[a-z0-9][a-z0-9-]*:[0-9]+\.[0-9]+\.[0-9]+$ ]] \
    || fail "EXPECTED_MODEL_DEPLOYMENT_ID is not a safe deployment ID"
  require_unsigned_integer MODEL_READINESS_DEADLINE_SECONDS "$DEADLINE_SECONDS"
  require_unsigned_integer \
    MODEL_READINESS_REQUEST_TIMEOUT_SECONDS \
    "$REQUEST_TIMEOUT_SECONDS"
  require_unsigned_integer MODEL_READINESS_RETRY_SECONDS "$RETRY_SECONDS"
  (( DEADLINE_SECONDS >= 1 && DEADLINE_SECONDS <= 300 )) \
    || fail "MODEL_READINESS_DEADLINE_SECONDS must be between 1 and 300"
  (( REQUEST_TIMEOUT_SECONDS >= 1 && REQUEST_TIMEOUT_SECONDS <= 10 )) \
    || fail "MODEL_READINESS_REQUEST_TIMEOUT_SECONDS must be between 1 and 10"
  (( RETRY_SECONDS <= 5 )) \
    || fail "MODEL_READINESS_RETRY_SECONDS must be no greater than 5"

  BODY_FILE="$(mktemp)"
  trap cleanup EXIT
  deadline=$((SECONDS + DEADLINE_SECONDS))
  attempt=0
  status=000

  while (( SECONDS < deadline )); do
    attempt=$((attempt + 1))
    : > "$BODY_FILE"
    status="$(probe "$BODY_FILE")"
    if [ "$status" = "200" ] \
      && jq --exit-status \
        --arg deployment_id "$EXPECTED_DEPLOYMENT_ID" \
        '.status == "ready" and .deploymentId == $deployment_id' \
        "$BODY_FILE" >/dev/null 2>&1; then
      echo "Model readiness passed on attempt $attempt."
      return
    fi

    echo "Model warm-up attempt $attempt: status=$status"
    if (( SECONDS < deadline )); then
      sleep "$RETRY_SECONDS"
    fi
  done

  fail "deadline exceeded with status=$status"
}

main "$@"
