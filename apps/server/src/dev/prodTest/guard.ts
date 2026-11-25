/**
 * MUST be the first import of prodtest:requests and prodtest:cleanup (see
 * TESTING-PROD-BOARD.md). Before anything can load a .env file or open a
 * database connection:
 *
 * - DATABASE_URL must come from the shell (typed by the operator), never from
 *   a file in the repo: it's read here, before dotenv runs;
 * - production (ep-empty-violet…) only with ALLOW_PRODUCTION_DB=1; the
 *   phase2-test copy is allowed for a rehearsal; anything else is refused;
 * - push, SMS and payments are switched off for this process.
 * The URL is never printed — the host only.
 */
import { KNOWN_PROD_DB_HOSTS, dbHostFromUrl } from "../../db/dbHostGuard";
import { PHASE2_DB_HOST_PREFIX } from "../../db/phase2Guard";

export const PROD_TEST_DRIVER_PHONE = "+233548608146";

function refuse(message: string): never {
  console.error(`\n[prodtest] REFUSING TO RUN: ${message}\n`);
  process.exit(1);
}

const url = process.env.DATABASE_URL ?? "";
if (!url) refuse("DATABASE_URL isn't set in this terminal. Export it first (see TESTING-PROD-BOARD.md).");
const host = dbHostFromUrl(url);
if (!host) refuse("DATABASE_URL isn't a valid URL.");
const isProd = KNOWN_PROD_DB_HOSTS.some((p) => host.includes(p));
const isPhase2 = host.startsWith(PHASE2_DB_HOST_PREFIX);
if (isProd && process.env.ALLOW_PRODUCTION_DB !== "1") refuse("that is the PRODUCTION database; set ALLOW_PRODUCTION_DB=1 in this terminal to mean it.");
if (!isProd && !isPhase2) refuse(`"${host}" is neither production nor the phase2-test copy.`);
if (!process.env.DIRECT_URL) process.env.DIRECT_URL = url;
/** The Neon endpoint, the same for a pooled ("…-pooler") and a direct URL. */
const endpoint = (h: string | null) => (h ?? "").split(".")[0]!.replace(/-pooler$/, "");
if (endpoint(dbHostFromUrl(process.env.DIRECT_URL)) !== endpoint(host)) refuse("DIRECT_URL points at a different database from DATABASE_URL.");

process.env.NODE_ENV = "development";
process.env.PUSH_DISABLED = "true";
process.env.OTP_PROVIDER = "dummy";
process.env.MOOLRE_ENABLED = "false";
process.env.MOOLRE_SMS_ENABLED = "false";
process.env.MOOLRE_PAYMENTS_ENABLED = "false";
process.env.MNOTIFY_ENABLED = "false";
process.env.ENABLE_MOCK_DRIVER = "false";

export const TARGET = { host, isProd };
