import Constants from "expo-constants";
import { resolveServerUrl } from "@rida/shared";

/**
 * Resolves the backend base URL (rules and tests: @rida/shared
 * config/serverUrl.ts):
 * 1. `EXPO_PUBLIC_API_URL` from the consuming app's `.env` files (inlined by
 *    Expo at bundle time). To use a server on your Mac, put it in
 *    `apps/<app>/.env.development.local` — see docs/testing/SOLO_TESTING.md.
 *    A RELEASE build ignores a local/Wi-Fi address here and uses (2).
 * 2. `expo.extra.SERVER_URL` in the consuming app's `app.json` (production).
 * 3. The local dev server.
 */
export function getServerUrl(): string {
  return resolveServerUrl({
    envUrl: process.env.EXPO_PUBLIC_API_URL,
    configUrl: Constants.expoConfig?.extra?.SERVER_URL as string | undefined,
    isDev: typeof __DEV__ !== "undefined" && __DEV__,
  });
}
