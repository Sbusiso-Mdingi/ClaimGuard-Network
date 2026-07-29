#!/usr/bin/env bash
set -euo pipefail

if [ "$#" -ne 2 ]; then
  echo "Usage: package-release-artifacts.sh <40-character-commit-sha> <output-directory>" >&2
  exit 2
fi

commit_sha="$1"
output_directory="$2"

if [[ ! "$commit_sha" =~ ^[0-9a-f]{40}$ ]]; then
  echo "The release commit must be an exact lowercase 40-character SHA." >&2
  exit 2
fi

mkdir -p "$output_directory"
web_directory="$(mktemp -d)"
api_directory="$(mktemp -d)"
trap 'rm -rf "$web_directory" "$api_directory"' EXIT

pnpm --filter ./apps/web deploy "$web_directory" -P
(
  cd "$web_directory"
  zip -qry "$output_directory/claimguard-web-deploy.zip" . \
    -x ".turbo/*" \
       "tests/*" \
       "docs/*" \
       "src/setupTests.js" \
       "vitest.config.ts"
)

pnpm --filter ./apps/api deploy "$api_directory" -P
(
  cd "$api_directory"
  zip -qry "$output_directory/claimguard-api-deploy.zip" . \
    -x ".turbo/*" \
       "tests/*" \
       "reports/*" \
       "*.log"
)

unzip -q "$output_directory/claimguard-api-deploy.zip" -d "$output_directory/api-check"
test -L "$output_directory/api-check/node_modules/hono"
test -L "$output_directory/api-check/node_modules/@claimguard/database"
rm -rf "$output_directory/api-check"

node tools/create-release-manifest.mjs \
  "$commit_sha" \
  "$output_directory/claimguard-web-deploy.zip" \
  "$output_directory/claimguard-api-deploy.zip" \
  "$output_directory/release-manifest.json"
