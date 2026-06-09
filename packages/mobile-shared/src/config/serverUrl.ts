import Constants from "expo-constants";

/**
 * Resolves the backend base URL, checked in order:
 * 1. `EXPO_PUBLIC_API_URL` from the consuming app's `.env` (inlined by Expo at build time).
 * 2. `expo.extra.SERVER_URL` in the consuming app's `app.json`.
 * 3. The local dev server.
 */
export function getServerUrl(): string {
  return (
    process.env.EXPO_PUBLIC_API_URL ??
    (Constants.expoConfig?.extra?.SERVER_URL as string | undefined) ??
    "http://localhost:3000"
  );
}
