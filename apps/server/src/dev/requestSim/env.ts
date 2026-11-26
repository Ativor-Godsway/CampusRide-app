/**
 * MUST be the first import of the request simulator's entry points. Loads
 * apps/server/.env.phase2-test (before Prisma can load the base .env) and
 * refuses to continue unless it points at the phase2-test branch — never
 * production (db/phase2Guard.ts). See TESTING-PHASE2.md.
 *
 * With `--staging` (npm run staging:fake-requests): apps/server/.env.staging
 * instead, the staging branch only (db/stagingGuard.ts), and the deployed
 * STAGING server (STAGING.md).
 */
import path from "node:path";
import dotenv from "dotenv";
import { assertDevelopmentEnv } from "../../db/devDbGuard";
import { assertPhase2Database } from "../../db/phase2Guard";
import { assertStagingDatabase } from "../../db/stagingGuard";

/** Whether the simulator runs against staging (`--staging`). */
export const SIM_ON_STAGING = process.argv.includes("--staging");

const serverRoot = path.resolve(__dirname, "..", "..", "..");

try {
  assertDevelopmentEnv(process.env.NODE_ENV, "simulate:requests");
  if (SIM_ON_STAGING) {
    const staged = dotenv.config({ path: path.join(serverRoot, ".env.staging"), override: true });
    if (staged.error) throw new Error("[staging:fake-requests] REFUSING TO RUN: apps/server/.env.staging is missing. See STAGING.md.");
    delete process.env.ALLOW_PRODUCTION_DB;
    assertStagingDatabase(process.env.DATABASE_URL ?? "", "staging:fake-requests (DATABASE_URL)");
    assertStagingDatabase(process.env.DIRECT_URL ?? "", "staging:fake-requests (DIRECT_URL)");
    if (!process.env.STAGING_API_URL || !process.env.JWT_SECRET) {
      throw new Error("[staging:fake-requests] STAGING_API_URL or JWT_SECRET is missing from apps/server/.env.staging: run npm run staging:secrets first.");
    }
  } else {
    const loaded = dotenv.config({ path: path.join(serverRoot, ".env.phase2-test"), override: true });
    if (loaded.error) throw new Error("[simulate:requests] REFUSING TO RUN: apps/server/.env.phase2-test is missing. See TESTING-PHASE2.md.");
    process.env.NODE_ENV = "development";
    delete process.env.ALLOW_PRODUCTION_DB;
    assertPhase2Database(process.env.DATABASE_URL ?? "", "simulate:requests (DATABASE_URL)");
    assertPhase2Database(process.env.DIRECT_URL ?? "", "simulate:requests (DIRECT_URL)");
  }
} catch (err) {
  console.error(`\n${(err as Error).message}\n`);
  process.exit(1);
}
