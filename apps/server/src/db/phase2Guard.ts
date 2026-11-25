/**
 * The guard for Phase 2 testing (TESTING-PHASE2.md): the local server, the
 * migration and the request simulator run against the Neon branch
 * "phase2-test" — a COPY of production made 2026-11-25 — and nothing else.
 *
 * - The production endpoint is refused outright, whatever any variable says
 *   (and every other known production host too).
 * - The only host allowed is the phase2-test branch's own endpoint, named
 *   here in code (pooled or direct), not by whatever is exported in a shell.
 * - A missing or unparseable URL is refused (fail closed).
 */
import { KNOWN_PROD_DB_HOSTS, dbHostFromUrl } from "./dbHostGuard";

/** The production compute endpoint. Never, under any circumstances. */
export const PRODUCTION_ENDPOINT = "ep-empty-violet-bay5yr3y";

/** The "phase2-test" branch's endpoint (Neon project withered-voice-05688596, branch br-quiet-dew-bas6bia0). */
export const PHASE2_DB_HOST_PREFIX = "ep-tiny-bread-bazvjtbb";

export function assertPhase2Database(url: string, context: string): void {
  if (url.includes(PRODUCTION_ENDPOINT)) {
    throw new Error(`[${context}] REFUSING TO RUN: that URL is the PRODUCTION database (${PRODUCTION_ENDPOINT}). Phase 2 testing only runs against the phase2-test branch.`);
  }
  const host = dbHostFromUrl(url);
  if (!host) {
    throw new Error(`[${context}] REFUSING TO RUN: the database URL is missing or not a valid URL. Check apps/server/.env.phase2-test.`);
  }
  const prod = KNOWN_PROD_DB_HOSTS.find((p) => host.includes(p));
  if (prod) throw new Error(`[${context}] REFUSING TO RUN against "${host}": that is a PRODUCTION host ("${prod}").`);
  if (!host.startsWith(PHASE2_DB_HOST_PREFIX)) {
    throw new Error(`[${context}] REFUSING TO RUN against "${host}": Phase 2 testing only runs against the phase2-test branch (${PHASE2_DB_HOST_PREFIX}…).`);
  }
}
