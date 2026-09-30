/**
 * The guard for DEVELOPMENT-ONLY tooling: the fake-rider simulator, its
 * cleanup, the dev driver-approval helper and `db:deploy:dev`. See
 * docs/testing/SOLO_TESTING.md.
 *
 * Stricter than dbHostGuard.ts on purpose. Those tools fabricate accounts and
 * delete rows, and there is no legitimate reason to ever point one at
 * production, so:
 *
 *   - ALLOW_PRODUCTION_DB is NEVER honoured (dbHostGuard's escape hatch for
 *     seedAdmin/cleanupTestAccounts does not apply here);
 *   - ALLOW_TEST_DB_HOST is not honoured either: the only remote database
 *     allowed is the dev Neon branch, named below in code, not by whatever
 *     happens to be exported in the shell;
 *   - NODE_ENV=production is refused outright;
 *   - a missing or unparseable URL is refused (fail closed).
 */
import { KNOWN_PROD_DB_HOSTS, dbHostFromUrl } from "./dbHostGuard";

/** Local Postgres. */
const LOCAL_DB_HOSTS = ["localhost", "127.0.0.1", "::1", "host.docker.internal"];

/**
 * The dev Neon branch (see docs/environments.md). Matched as a PREFIX of the
 * hostname, so both its pooled ("…-pooler…") and direct endpoints pass, and
 * nothing that merely contains the string somewhere else does.
 */
export const DEV_DB_HOST_PREFIXES = ["ep-flat-rain-"];

/** Throws unless NODE_ENV is "development" (or unset, which means development). */
export function assertDevelopmentEnv(nodeEnv: string | undefined, context: string): void {
  const env = nodeEnv ?? "development";
  if (env !== "development") {
    throw new Error(
      `[${context}] REFUSING TO RUN: NODE_ENV is "${env}". This is a development-only ` +
        `tool; run it with NODE_ENV unset or set to "development".`,
    );
  }
}

/**
 * Throws unless `url` points at local Postgres or the dev Neon branch.
 * Production is refused whatever ALLOW_PRODUCTION_DB / ALLOW_TEST_DB_HOST say.
 */
export function assertDevOnlyDatabase(url: string, context: string): void {
  const host = dbHostFromUrl(url);

  if (!host) {
    throw new Error(
      `[${context}] REFUSING TO RUN: the database URL is missing or not a valid URL, so ` +
        `the target cannot be identified. Check apps/server/.env.development.`,
    );
  }

  const prodMatch = KNOWN_PROD_DB_HOSTS.find((prod) => host.includes(prod));
  if (prodMatch) {
    throw new Error(
      `[${context}] REFUSING TO RUN against "${host}": that is the PRODUCTION database ` +
        `("${prodMatch}"). This tool creates fake accounts and deletes rows, so it never ` +
        `runs against production, and no environment variable can change that ` +
        `(ALLOW_PRODUCTION_DB is ignored here).`,
    );
  }

  if (LOCAL_DB_HOSTS.includes(host)) return;
  if (DEV_DB_HOST_PREFIXES.some((prefix) => host.startsWith(prefix))) return;

  throw new Error(
    `[${context}] REFUSING TO RUN against "${host}". This tool only runs against local ` +
      `Postgres or the dev Neon branch (${DEV_DB_HOST_PREFIXES.join(", ")}…). ` +
      `Check apps/server/.env.development.`,
  );
}

/** True for IPv4 addresses in the private LAN ranges (10/8, 172.16/12, 192.168/16). */
function isPrivateIpv4(host: string): boolean {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

/**
 * Throws unless `url` is a server on this machine or the local network. The
 * simulator must never send its fake riders to the deployed (Render) server.
 */
export function assertLocalApiUrl(url: string, context: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`[${context}] "${url}" is not a valid server URL (e.g. http://localhost:3000).`);
  }
  const host = parsed.hostname.replace(/^\[|\]$/g, "");
  const isLocal =
    host === "localhost" || host === "::1" || /^127\./.test(host) || isPrivateIpv4(host);
  if (!isLocal || (parsed.protocol !== "http:" && parsed.protocol !== "https:")) {
    throw new Error(
      `[${context}] REFUSING TO USE server "${url}". The simulator only talks to a server ` +
        `running on this Mac or your local network (e.g. http://localhost:3000), never to ` +
        `the deployed one.`,
    );
  }
}
