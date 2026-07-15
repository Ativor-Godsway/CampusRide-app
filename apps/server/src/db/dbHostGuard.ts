/**
 * Single source of truth for the production-database host guard.
 *
 * Used by BOTH the vitest setup guardrail (src/test/setup.ts) and the
 * branch-scoped db scripts (src/scripts/assertNonProdDb.ts), so no destructive
 * or dev/test-only command can ever run against production — even if an env
 * file is misconfigured. See docs/environments.md.
 */

/** Neon compute host of the PRODUCTION branch. Never a valid target for dev/test/reset commands. */
export const PROD_DB_HOST = "ep-ancient-butterfly";

/**
 * Throws if `url` targets the production Neon host. `context` names the caller
 * so the failure message points at whatever tried to run against prod.
 */
export function assertNotProdDatabase(url: string, context: string): void {
  if (url.includes(PROD_DB_HOST)) {
    throw new Error(
      `[${context}] REFUSING TO RUN against the PRODUCTION database ` +
        `(host "${PROD_DB_HOST}"). This command is only for the dev/test databases ` +
        `(Neon dev branch or local Postgres). Check the loaded .env file and NODE_ENV. ` +
        `See docs/environments.md.`,
    );
  }
}
