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

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: ["query", "error", "warn"],
  });

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
}
