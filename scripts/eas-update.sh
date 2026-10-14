#!/usr/bin/env bash
# eas-update.sh — publish an over-the-air (EAS Update) release of one app.
#
# Usage:
#   bash scripts/eas-update.sh <rider|driver> <development|preview|production> "<what changed>"
#
# Step-by-step guide: docs/runbooks/releasing.md.
#
# Why a script rather than a bare `eas update`:
#  - `eas update` bundles the JavaScript on THIS Mac, so it would read the
#    gitignored apps/<app>/.env — not the server URL in eas.json. This script
#    sets EXPO_PUBLIC_API_URL from eas.json, which wins over any .env file.
#  - It refuses to publish uncommitted code, and refuses production from any
#    branch but an up-to-date main.
#  - It lives outside apps/<app>/, so it is not part of the apps' fingerprint
#    (editing an app's package.json scripts would force a new store build).
# Compatible with macOS bash 3.2.

set -euo pipefail

EAS="npx -y eas-cli@24"

app="${1:-}"
channel="${2:-}"
message="${3:-}"

if [[ "$app" != "rider" && "$app" != "driver" ]] ||
  [[ "$channel" != "development" && "$channel" != "preview" && "$channel" != "production" ]] ||
  [[ -z "$message" ]]; then
  echo "Usage: bash scripts/eas-update.sh <rider|driver> <development|preview|production> \"<what changed>\"" >&2
  exit 1
fi

root="$(git rev-parse --show-toplevel)"
cd "$root"

if [[ -n "$(git status --porcelain --untracked-files=no)" ]]; then
  echo "Error: you have uncommitted changes. Commit or stash them first, so the update matches a commit." >&2
  exit 1
fi

if [[ "$channel" == "production" ]]; then
  branch="$(git rev-parse --abbrev-ref HEAD)"
  if [[ "$branch" != "main" ]]; then
    echo "Error: production updates are published from main only (you are on '$branch')." >&2
    exit 1
  fi
  git fetch -q origin main
  if [[ "$(git rev-parse HEAD)" != "$(git rev-parse origin/main)" ]]; then
    echo "Error: your main is not the same as GitHub's. Run: git pull" >&2
    exit 1
  fi
fi

cd "apps/$app"

api_url="$(node -p 'require("./eas.json").build.production.env.EXPO_PUBLIC_API_URL')"
export EXPO_PUBLIC_API_URL="$api_url"

echo "Publishing $app to channel '$channel' (server: $EXPO_PUBLIC_API_URL)…"
$EAS update --channel "$channel" --environment production --message "$message"
