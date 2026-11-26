/**
 * MUST be the first import of every staging script (STAGING.md). Loads
 * apps/server/.env.staging (gitignored) over anything in the shell, and
 * refuses to continue unless both database URLs are the Neon "staging"
 * branch — never production (db/stagingGuard.ts). Prints no URL or secret.
 */
import path from "node:path";
import dotenv from "dotenv";
import { assertStagingDatabase } from "../../db/stagingGuard";

export const SERVER_ROOT = path.resolve(__dirname, "..", "..", "..");
export const STAGING_ENV_FILE = path.join(SERVER_ROOT, ".env.staging");

export function loadStagingEnv(context: string): void {
  const loaded = dotenv.config({ path: STAGING_ENV_FILE, override: true });
  if (loaded.error) throw new Error(`[${context}] REFUSING TO RUN: apps/server/.env.staging is missing. See STAGING.md.`);
  delete process.env.ALLOW_PRODUCTION_DB;
  assertStagingDatabase(process.env.DATABASE_URL ?? "", `${context} (DATABASE_URL)`);
  assertStagingDatabase(process.env.DIRECT_URL ?? "", `${context} (DIRECT_URL)`);
}

try {
  loadStagingEnv(path.basename(process.argv[1] ?? "staging"));
} catch (err) {
  console.error(`\n${(err as Error).message}\n`);
  process.exit(1);
}
