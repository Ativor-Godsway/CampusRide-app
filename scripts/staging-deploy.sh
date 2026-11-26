#!/usr/bin/env bash
# staging-deploy.sh — put a branch on STAGING (STAGING.md).
#
# Usage:
#   npm run staging:deploy -- <branch>
#
# 1. Pushes <branch> (as committed) to the git branch "staging" on GitHub,
#    replacing whatever was there: the Render staging service deploys it.
# 2. Applies THAT branch's database migrations to the staging database
#    (apps/server/.env.staging; refused for anything but the staging branch).
# Production is never touched: no push to main, no production database.
# Compatible with macOS bash 3.2.

set -euo pipefail

branch="${1:-}"
if [[ -z "$branch" ]]; then
  echo "Usage: npm run staging:deploy -- <branch>" >&2
  exit 1
fi
if [[ "$branch" == "staging" ]]; then
  echo "Error: name the feature branch to put on staging, not staging itself." >&2
  exit 1
fi

root="$(git rev-parse --show-toplevel)"
cd "$root"

git fetch -q origin
if git rev-parse -q --verify "refs/heads/$branch" >/dev/null; then
  ref="refs/heads/$branch"
elif git rev-parse -q --verify "refs/remotes/origin/$branch" >/dev/null; then
  ref="refs/remotes/origin/$branch"
else
  echo "Error: no branch '$branch' here or on GitHub." >&2
  exit 1
fi
commit="$(git rev-parse --short "$ref")"
if [[ "$ref" == "refs/heads/$branch" ]] && [[ "$(git rev-parse -q --verify "refs/remotes/origin/$branch" || true)" != "$(git rev-parse "$ref")" ]]; then
  echo "Note: your local '$branch' differs from GitHub's; staging gets your local one ($commit)."
fi
if [[ "$(git rev-parse --abbrev-ref HEAD)" == "$branch" ]] && [[ -n "$(git status --porcelain --untracked-files=no)" ]]; then
  echo "Note: uncommitted changes are NOT deployed (only commits are)."
fi

echo "Pushing $branch ($commit) to the staging branch…"
git push --force origin "$ref:refs/heads/staging"

echo "Applying $branch's migrations to the STAGING database…"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
git archive "$ref" apps/server/prisma | tar -x -C "$tmp"
npm run staging:db:migrate --workspace apps/server --silent -- --schema "$tmp/apps/server/prisma/schema.prisma"

echo
echo "Done. Render is now deploying $branch ($commit) to staging (a few minutes: watch it on dashboard.render.com)."
echo "Then: npm run staging:wake"
