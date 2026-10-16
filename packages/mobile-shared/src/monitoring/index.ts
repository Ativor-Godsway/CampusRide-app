import type { ComponentType } from "react";
import * as Sentry from "@sentry/react-native";
import { channel, isEmbeddedLaunch, runtimeVersion, updateId } from "expo-updates";
import { scrubSentryBreadcrumb, scrubSentryEvent } from "@rida/shared";

/**
 * Error and crash reporting to Sentry for the rider and driver apps
 * (Stage 5). Off — nothing is sent — unless EXPO_PUBLIC_SENTRY_DSN was set
 * when the app or update was built (an EAS environment variable, one per
 * app: DEPLOY.md, "Monitoring").
 *
 * - JavaScript errors and native crashes (the app killed, frozen) are
 *   reported, scrubbed by the same rules as the server's (@rida/shared): no
 *   phone numbers, codes or tokens. No screenshots, no screen recording.
 * - Each report says which build (Sentry reads the app version and build
 *   number) and which over-the-air update it came from: the `expo.update_id`
 *   tag, with the channel and runtime version alongside.
 * - A small share of app starts is traced for performance
 *   (EXPO_PUBLIC_SENTRY_TRACES_SAMPLE_RATE, default 2 in 100).
 */

let enabled = false;

/** Starts reporting if a DSN was built in. Call once, before the root component renders. */
export function initMonitoring(app: "rider" | "driver"): boolean {
  const dsn = process.env.EXPO_PUBLIC_SENTRY_DSN?.trim();
  if (!dsn || enabled) return enabled;
  const raw = process.env.EXPO_PUBLIC_SENTRY_TRACES_SAMPLE_RATE;
  const rate = raw ? Number(raw) : NaN;
  Sentry.init({
    dsn,
    environment: channel || (__DEV__ ? "development" : "production"),
    sendDefaultPii: false,
    tracesSampleRate: rate >= 0 && rate <= 1 ? rate : 0.02,
    // A screenshot or the screen's layout could show a phone number or a pin.
    attachScreenshot: false,
    attachViewHierarchy: false,
    beforeSend: (event) => scrubSentryEvent(event),
    beforeSendTransaction: (event) => scrubSentryEvent(event),
    beforeBreadcrumb: (breadcrumb) => scrubSentryBreadcrumb(breadcrumb),
  });
  Sentry.setTags({
    app,
    "expo.update_id": updateId ?? "embedded",
    "expo.channel": channel ?? "none",
    "expo.runtime_version": runtimeVersion ?? "unknown",
    "expo.embedded_launch": String(isEmbeddedLaunch),
  });
  enabled = true;
  return true;
}

/** The app's root component, wrapped so Sentry sees touches and render errors; unchanged when reporting is off. */
export function withMonitoring<P extends Record<string, unknown>>(
  Root: ComponentType<P>,
): ComponentType<P> {
  return enabled ? Sentry.wrap(Root) : Root;
}
