/**
 * Mapbox public access token for the Static Images API (display only).
 * Set via `EXPO_PUBLIC_MAPBOX_TOKEN` in the consuming app's `.env` — Expo
 * inlines `EXPO_PUBLIC_*` vars into the JS bundle at build time, no
 * app.json/app.config.js plumbing needed. Returns `undefined` if unset, so
 * callers can fall back to a list-only UI.
 */
export function getMapboxToken(): string | undefined {
  return process.env.EXPO_PUBLIC_MAPBOX_TOKEN || undefined;
}
