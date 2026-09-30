/**
 * Pre-flight guard for `db:deploy:dev`. Run AFTER dotenv-cli has loaded
 * .env.development and BEFORE Prisma, chained with `&&`. Allows only local
 * Postgres or the dev Neon branch; refuses production whatever
 * ALLOW_PRODUCTION_DB / ALLOW_TEST_DB_HOST say. See src/db/devDbGuard.ts.
 */
import { assertDevOnlyDatabase } from "../db/devDbGuard";

try {
  assertDevOnlyDatabase(process.env.DATABASE_URL ?? "", "db:deploy:dev (DATABASE_URL)");
  assertDevOnlyDatabase(process.env.DIRECT_URL ?? "", "db:deploy:dev (DIRECT_URL)");
} catch (err) {
  console.error(`\n${(err as Error).message}\n`);
  process.exit(1);
}

console.log("[dev db guard] OK — target is local Postgres or the dev branch.");
