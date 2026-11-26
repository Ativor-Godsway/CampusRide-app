import { KNOWN_PROD_DB_HOSTS, dbHostFromUrl } from "../db/dbHostGuard";
import { STAGING_DB_HOST_PREFIX } from "../db/stagingGuard";

/**
 * The STAGING server (STAGING.md): a full test copy of CampusRide on its own
 * Render service, its own Neon branch and its own "CampusRide Staging" apps.
 * It runs with NODE_ENV=production — every production safeguard, the real
 * rate limits, closed CORS — plus CAMPUSRIDE_ENV=staging, which allows
 * exactly these differences and nothing else:
 *
 * - login codes are never texted (no SMS provider): the test numbers
 *   (+233 99 …, a range no Ghanaian network uses) sign in with the fixed
 *   STAGING_TEST_OTP; any other number gets a random code nobody receives;
 * - a Paystack TEST key (sk_test_…) is allowed, a live one refused;
 * - Moolre payments and SMS must be off;
 * - the admin site may also be run on this Mac against it (http://localhost
 *   origins).
 *
 * And it refuses to start unless BOTH database URLs are the staging branch
 * (never any known production host), so the flag can never loosen
 * production: set by mistake on the production service, that server would
 * simply not start.
 */

type Env = Record<string, string | undefined>;

/** Numbers that sign in with the fixed code on staging: +233 99 …, unused by any Ghanaian network. */
export const STAGING_TEST_PHONE = /^\+23399\d{7}$/;

/** Whether this server was told it is staging. */
export function isStagingServer(env: Env = process.env): boolean {
  return env.CAMPUSRIDE_ENV?.trim() === "staging";
}

function isStagingDbUrl(url: string | undefined): boolean {
  const host = dbHostFromUrl(url ?? "");
  if (!host || KNOWN_PROD_DB_HOSTS.some((p) => host.includes(p))) return false;
  return host.startsWith(STAGING_DB_HOST_PREFIX);
}

/**
 * Why a server that says it is staging may not start (setting NAMES only,
 * never values). Empty when it isn't staging, or all is well.
 */
export function stagingProblems(env: Env = process.env): string[] {
  if (!isStagingServer(env)) return [];
  const problems: string[] = [];
  if (!isStagingDbUrl(env.DATABASE_URL)) problems.push("DATABASE_URL is not the staging database branch");
  if (!isStagingDbUrl(env.DIRECT_URL)) problems.push("DIRECT_URL is not the staging database branch");
  if (!/^\d{6}$/.test(env.STAGING_TEST_OTP?.trim() ?? "")) problems.push("STAGING_TEST_OTP must be exactly 6 digits");
  if ((env.PAYSTACK_SECRET_KEY ?? "").trim().startsWith("sk_live_"))
    problems.push("PAYSTACK_SECRET_KEY is a LIVE key: staging takes a Paystack test key (sk_test_…) or none");
  const on = (v: string | undefined) => v?.trim() === "true";
  if (on(env.MOOLRE_PAYMENTS_ENABLED) || on(env.MOOLRE_ENABLED)) problems.push("Moolre payments must be off on staging");
  if (on(env.MOOLRE_SMS_ENABLED) || on(env.MNOTIFY_ENABLED)) problems.push("SMS must be off on staging");
  if (env.REVIEW_DEMO_ENABLED?.trim() === "true") problems.push("REVIEW_DEMO_ENABLED must be off on staging");
  return problems;
}

/**
 * The fixed login code for a test number on a staging server that passes
 * every check above; null for anything else (a real random code).
 */
export function stagingOtpCodeFor(phone: string, env: Env = process.env): string | null {
  if (!isStagingServer(env) || stagingProblems(env).length > 0) return null;
  return STAGING_TEST_PHONE.test(phone) ? env.STAGING_TEST_OTP!.trim() : null;
}
