import Constants from "expo-constants";

/**
 * Resolves the backend base URL from `expo.extra.SERVER_URL` in the
 * consuming app's `app.json` (each app — rider/driver — points at the same
 * running server but configures this independently). Falls back to the
 * local dev server.
 */
export function getServerUrl(): string {
  return (Constants.expoConfig?.extra?.SERVER_URL as string | undefined) ?? "http://localhost:3000";
}
