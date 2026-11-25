/**
 * MUST be the first import of the request simulator's entry points. Loads
 * apps/server/.env.phase2-test (before Prisma can load the base .env) and
 * refuses to continue unless it points at the phase2-test branch — never
 * production (db/phase2Guard.ts). See TESTING-PHASE2.md.
 */
import path from "node:path";
import dotenv from "dotenv";
import { assertDevelopmentEnv } from "../../db/devDbGuard";
import { assertPhase2Database } from "../../db/phase2Guard";

const serverRoot = path.resolve(__dirname, "..", "..", "..");

try {
  assertDevelopmentEnv(process.env.NODE_ENV, "simulate:requests");
  const loaded = dotenv.config({ path: path.join(serverRoot, ".env.phase2-test"), override: true });
  if (loaded.error) throw new Error("[simulate:requests] REFUSING TO RUN: apps/server/.env.phase2-test is missing. See TESTING-PHASE2.md.");
  process.env.NODE_ENV = "development";
  delete process.env.ALLOW_PRODUCTION_DB;
  assertPhase2Database(process.env.DATABASE_URL ?? "", "simulate:requests (DATABASE_URL)");
  assertPhase2Database(process.env.DIRECT_URL ?? "", "simulate:requests (DIRECT_URL)");
} catch (err) {
  console.error(`\n${(err as Error).message}\n`);
  process.exit(1);
}
