#!/usr/bin/env bash
# compare-row-counts.sh — read-only row-count comparison between two databases.
#
# Usage:
#   OLD_URL="postgresql://…" NEW_URL="postgresql://…" bash scripts/compare-row-counts.sh
#
# Both URLs must be direct (non-pooled) Postgres connection strings.
# The script runs only SELECT count(*) — no writes.
# Compatible with macOS bash 3.2 (no associative arrays).

set -euo pipefail

if [[ -z "${OLD_URL:-}" || -z "${NEW_URL:-}" ]]; then
  echo "Error: both OLD_URL and NEW_URL must be exported." >&2
  exit 1
fi

PSQL="/usr/local/opt/libpq/bin/psql"
if [[ ! -x "$PSQL" ]]; then
  PSQL="psql"
fi

# Get all user tables from the OLD database (information_schema).
tables=$("$PSQL" "$OLD_URL" -t -A -c "
  SELECT table_name
  FROM information_schema.tables
  WHERE table_schema = 'public'
    AND table_type = 'BASE TABLE'
    AND table_name != '_prisma_migrations'
  ORDER BY table_name;
")

if [[ -z "$tables" ]]; then
  echo "No tables found in OLD database." >&2
  exit 1
fi

# Build a single query that returns table_name|count for all tables.
build_count_query() {
  local first=true
  while IFS= read -r tbl; do
    [[ -z "$tbl" ]] && continue
    if $first; then first=false; else echo "UNION ALL"; fi
    printf "SELECT '%s' AS tbl, count(*)::bigint AS n FROM \"%s\"\n" "$tbl" "$tbl"
  done <<< "$1"
  echo "ORDER BY tbl;"
}

count_query=$(build_count_query "$tables")

# Query both databases and save to temp files.
old_file=$(mktemp)
new_file=$(mktemp)
trap 'rm -f "$old_file" "$new_file"' EXIT

"$PSQL" "$OLD_URL" -t -A -F '|' -c "$count_query" > "$old_file" &
pid_old=$!
"$PSQL" "$NEW_URL" -t -A -F '|' -c "$count_query" > "$new_file" &
pid_new=$!
wait "$pid_old" "$pid_new"

# Join on table name (first field) and print a formatted comparison.
printf "\n%-35s %10s %10s %s\n" "TABLE" "OLD" "NEW" "STATUS"
printf "%-35s %10s %10s %s\n" "-----------------------------------" "----------" "----------" "------"

mismatches=0
join -t '|' -a 1 -a 2 -o '0,1.2,2.2' -e 'MISSING' "$old_file" "$new_file" | \
while IFS='|' read -r tbl old_n new_n; do
  if [[ "$old_n" == "$new_n" ]]; then
    status="OK"
  else
    status="MISMATCH"
    mismatches=$((mismatches + 1))
  fi
  printf "%-35s %10s %10s %s\n" "$tbl" "$old_n" "$new_n" "$status"
done

# Re-count mismatches outside the pipeline (subshell issue with while|pipe).
mismatch_count=$(join -t '|' -a 1 -a 2 -o '0,1.2,2.2' -e 'MISSING' "$old_file" "$new_file" | \
  awk -F'|' '$2 != $3 { n++ } END { print n+0 }')

echo ""
if [[ "$mismatch_count" -eq 0 ]]; then
  echo "All tables match."
else
  echo "$mismatch_count table(s) with mismatches."
fi
