/**
 * Single source of truth for the "is this database safe to destroy?" guard.
 *
 * Used by BOTH the vitest setup guardrail (src/test/setup.ts) and the
 * branch-scoped db scripts (src/scripts/assertNonProdDb.ts). See
 * docs/environments.md.
 *
 * ── WHY THIS IS AN ALLOWLIST ────────────────────────────────────────────────
 * It used to be a DENYLIST of exactly one hardcoded Neon compute host. That
 * fails open, and it did: the host it named stopped being the only production
 * database (accounts and branches get created, migrated and renamed), so a
 * .env.test pointing at a *different* Neon host sailed straight through and
 * the suite wrote hundreds of fixture accounts into production.
 *
 * A guard that only knows one bad address cannot protect you from an address
 * it has never heard of. So the rule is inverted: a local database is fine,
 * anything else has to be named explicitly by the person running the command,
 * and a known production host is refused even then.
 */

/** Local Postgres — always safe to reset, seed and fill with fixtures. */
const ALWAYS_ALLOWED_HOSTS = ["localhost", "127.0.0.1", "::1", "host.docker.internal"];

/**
 * Known PRODUCTION compute hosts. Refused unconditionally — naming one in
 * ALLOW_TEST_DB_HOST does not unlock it. Add every production host the project
 * has ever had: an old one can still hold live data.
 */
export const KNOWN_PROD_DB_HOSTS = [
  "ep-ancient-butterfly",
  // The host .env.test pointed at when ~353 fixture accounts reached
  // production. Listed as production until proven otherwise; if it is in fact
  // a disposable branch, remove it here rather than working around it.
  "ep-blue-union",
];

/** Extracts the hostname from a Postgres URL without tripping over credentials. */
export function dbHostFromUrl(url: string): string | null {
  try {
    return new URL(url).hostname || null;
  } catch {
    return null;
  }
}

/**
 * Throws unless `url` points at a database that is safe to destroy.
 *
 * Allowed:
 *   - local Postgres (localhost / 127.0.0.1 / ::1 / host.docker.internal)
 *   - a host whose name exactly matches ALLOW_TEST_DB_HOST, which the operator
 *     must set deliberately (e.g. a Neon test branch in CI)
 *
 * Refused:
 *   - a known production host, always
 *   - any remote host that has not been named
 *   - a missing or unparseable URL — fail closed, never "cannot tell, proceed"
 *
 * `context` names the caller so the message points at whatever tried to run.
 */
export function assertNotProdDatabase(url: string, context: string): void {
  const host = dbHostFromUrl(url);

  if (!host) {
    throw new Error(
      `[${context}] REFUSING TO RUN: DATABASE_URL is missing or not a valid URL, ` +
        `so the target database cannot be identified. This command only runs against ` +
        `local Postgres or a host named in ALLOW_TEST_DB_HOST. See docs/environments.md.`,
    );
  }

  const prodMatch = KNOWN_PROD_DB_HOSTS.find((prod) => host.includes(prod));
  if (prodMatch) {
    throw new Error(
      `[${context}] REFUSING TO RUN against host "${host}", which matches the known ` +
        `PRODUCTION host "${prodMatch}". This command destroys or fabricates data and ` +
        `must never touch production. Check the loaded .env file and NODE_ENV. ` +
        `See docs/environments.md.`,
    );
  }

  if (ALWAYS_ALLOWED_HOSTS.includes(host)) return;

  const allowed = process.env.ALLOW_TEST_DB_HOST?.trim();
  if (allowed && host === allowed) return;

  throw new Error(
    `[${context}] REFUSING TO RUN against remote host "${host}". This command destroys ` +
      `or fabricates data, so it only runs against local Postgres by default. If this ` +
      `host really is a disposable test database, opt in explicitly with ` +
      `ALLOW_TEST_DB_HOST="${host}" — and be certain first, because this is exactly the ` +
      `check that stands between the test suite and live user accounts. ` +
      `See docs/environments.md.`,
  );
}
