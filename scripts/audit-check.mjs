#!/usr/bin/env node
/**
 * Dependency-vulnerability gate for CI.
 *
 * `npm audit --audit-level=high` alone is useless here: the repo carries four
 * known high advisories in expo@54's build toolchain that cannot be cleared
 * without a three-major React Native migration (accepted in Phase 2). A bare
 * audit would fail every build from day one and be switched off within a week.
 *
 * So instead: fail on any high/critical advisory that is NOT in
 * .audit-allowlist.json. New vulnerabilities break the build; the documented
 * exceptions do not. Exceptions carry a reason and a reviewBy date, and
 * entries that stop matching anything are reported as stale so the list gets
 * pruned instead of quietly growing.
 *
 * Exit codes: 0 = clean or fully allowlisted, 1 = new/expired findings.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const BLOCKING = new Set(["high", "critical"]);
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

function runAudit() {
  try {
    // npm audit exits non-zero when it finds anything, so the throw is the
    // normal path and stdout still holds the report.
    return JSON.parse(
      execFileSync("npm", ["audit", "--json"], { cwd: repoRoot, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }),
    );
  } catch (err) {
    if (err.stdout) return JSON.parse(err.stdout);
    throw err;
  }
}

/** Flattens npm's nested report into one entry per distinct advisory. */
function collectAdvisories(report) {
  const found = new Map();
  for (const vuln of Object.values(report.vulnerabilities ?? {})) {
    for (const via of vuln.via ?? []) {
      // A string `via` is just "this package is vulnerable because its
      // dependency is" — the advisory itself appears as an object elsewhere.
      if (typeof via !== "object" || !BLOCKING.has(via.severity)) continue;
      const id = via.url?.split("/").pop() ?? via.source?.toString() ?? via.title;
      if (!found.has(id)) {
        found.set(id, { id, package: via.name, severity: via.severity, title: via.title, url: via.url });
      }
    }
  }
  return found;
}

const allowlist = JSON.parse(readFileSync(join(repoRoot, ".audit-allowlist.json"), "utf8"));
const allowed = new Map(allowlist.allow.map((entry) => [entry.id, entry]));

const found = collectAdvisories(runAudit());
const today = new Date().toISOString().slice(0, 10);

const unexpected = [...found.values()].filter((a) => !allowed.has(a.id));
const expired = [...found.values()]
  .filter((a) => allowed.has(a.id) && allowed.get(a.id).reviewBy < today)
  .map((a) => allowed.get(a.id));
const stale = [...allowed.values()].filter((entry) => !found.has(entry.id));

console.log(`npm audit: ${found.size} distinct high/critical advisories, ${allowed.size} allowlisted.\n`);

for (const a of found.values()) {
  if (allowed.has(a.id)) {
    console.log(`  [accepted] ${a.severity.padEnd(8)} ${a.package} — ${a.id} (review by ${allowed.get(a.id).reviewBy})`);
  }
}

if (stale.length > 0) {
  console.log("\nStale allowlist entries (no longer reported — delete them from .audit-allowlist.json):");
  for (const entry of stale) console.log(`  - ${entry.id} (${entry.package})`);
}

if (expired.length > 0) {
  console.error("\nAllowlist entries are past their reviewBy date and must be re-assessed:");
  for (const entry of expired) console.error(`  - ${entry.id} (${entry.package}) reviewBy ${entry.reviewBy}`);
}

if (unexpected.length > 0) {
  console.error(`\nNEW high/critical advisories not covered by the allowlist (${unexpected.length}):`);
  for (const a of unexpected) {
    console.error(`  - ${a.severity.toUpperCase()} ${a.package}: ${a.title}`);
    console.error(`    ${a.url}`);
  }
  console.error(
    "\nFix them (npm audit fix, or upgrade the package), or — if genuinely not\n" +
      "exploitable here — add an entry to .audit-allowlist.json with a reason\n" +
      "and a reviewBy date.",
  );
}

if (unexpected.length > 0 || expired.length > 0) process.exit(1);
console.log("\nNo new high/critical advisories.");
