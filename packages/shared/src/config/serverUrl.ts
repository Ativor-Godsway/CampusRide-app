/**
 * Which backend the rider/driver apps talk to. Pure, so it can be tested
 * here; the apps call it through @rida/mobile-shared's getServerUrl().
 *
 * Switching an app to a server on your Mac is done with
 * apps/<app>/.env.development.local (docs/testing/SOLO_TESTING.md), which
 * Expo reads during `expo start` only. This is the second lock on that door:
 * even if a local address ends up in a file a RELEASE build does read (.env),
 * a release build refuses it and uses the production URL from app.json.
 */

/** True for a server on this machine or a private network (localhost, 10.x, 172.16–31.x, 192.168.x, *.local). */
export function isLocalDevServerUrl(url: string): boolean {
  // Parsed by hand: this runs inside React Native, whose URL implementation
  // does not reliably support `.hostname`.
  const parsed = /^https?:\/\/(?:[^@/?#]*@)?(\[[^\]]+\]|[^:/?#]+)/i.exec(url.trim());
  if (!parsed) return false;
  const host = parsed[1]!.replace(/^\[|\]$/g, "").toLowerCase();
  if (host === "localhost" || host === "::1" || host.endsWith(".local")) return true;
  const m = /^(\d{1,3})\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/.exec(host);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

export interface ServerUrlInputs {
  /** EXPO_PUBLIC_API_URL, inlined from the app's .env files at bundle time. */
  envUrl: string | undefined;
  /** expo.extra.SERVER_URL from app.json — the deployed server. */
  configUrl: string | undefined;
  /** React Native's __DEV__: true under `expo start`, false in a release build. */
  isDev: boolean;
}

export const DEFAULT_DEV_SERVER_URL = "http://localhost:3000";

export function resolveServerUrl({ envUrl, configUrl, isDev }: ServerUrlInputs): string {
  const env = envUrl?.trim() || undefined;
  if (env && (isDev || !isLocalDevServerUrl(env))) return env;
  // A release build never points at a laptop: fall through to the deployed server.
  return configUrl?.trim() || (isDev ? DEFAULT_DEV_SERVER_URL : (env ?? DEFAULT_DEV_SERVER_URL));
}
