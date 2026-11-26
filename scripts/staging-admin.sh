#!/usr/bin/env bash
# staging-admin.sh — the admin site on this Mac (http://localhost:5173),
# talking to the STAGING server (STAGING.md). Sign in with the staging admin
# test number and the fixed staging code.
set -euo pipefail
root="$(git rev-parse --show-toplevel)"
url="$(grep -E '^STAGING_API_URL=' "$root/apps/server/.env.staging" 2>/dev/null | head -1 | cut -d= -f2- | tr -d '"' || true)"
url="${url:-https://campusride-staging-api.onrender.com}"
cd "$root"
VITE_API_URL="$url" VITE_SENTRY_DSN="" npm run dev --workspace apps/admin -- --port 5173 --strictPort
