#!/usr/bin/env bash
# compare-row-counts.sh — read-only row-count comparison between two databases.
#
# Usage:
#   OLD_URL="postgresql://…" NEW_URL="postgresql://…" bash scripts/compare-row-counts.sh
#
# Both URLs must be direct (non-pooled) Postgres connection strings.
# The script runs only SELECT count(*) — no writes.

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

# Build a single query that returns table_name, count for all tables.
build_count_query() {
  local first=true
  while IFS= read -r tbl; do
    [[ -z "$tbl" ]] && continue
    if $first; then first=false; else echo "UNION ALL"; fi
    # Quote table name to handle any casing.
    printf "SELECT '%s' AS tbl, count(*)::bigint AS n FROM \"%s\"\n" "$tbl" "$tbl"
  done <<< "$1"
  echo "ORDER BY tbl;"
}

count_query=$(build_count_query "$tables")

# Run the count query on both databases in parallel.
old_counts=$("$PSQL" "$OLD_URL" -t -A -F '|' -c "$count_query") &
pid_old=$!
new_counts=$("$PSQL" "$NEW_URL" -t -A -F '|' -c "$count_query") &
pid_new=$!
wait "$pid_old" "$pid_new"

# Parse results into associative arrays.
declare -A old_map new_map
while IFS='|' read -r tbl n; do
  [[ -z "$tbl" ]] && continue
  old_map["$tbl"]="$n"
done <<< "$old_counts"
while IFS='|' read -r tbl n; do
  [[ -z "$tbl" ]] && continue
  new_map["$tbl"]="$n"
done <<< "$new_counts"

# Print a formatted table.
printf "\n%-35s %10s %10s %s\n" "TABLE" "OLD" "NEW" "STATUS"
printf "%-35s %10s %10s %s\n" "-----------------------------------" "----------" "----------" "------"

mismatches=0
while IFS= read -r tbl; do
  [[ -z "$tbl" ]] && continue
  o="${old_map[$tbl]:-MISSING}"
  n="${new_map[$tbl]:-MISSING}"
  if [[ "$o" == "$n" ]]; then
    status="OK"
  else
    status="MISMATCH"
    mismatches=$((mismatches + 1))
  fi
  printf "%-35s %10s %10s %s\n" "$tbl" "$o" "$n" "$status"
done <<< "$tables"

echo ""
if [[ "$mismatches" -eq 0 ]]; then
  echo "All tables match."
else
  echo "$mismatches table(s) with mismatches."
fi
