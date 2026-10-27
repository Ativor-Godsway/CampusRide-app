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
#  - It publishes iOS and Android only, one after the other. A bare
#    `eas update` means --platform all, which includes web: react-native-web
#    is installed in this repo (so Expo counts web as a platform), but the
#    apps don't support it, and the export fails. Saying so in app.json
#    ("platforms") instead would change both apps' fingerprints.
#    Each platform gets its own update group ID.
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

# google-services.json is part of the app's fingerprint (its contents, not
# just its name). Without this Mac's copy — byte-identical to the one in the
# GOOGLE_SERVICES_JSON EAS variable — the update would be labelled for a
# build that doesn't exist and reach nobody.
if [[ ! -f google-services.json ]]; then
  echo "Error: apps/$app/google-services.json is missing. See docs/runbooks/push-notifications.md, step 1." >&2
  exit 1
fi

api_url="$(node -p 'require("./eas.json").build.production.env.EXPO_PUBLIC_API_URL')"
export EXPO_PUBLIC_API_URL="$api_url"

# Optional: the update's source maps to Sentry, so errors from it show real
# file names and lines (DEPLOY.md, "Monitoring"). Only when SENTRY_AUTH_TOKEN
# is set in this shell; without it nothing happens. The Sentry projects are
# named campusride-rider and campusride-driver. Run after each platform's
# publish: the next one's export replaces dist/.
upload_source_maps() {
  [[ -n "${SENTRY_AUTH_TOKEN:-}" ]] || return 0
  if [[ -z "${SENTRY_ORG:-}" ]]; then
    echo "Skipping the Sentry source map upload: set SENTRY_ORG (your Sentry organization's slug) too." >&2
    return 0
  fi
  echo "Uploading $1 source maps to Sentry (campusride-$app)…"
  SENTRY_PROJECT="campusride-$app" npx sentry-expo-upload-sourcemaps dist ||
    echo "The $1 update is published; only the Sentry source map upload failed." >&2
}

for platform in ios android; do
  echo "Publishing $app ($platform) to channel '$channel' (server: $EXPO_PUBLIC_API_URL)…"
  if ! $EAS update --channel "$channel" --environment production --platform "$platform" --message "$message"; then
    if [[ "$platform" == "android" ]]; then
      echo "Error: the iOS update was published, but Android failed. Fix the problem and run this again (iOS is simply published once more)." >&2
    fi
    exit 1
  fi
  upload_source_maps "$platform"
done

echo "Done: $app is published for iOS and Android. Each has its own update group ID (shown above)."
