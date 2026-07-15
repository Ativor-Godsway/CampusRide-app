/**
 * Pre-flight guard for the branch-scoped db scripts (db:reset:*, db:seed:*,
 * db:migrate:*). Run AFTER dotenv-cli has loaded the target `.env.<env>` file
 * and BEFORE any Prisma command, chained with `&&`. Aborts (non-zero exit) if
 * either connection string points at production. Shares the host allowlist with
 * the vitest guardrail via src/db/dbHostGuard.ts.
 */
import { assertNotProdDatabase } from "../db/dbHostGuard";

assertNotProdDatabase(process.env.DATABASE_URL ?? "", "db script (DATABASE_URL)");
assertNotProdDatabase(process.env.DIRECT_URL ?? "", "db script (DIRECT_URL)");

console.log("[db guard] OK — target is a non-production database.");
