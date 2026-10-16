import * as Sentry from "@sentry/react";
import { scrubSentryBreadcrumb, scrubSentryEvent } from "@rida/shared";

/**
 * Error reporting to Sentry for the admin site (Stage 5). Off — nothing is
 * sent — unless VITE_SENTRY_DSN was set when the site was built (Render →
 * campusride-admin → Environment, then a redeploy).
 *
 * Every event is scrubbed by the same rules as the server's (@rida/shared):
 * no phone numbers, codes or tokens. No session replay. A small share of
 * page loads is traced for performance (VITE_SENTRY_TRACES_SAMPLE_RATE,
 * default 2 in 100). The release is the commit Render built
 * (RENDER_GIT_COMMIT, see vite.config.ts).
 */
export function initMonitoring(): boolean {
  const dsn = import.meta.env.VITE_SENTRY_DSN?.trim();
  if (!dsn) return false;
  const raw = import.meta.env.VITE_SENTRY_TRACES_SAMPLE_RATE;
  const rate = raw ? Number(raw) : NaN;
  Sentry.init({
    dsn,
    environment: import.meta.env.VITE_SENTRY_ENVIRONMENT || import.meta.env.MODE,
    release: __SENTRY_RELEASE__ || undefined,
    sendDefaultPii: false,
    integrations: [Sentry.browserTracingIntegration()],
    tracesSampleRate: rate >= 0 && rate <= 1 ? rate : 0.02,
    // Trace headers stay on the site's own origin: the API (another origin)
    // doesn't list them as allowed CORS headers.
    tracePropagationTargets: [],
    beforeSend: (event) => scrubSentryEvent(event),
    beforeSendTransaction: (event) => scrubSentryEvent(event),
    beforeBreadcrumb: (breadcrumb) => scrubSentryBreadcrumb(breadcrumb),
  });
  return true;
}
