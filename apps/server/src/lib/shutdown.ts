import type { FastifyBaseLogger, FastifyInstance } from "fastify";
import type { Server as SocketServer } from "socket.io";

export interface ShutdownDeps {
  app: FastifyInstance;
  io: SocketServer | null;
  log: FastifyBaseLogger;
  /** The server's repeating jobs (the ride timeout sweep, push receipts). */
  timers: Array<ReturnType<typeof setInterval>>;
  disconnectDatabase: () => Promise<void>;
  /** Sends any error reports still queued (Sentry), before the exit. */
  flushReports?: () => Promise<void>;
  exit?: (code: number) => void;
  /** Past this, exit anyway (Render kills the process ~30 s after SIGTERM). */
  timeoutMs?: number;
}

/**
 * A clean stop, for a deploy (Render sends SIGTERM) or after a crash:
 *
 *   1. stop the repeating jobs, so nothing new starts;
 *   2. stop accepting requests (new ones get 503), let the ones in flight
 *      finish — a driver's "picked up" isn't cut off halfway;
 *   3. close every socket, so the apps reconnect to the new server at once;
 *   4. close the database connections;
 *   5. exit.
 *
 * Runs once however many signals arrive; gives up and exits after
 * `timeoutMs` if something hangs.
 */
export function createShutdown(
  deps: ShutdownDeps,
): (reason: string, exitCode?: number) => Promise<void> {
  const exit = deps.exit ?? ((code: number) => process.exit(code));
  const timeoutMs = deps.timeoutMs ?? 20_000;
  let running: Promise<void> | null = null;

  return (reason, exitCode = 0) => {
    if (running) return running;
    running = (async () => {
      deps.log.info({ event: "shutdown", reason }, "Shutting down: finishing in-flight requests");
      const giveUp = setTimeout(() => {
        deps.log.error(
          { event: "shutdown_timeout", reason },
          "Shutdown took too long; exiting anyway",
        );
        exit(exitCode === 0 ? 1 : exitCode);
      }, timeoutMs);
      giveUp.unref?.();

      for (const timer of deps.timers) clearInterval(timer);
      // A keep-alive connection (the load balancer's, an app's) whose request
      // has finished would hold the server open for Fastify's 72 s keep-alive
      // timeout: close each one as soon as it goes idle.
      const closeIdle = setInterval(() => deps.app.server.closeIdleConnections?.(), 100);
      closeIdle.unref?.();
      try {
        // Sockets would hold the HTTP server open: close them as it stops
        // taking connections (and once more just after, for any that slipped in).
        deps.io?.disconnectSockets(true);
        const closing = deps.app.close();
        setImmediate(() => deps.io?.disconnectSockets(true));
        await closing;
        await deps.disconnectDatabase();
        await deps.flushReports?.();
        deps.log.info({ event: "shutdown_complete", reason }, "Shut down cleanly");
      } catch (err) {
        deps.log.error({ err, event: "shutdown_error", reason }, "Error while shutting down");
      } finally {
        clearInterval(closeIdle);
        clearTimeout(giveUp);
        exit(exitCode);
      }
    })();
    return running;
  };
}
