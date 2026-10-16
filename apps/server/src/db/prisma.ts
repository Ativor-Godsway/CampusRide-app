import { PrismaClient } from "@prisma/client";
import { config } from "../config";
import { assertDatabaseAllowedForEnv } from "./dbHostGuard";

/**
 * THE CHOKEPOINT. Every database connection in the server is created here, so
 * this is where "is this database allowed?" is enforced — not in a test setup
 * file that only covers the test suite, and not in a package script that only
 * covers the commands that happen to call it.
 *
 * `npm test` is `vitest run`; it never invokes the `db:guard` script. Before
 * this check existed, the only thing pointing the suite away from production
 * was whichever .env file got loaded — and ~353 fixture accounts reached the
 * live database as a result. Guarding at construction means vitest, ts-node
 * scripts and the dev server all inherit the same refusal, whatever their
 * entry point.
 *
 * Production is unaffected: NODE_ENV=production is allowed to connect to
 * production, which is the only environment that should.
 */
assertDatabaseAllowedForEnv(config.databaseUrl, config.nodeEnv, "prisma client");

const globalForPrisma = globalThis as unknown as { prisma: PrismaClient };

/**
 * Every SQL statement printed ("prisma:query …") only on a developer's
 * machine, or with PRISMA_QUERY_LOG=true. It used to be on everywhere: in
 * production a log line per query, about a sixth of the server's JavaScript
 * time under load (docs/runbooks/load-test.md) and most of Render's log
 * volume. Errors and warnings are always logged.
 */
export function prismaLogLevels(
  env: NodeJS.ProcessEnv = process.env,
): Array<"query" | "error" | "warn"> {
  const queries =
    env.PRISMA_QUERY_LOG === "true" ||
    (env.NODE_ENV === "development" && env.PRISMA_QUERY_LOG !== "false");
  return queries ? ["query", "error", "warn"] : ["error", "warn"];
}

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: prismaLogLevels(),
  });

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
}
