import { logger } from "./logger";

/**
 * What to do with an error nothing caught — an unhandled promise rejection
 * or an uncaught exception. The process can't be trusted after one, so it is
 * logged (scrubbed) and the server shuts down and exits non-zero; Render
 * starts a fresh one. Stage 5 also reports these to Sentry, here.
 */
export type FatalHandler = (kind: "unhandledRejection" | "uncaughtException", err: unknown) => void;

let handler: FatalHandler = (kind, err) => {
  // Before the server exists there is nothing to shut down gracefully.
  logger.error(`Fatal ${kind} during startup`, { err });
  process.exit(1);
};

/** Replaces what happens on a fatal error (index.ts: log + graceful shutdown). */
export function onFatal(next: FatalHandler): void {
  handler = next;
}

let installed = false;

/** Listens for unhandled rejections and uncaught exceptions, once. */
export function installFatalHandlers(): void {
  if (installed) return;
  installed = true;
  process.on("unhandledRejection", (reason) => handler("unhandledRejection", reason));
  process.on("uncaughtException", (err) => handler("uncaughtException", err));
}
