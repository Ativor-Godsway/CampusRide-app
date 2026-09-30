/**
 * MUST be the first import of every dev-tool entry point (sim:riders,
 * sim:cleanup, sim:approve-driver). Importing it loads the dev environment and
 * refuses to continue unless the target is local Postgres or the dev Neon
 * branch — before anything can open a database connection.
 *
 * Why it has to come first: `@prisma/client` loads apps/server/.env the moment
 * it is required, and dotenv never overrides a variable that is already set.
 * If Prisma (or anything that imports it) loaded before this file, the base
 * .env — historically the PRODUCTION settings — would win over
 * .env.development, including DATABASE_URL and JWT_SECRET. Loading
 * .env.development here first makes it the one that sticks.
 */
import path from "node:path";
import dotenv from "dotenv";
import { assertDevelopmentEnv, assertDevOnlyDatabase } from "../../db/devDbGuard";

const serverRoot = path.resolve(__dirname, "..", "..", "..");

export function prepareDevToolEnv(context: string): void {
  assertDevelopmentEnv(process.env.NODE_ENV, context);
  process.env.NODE_ENV = "development";

  dotenv.config({ path: path.join(serverRoot, ".env.development") });

  // Never let the production escape hatch in db/prisma.ts apply to a process
  // that fabricates accounts, even if it is exported in the shell.
  delete process.env.ALLOW_PRODUCTION_DB;

  assertDevOnlyDatabase(process.env.DATABASE_URL ?? "", `${context} (DATABASE_URL)`);
  if (process.env.DIRECT_URL) {
    assertDevOnlyDatabase(process.env.DIRECT_URL, `${context} (DIRECT_URL)`);
  }
}

try {
  prepareDevToolEnv("simulator");
} catch (err) {
  console.error(`\n${(err as Error).message}\n`);
  process.exit(1);
}
