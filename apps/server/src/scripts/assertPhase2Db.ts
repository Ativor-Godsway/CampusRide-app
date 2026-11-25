/**
 * `npm run phase2:guard` — refuses to go on unless DATABASE_URL and DIRECT_URL
 * are the phase2-test branch (db/phase2Guard.ts). Run before the Phase 2
 * server and migration (TESTING-PHASE2.md). Prints the host only, never a URL.
 */
import { dbHostFromUrl } from "../db/dbHostGuard";
import { assertPhase2Database } from "../db/phase2Guard";

try {
  assertPhase2Database(process.env.DATABASE_URL ?? "", "phase2:guard (DATABASE_URL)");
  assertPhase2Database(process.env.DIRECT_URL ?? "", "phase2:guard (DIRECT_URL)");
  if (process.env.PUSH_DISABLED !== "true") throw new Error("[phase2:guard] REFUSING TO RUN: PUSH_DISABLED must be true (this database holds real people's push tokens).");
  if (process.env.OTP_PROVIDER !== "dummy") throw new Error("[phase2:guard] REFUSING TO RUN: OTP_PROVIDER must be dummy (no texts to real numbers).");
  for (const v of ["MOOLRE_ENABLED", "MOOLRE_SMS_ENABLED", "MOOLRE_PAYMENTS_ENABLED", "MNOTIFY_ENABLED"]) {
    if (process.env[v] === "true") throw new Error(`[phase2:guard] REFUSING TO RUN: ${v} must not be true.`);
  }
  console.log(`[phase2:guard] OK — phase2-test branch (${dbHostFromUrl(process.env.DATABASE_URL ?? "")}); push, SMS and payments off.`);
} catch (err) {
  console.error(`\n${(err as Error).message}\n`);
  process.exit(1);
}
