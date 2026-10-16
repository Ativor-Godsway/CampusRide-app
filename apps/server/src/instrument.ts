/**
 * Loaded before anything else (the first import in index.ts): starts error
 * reporting when SENTRY_DSN is set, early enough for performance tracing to
 * hook into Fastify and the HTTP client as they load. Reads the same .env
 * files config.ts does, so a local SENTRY_DSN works too.
 */
import "./config";
import { initMonitoring } from "./lib/monitoring";

initMonitoring();
