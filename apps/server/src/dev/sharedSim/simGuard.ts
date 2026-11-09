/**
 * MUST be the first import of `npm run simulate:shared` (cli.ts): loads the
 * local dev environment and refuses to go on unless the database is a local
 * Postgres and nothing points at the production API — before Prisma (which
 * reads apps/server/.env the moment it loads) can open a connection.
 */
import path from "node:path";
import dotenv from "dotenv";
import { assertSimTargetIsLocal } from "./simTarget";

const serverRoot = path.resolve(__dirname, "..", "..", "..");

try {
  if ((process.env.NODE_ENV ?? "development") !== "development") {
    throw new Error(`REFUSING TO RUN: NODE_ENV is "${process.env.NODE_ENV}". Run it with NODE_ENV unset.`);
  }
  process.env.NODE_ENV = "development";
  // --test-db: the local test database (rida_test, migrated by the test
  // suite) instead of the local dev one.
  if (process.argv.includes("--test-db")) dotenv.config({ path: path.join(serverRoot, ".env.test") });
  // .env.development.local (the local Postgres URL) wins over .env.development.
  dotenv.config({ path: path.join(serverRoot, ".env.development.local") });
  dotenv.config({ path: path.join(serverRoot, ".env.development") });
  // Never the production escape hatch in db/prisma.ts.
  delete process.env.ALLOW_PRODUCTION_DB;
  // The timeline is the output: no line per database query.
  process.env.PRISMA_QUERY_LOG ??= "false";
  assertSimTargetIsLocal(process.env);
} catch (err) {
  console.error(`\n[simulate:shared] ${(err as Error).message}\n`);
  process.exit(1);
}
