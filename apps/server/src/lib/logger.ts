/* eslint-disable no-console -- This module IS the logging choke point: it is
   the one place console.* is the implementation rather than a stray debug
   statement. Everything else in production source goes through here. */

/**
 * Minimal structured logger for code that runs outside a request.
 *
 * Most server code should use Fastify's own logger (`request.log` / `app.log`),
 * which already carries request ids and is what the route layer uses. But
 * fire-and-forget background work — a `.catch()` on a broadcast, an SMS retry —
 * has no request in scope and was reaching for bare `console.*`, producing
 * unstructured lines that no log aggregator can filter or alert on.
 *
 * This emits a single JSON object per line, matching the shape Fastify's pino
 * logger already produces, so both sources read the same way downstream.
 * Deliberately dependency-free: pulling pino in directly here would mean two
 * separately-configured logger instances in one process.
 */

type LogLevel = "info" | "warn" | "error";

/** Structured fields attached to a log line. `err` is unwrapped, not stringified. */
export interface LogContext {
  [key: string]: unknown;
}

function serializeError(err: unknown): unknown {
  if (err instanceof Error) {
    return { type: err.name, message: err.message, stack: err.stack };
  }
  return err;
}

function emit(level: LogLevel, message: string, context: LogContext = {}): void {
  const { err, ...rest } = context;

  const line = JSON.stringify({
    level,
    time: new Date().toISOString(),
    msg: message,
    ...rest,
    ...(err !== undefined ? { err: serializeError(err) } : {}),
  });

  if (level === "error") {
    console.error(line);
  } else if (level === "warn") {
    console.warn(line);
  } else {
    console.log(line);
  }
}

export const logger = {
  info: (message: string, context?: LogContext) => emit("info", message, context),
  warn: (message: string, context?: LogContext) => emit("warn", message, context),
  error: (message: string, context?: LogContext) => emit("error", message, context),
};
