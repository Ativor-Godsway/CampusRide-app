import type { FastifyInstance } from "fastify";
import { APP_CONFIG_PATH, type AppConfig, type AppMinVersions } from "@rida/shared";
import { config } from "../config";
import { noInput } from "../http/schemas";

/**
 * GET /app/min-version — public, no login: the rider and driver apps ask it
 * on launch and on every return to the foreground whether their store
 * version is still allowed (@rida/shared config/appUpdate.ts). Per app and
 * platform: the lowest allowed version (null = nobody is blocked) and the
 * store link. The values are Render variables, read at boot
 * (lib/appMinVersions.ts); docs/runbooks/releasing.md says when to set them.
 * Not secret, and the same for everyone.
 */
export function registerAppVersionRoutes(
  app: FastifyInstance,
  versions: AppMinVersions = config.appMinVersions,
  appConfig: AppConfig = { supportPhone: config.supportPhone },
): void {
  app.get("/app/min-version", { schema: noInput }, async (_request, reply) => {
    // Always the current answer: a minimum raised on Render reaches every phone at its next check.
    return reply.header("cache-control", "no-store").send(versions);
  });

  /**
   * GET /app/config — public, no login: settings the apps read from the
   * server so they change without an app update. Today only the number
   * "Call support" dials (SUPPORT_PHONE on Render; the apps keep a built-in
   * one for when this can't be reached). Not secret, the same for everyone.
   */
  app.get(APP_CONFIG_PATH, { schema: noInput }, async (_request, reply) => {
    return reply.header("cache-control", "no-store").send(appConfig);
  });
}
