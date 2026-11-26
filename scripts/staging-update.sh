#!/usr/bin/env bash
# staging-update.sh — publishes a STAGING over-the-air update of one app
# from the current branch (STAGING.md). Same as:
#   bash scripts/eas-update.sh <rider|driver> staging "<what changed>"
set -euo pipefail
if [[ $# -lt 2 ]]; then
  echo "Usage: npm run staging:update -- <rider|driver> \"<what changed>\"" >&2
  exit 1
fi
exec bash "$(git rev-parse --show-toplevel)/scripts/eas-update.sh" "$1" staging "$2"
