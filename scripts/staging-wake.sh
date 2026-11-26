#!/usr/bin/env bash
# staging-wake.sh — wakes the STAGING server (STAGING.md). The free Render
# plan sleeps after about 15 minutes without requests; the first request
# then takes up to a minute. Waits for /health to answer.
set -euo pipefail
root="$(git rev-parse --show-toplevel)"
url="$(grep -E '^STAGING_API_URL=' "$root/apps/server/.env.staging" 2>/dev/null | head -1 | cut -d= -f2- | tr -d '"' || true)"
url="${url:-https://campusride-staging-api.onrender.com}"
echo "Waking $url …"
for i in $(seq 1 24); do
  if curl -fsS --max-time 10 "$url/health" >/dev/null 2>&1; then
    echo "Staging is awake."
    exit 0
  fi
  sleep 5
done
echo "Error: staging didn't answer within 2 minutes. Check the service on dashboard.render.com." >&2
exit 1
