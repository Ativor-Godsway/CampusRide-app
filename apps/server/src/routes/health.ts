import type { FastifyInstance } from "fastify";
import type { PrismaClient } from "@prisma/client";
import { APP_NAME } from "../config";
import { noInput } from "../http/schemas";
import { noteDatabaseError } from "../lib/alerts";
import { isStagingServer, stagingProblems } from "../lib/stagingMode";

/** How long /health/ready waits for the database (a Neon compute waking up takes well under this). */
export const READY_DB_TIMEOUT_MS = 3000;

export type DatabaseState = "ok" | "unreachable" | "timeout";

/** One trivial query, abandoned after `timeoutMs`. */
export async function checkDatabase(
  prisma: Pick<PrismaClient, "$queryRaw">,
  timeoutMs = READY_DB_TIMEOUT_MS,
): Promise<{ state: DatabaseState; error?: unknown }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), timeoutMs);
  });
  try {
    const result = await Promise.race([
      prisma.$queryRaw`SELECT 1`.then(() => "ok" as const),
      timeout,
    ]);
    return { state: result };
  } catch (error) {
    return { state: "unreachable", error };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * True only on a STAGING server that passes every staging check
 * (lib/stagingMode.ts): the same condition that lets the test numbers sign
 * in with the fixed code. /health then says `staging: true`, so the admin
 * site can accept the test numbers as typed ("99 000 0021"). Production
 * never has the field.
 */
export function isWorkingStagingServer(env: Record<string, string | undefined> = process.env): boolean {
  return isStagingServer(env) && stagingProblems(env).length === 0;
}

/**
 * Two health checks (Stage 5), both unlimited and public, saying nothing
 * beyond up or down (and, on the staging server only, that it is staging):
 *
 * - GET /health — the process is running. Render's health check: kept free
 *   of any database call, so a database outage doesn't make Render restart a
 *   healthy server over and over.
 * - GET /health/ready — the server can also reach the database (one
 *   `SELECT 1`, at most 3 s). 503 when it can't. For the UptimeRobot
 *   monitor, so an outage of either one sends an alert.
 */
export function registerHealthRoutes(
  app: FastifyInstance,
  prisma: Pick<PrismaClient, "$queryRaw">,
  timeoutMs = READY_DB_TIMEOUT_MS,
): void {
  app.get("/health", { config: { limits: false }, schema: noInput }, async () => {
    return isWorkingStagingServer() ? { status: "ok", app: APP_NAME, staging: true } : { status: "ok", app: APP_NAME };
  });

  app.get(
    "/health/ready",
    { config: { limits: false }, schema: noInput },
    async (request, reply) => {
      const { state, error } = await checkDatabase(prisma, timeoutMs);
      if (state === "ok") return { status: "ok", app: APP_NAME, database: "ok" };
      request.log.warn({ err: error, database: state }, "Readiness check: database not reachable");
      noteDatabaseError(
        error ??
          Object.assign(new Error("Can't reach database server (timed out)"), { code: "P1001" }),
        "health_ready",
      );
      return reply.code(503).send({ status: "unavailable", app: APP_NAME, database: state });
    },
  );
}
