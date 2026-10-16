import * as Sentry from "@sentry/node";
import { scrubSentryBreadcrumb, scrubSentryEvent } from "@rida/shared";

/**
 * Error reporting to Sentry (Stage 5). Everything here is a silent no-op
 * until SENTRY_DSN is set, so tests, local development and a deploy without
 * a Sentry project behave exactly as before.
 *
 * - Every event is scrubbed before it leaves the server (@rida/shared's
 *   scrubSentryEvent): no phone numbers, codes, tokens or request bodies.
 * - Performance tracing samples a small share of requests
 *   (SENTRY_TRACES_SAMPLE_RATE, default 2 in 100) to stay inside the free plan.
 * - Releases are the deployed commit (Render's RENDER_GIT_COMMIT), so an
 *   error says which deploy it came from.
 *
 * What gets reported, and the thresholds for noisy kinds: lib/alerts.ts and
 * docs/security/monitoring.md.
 */

export const DEFAULT_TRACES_SAMPLE_RATE = 0.02;

let enabled = false;

/** The sampling rate to use: a number between 0 and 1, or the default. */
export function tracesSampleRate(raw: string | undefined): number {
  const rate = raw === undefined || raw.trim() === "" ? NaN : Number(raw);
  return Number.isFinite(rate) && rate >= 0 && rate <= 1 ? rate : DEFAULT_TRACES_SAMPLE_RATE;
}

/** The Sentry.init options for this environment, or null when there is no DSN. */
export function sentryOptions(env: NodeJS.ProcessEnv = process.env): Sentry.NodeOptions | null {
  const dsn = env.SENTRY_DSN?.trim();
  if (!dsn) return null;
  return {
    dsn,
    environment: env.SENTRY_ENVIRONMENT?.trim() || env.NODE_ENV || "development",
    release: env.SENTRY_RELEASE?.trim() || env.RENDER_GIT_COMMIT?.trim() || undefined,
    tracesSampleRate: tracesSampleRate(env.SENTRY_TRACES_SAMPLE_RATE),
    sendDefaultPii: false,
    // Errors are reported by our own error handler (http/errors.ts), which
    // knows which ones are real 500s and adds the request id.
    integrations: [Sentry.fastifyIntegration({ shouldHandleError: () => false })],
    beforeSend: (event) => scrubSentryEvent(event),
    beforeSendTransaction: (event) => scrubSentryEvent(event),
    beforeBreadcrumb: (breadcrumb) => scrubSentryBreadcrumb(breadcrumb),
  };
}

/**
 * Starts Sentry when SENTRY_DSN is set. Called first thing at startup
 * (instrument.ts), before Fastify and Prisma load, so performance tracing
 * can hook into them. Returns whether reporting is on.
 */
export function initMonitoring(
  env: NodeJS.ProcessEnv = process.env,
  /** Tests only: e.g. a transport that records instead of sending. */
  overrides: Partial<Sentry.NodeOptions> = {},
): boolean {
  const options = sentryOptions(env);
  if (!options) return false;
  Sentry.init({ ...options, ...overrides });
  enabled = true;
  return true;
}

export function monitoringEnabled(): boolean {
  return enabled;
}

export type ReportLevel = "fatal" | "error" | "warning";

export interface ReportContext {
  level?: ReportLevel;
  /** Searchable labels: alert kind, route, request id. Short strings only. */
  tags?: Record<string, string | number | boolean | undefined>;
  /** Extra detail shown on the event (scrubbed like everything else). */
  extra?: Record<string, unknown>;
}

function scope(context: ReportContext) {
  const tags = Object.fromEntries(
    Object.entries(context.tags ?? {}).filter(
      (entry): entry is [string, string | number | boolean] => entry[1] !== undefined,
    ),
  );
  return { level: context.level ?? "error", tags, extra: context.extra } as const;
}

/** Reports an exception (no-op without a DSN). The same error object is only ever reported once. */
export function reportError(err: unknown, context: ReportContext = {}): void {
  if (!enabled) return;
  Sentry.captureException(err, scope(context));
}

/** Reports a situation that isn't an exception: "SMS send failed", "balance low" (no-op without a DSN). */
export function reportMessage(message: string, context: ReportContext = {}): void {
  if (!enabled) return;
  Sentry.captureMessage(message, scope(context));
}

/** Sends anything still queued; call before the process exits. */
export async function flushMonitoring(timeoutMs = 2000): Promise<void> {
  if (!enabled) return;
  await Sentry.flush(timeoutMs);
}
