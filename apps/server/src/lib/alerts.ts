import { logger } from "./logger";
import { reportMessage, type ReportContext } from "./monitoring";

/**
 * The problems worth waking someone for (Stage 5), reported to Sentry at
 * error level and logged with an `alert` field so they can be found in
 * Render's logs too. Without SENTRY_DSN only the log line is written.
 *
 * Some failures happen now and then for harmless reasons — a phone that
 * was switched off, a database blip, a stale socket. Those report only when
 * they pile up: `threshold` of them within `windowMs`, then at most once per
 * `cooldownMs`. Every SMS failure reports on its own (sendMoolreSms), since
 * one means somebody couldn't sign in.
 */

export interface ThresholdAlertOptions {
  /** Short stable name, the `alert` tag in Sentry and the logs. */
  kind: string;
  /** What the Sentry issue is called. */
  message: string;
  threshold: number;
  windowMs: number;
  cooldownMs: number;
  now?: () => number;
  report?: (message: string, context: ReportContext) => void;
}

/** Counts failures in a sliding window; reports when there are too many. */
export class ThresholdAlert {
  private times: number[] = [];
  private lastReportAt = -Infinity;

  constructor(private readonly opts: ThresholdAlertOptions) {}

  /** Notes one failure. Returns true when this one set the alert off. */
  record(detail: Record<string, unknown> = {}): boolean {
    const now = (this.opts.now ?? Date.now)();
    this.times.push(now);
    this.times = this.times.filter((t) => now - t < this.opts.windowMs).slice(-this.opts.threshold);
    if (this.times.length < this.opts.threshold) return false;
    if (now - this.lastReportAt < this.opts.cooldownMs) return false;
    this.lastReportAt = now;
    const minutes = Math.round(this.opts.windowMs / 60_000);
    const extra = { ...detail, count: this.times.length, windowMinutes: minutes };
    logger.error(`ALERT: ${this.opts.message}`, { alert: this.opts.kind, ...extra });
    (this.opts.report ?? reportMessage)(
      `${this.opts.message} (${this.times.length} in ${minutes} min)`,
      {
        level: "error",
        tags: { alert: this.opts.kind },
        extra,
      },
    );
    return true;
  }

  /** Tests only. */
  reset(): void {
    this.times = [];
    this.lastReportAt = -Infinity;
  }
}

const MINUTE = 60_000;

export const alerts = {
  /** Pushes Expo refused or couldn't deliver (an uninstalled app doesn't count). */
  pushFailures: new ThresholdAlert({
    kind: "push_failures",
    message: "Push notifications are failing",
    threshold: 10,
    windowMs: 15 * MINUTE,
    cooldownMs: 60 * MINUTE,
  }),
  /** The database can't be reached, refuses connections or has no free connection. */
  databaseConnection: new ThresholdAlert({
    kind: "database_connection",
    message: "The server can't reach the database",
    threshold: 3,
    windowMs: 5 * MINUTE,
    cooldownMs: 30 * MINUTE,
  }),
  /** The 30-second sweep that times out unanswered rides keeps failing: rides could get stuck. */
  timeoutSweepFailures: new ThresholdAlert({
    kind: "timeout_sweep_failures",
    message: "The ride timeout sweep keeps failing",
    threshold: 3,
    windowMs: 5 * MINUTE,
    cooldownMs: 60 * MINUTE,
  }),
  /**
   * Socket connections refused for a missing, forged or malformed token. An
   * expired token or a closed account is normal (the app refreshes and
   * reconnects, notably after every deploy) and isn't counted.
   */
  socketAuthFailures: new ThresholdAlert({
    kind: "socket_auth_failures",
    message: "Many socket connections refused for bad tokens",
    threshold: 30,
    windowMs: 10 * MINUTE,
    cooldownMs: 60 * MINUTE,
  }),
};

/** Prisma's codes for "can't connect", "connection lost" and "no free connection in the pool". */
const CONNECTION_ERROR_CODES = new Set(["P1001", "P1002", "P1008", "P1017", "P2024"]);

/** True for an error that means the database couldn't be reached, not a bad query. */
export function isDatabaseConnectionError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  if (err.name === "PrismaClientInitializationError" || err.name === "PrismaClientRustPanicError")
    return true;
  const code =
    (err as Error & { code?: unknown; errorCode?: unknown }).code ??
    (err as { errorCode?: unknown }).errorCode;
  if (typeof code === "string" && CONNECTION_ERROR_CODES.has(code)) return true;
  return /Can't reach database server|Timed out fetching a new connection|Server has closed the connection/i.test(
    err.message,
  );
}

/** Counts `err` toward the database alert if it is a connection failure. */
export function noteDatabaseError(err: unknown, where: string): void {
  if (isDatabaseConnectionError(err)) alerts.databaseConnection.record({ where });
}
