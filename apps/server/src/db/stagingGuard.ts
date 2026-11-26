/**
 * The guard for STAGING (STAGING.md): the staging server, its migrations,
 * its seed and the fake-request simulator run against the Neon branch
 * "staging" and nothing else.
 *
 * - The production endpoint is refused outright, whatever any variable says
 *   (and every other known production host too).
 * - The only host allowed is the staging branch's own endpoint, named here
 *   in code (pooled or direct), not by whatever is exported in a shell.
 * - A missing or unparseable URL is refused (fail closed).
 */
import { KNOWN_PROD_DB_HOSTS, dbHostFromUrl } from "./dbHostGuard";

/** The production compute endpoint. Never, under any circumstances. */
export const PRODUCTION_ENDPOINT = "ep-empty-violet-bay5yr3y";

/**
 * The "staging" branch's endpoint (Neon project withered-voice-05688596,
 * branch br-lucky-pond-babkub8l, created 2026-11-26 schema-only: no
 * production rows). A host name, not a secret.
 */
export const STAGING_DB_HOST_PREFIX = "ep-divine-unit-ba9dcaud";

export function assertStagingDatabase(url: string, context: string): void {
  if (url.includes(PRODUCTION_ENDPOINT)) {
    throw new Error(`[${context}] REFUSING TO RUN: that URL is the PRODUCTION database (${PRODUCTION_ENDPOINT}). Staging only runs against the staging branch.`);
  }
  const host = dbHostFromUrl(url);
  if (!host) {
    throw new Error(`[${context}] REFUSING TO RUN: the database URL is missing or not a valid URL. Check apps/server/.env.staging.`);
  }
  const prod = KNOWN_PROD_DB_HOSTS.find((p) => host.includes(p));
  if (prod) throw new Error(`[${context}] REFUSING TO RUN against "${host}": that is a PRODUCTION host ("${prod}").`);
  if (!host.startsWith(STAGING_DB_HOST_PREFIX)) {
    throw new Error(`[${context}] REFUSING TO RUN against "${host}": staging only runs against the staging branch (${STAGING_DB_HOST_PREFIX}…).`);
  }
}
