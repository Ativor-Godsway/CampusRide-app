import axios from "axios";
import { AUTO_ADD_FEATURE, CLIENT_FEATURES_HEADER, WAIT_FEE_FEATURE } from "@rida/shared";
import { getServerUrl } from "../config/serverUrl";
import { getAccessToken, setAccessToken } from "./tokenStore";
import { clearStoredRefreshToken, getStoredRefreshToken, setStoredRefreshToken } from "./storage";

const SERVER_URL = getServerUrl();

// Development builds say which server they talk to, so it is obvious in the
// Metro terminal whether the app is on your Mac or on production.
if (typeof __DEV__ !== "undefined" && __DEV__) {
  // eslint-disable-next-line no-console -- deliberate, development builds only
  console.log(`[CampusRide] API server: ${SERVER_URL}`);
}

/** Plain axios instance with no interceptors — used for /auth/refresh itself to avoid loops. */
export const rawApi = axios.create({
  baseURL: SERVER_URL,
  timeout: 10000,
  headers: { "Content-Type": "application/json" },
});

/** Main API client: attaches the access token and retries once on 401 by refreshing it. */
export const api = axios.create({
  baseURL: SERVER_URL,
  timeout: 10000,
  headers: { "Content-Type": "application/json" },
});

api.interceptors.request.use((config) => {
  const token = getAccessToken();
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  // What this JavaScript can show (an OTA update adds features without a new
  // store version): "wait-fee" — the pickup wait timer and fee (@rida/shared
  // rides/waitFee.ts). The server only charges a fee a rider was warned about.
  // wait-fee: the wait timer; auto-add: the driver app shows an auto-added rider with Undo (the server marks drivers only).
  config.headers[CLIENT_FEATURES_HEADER] = `${WAIT_FEE_FEATURE},${AUTO_ADD_FEATURE}`;
  return config;
});

/**
 * How far the server's clock is ahead of this phone's (ms), from the Date
 * header of the latest answer (1 s resolution). Countdowns the server times
 * (the pickup wait) use serverNow(), so a phone set a few minutes wrong
 * still shows 2:30.
 */
let serverClockOffsetMs = 0;

/** Now, by the server's clock as far as this phone knows it. */
export function serverNow(): number {
  return Date.now() + serverClockOffsetMs;
}

/** Tests only. */
export function setServerClockOffsetForTests(ms: number): void {
  serverClockOffsetMs = ms;
}

function noteServerDate(headers: unknown): void {
  const raw = (headers as Record<string, unknown> | undefined)?.date;
  const at = typeof raw === "string" ? Date.parse(raw) : NaN;
  if (!Number.isFinite(at)) return;
  // The header is whole seconds: half a second in the middle of that second.
  serverClockOffsetMs = at + 500 - Date.now();
}

/**
 * Called when the server has definitively rejected this session: the refresh
 * token is unknown, revoked or belongs to a deleted account. AuthProvider
 * registers a handler that clears the signed-in user, so the app returns to
 * the phone-number screen instead of sitting on a screen whose every request
 * now fails.
 */
let sessionRejectedHandler: (() => void) | null = null;

const NO_STORED_REFRESH_TOKEN = "No stored refresh token";

export function setSessionRejectedHandler(handler: (() => void) | null): void {
  sessionRejectedHandler = handler;
}

/**
 * True only when the session is really over: the server ANSWERED a refresh
 * with 401 (the token is unknown, revoked, expired, or its account deleted),
 * or there is no refresh token at all. Everything else — no connection, a
 * timeout, a server restarting or waking up (5xx), a rate limit (429), a 404
 * from a wrong or half-moved address — leaves the user signed in, to try
 * again. Signing someone out is only ever this, or their own "Log out".
 */
export function isSessionRejection(error: unknown): boolean {
  if (error instanceof Error && error.message === NO_STORED_REFRESH_TOKEN) return true;
  const status = (error as { response?: { status?: number } } | null)?.response?.status;
  return status === 401;
}

/**
 * In-flight refresh, shared by every request that 401s at the same time.
 *
 * The server rotates refresh tokens on every use and treats a SECOND use of
 * an already-consumed token as theft, revoking that login's whole token
 * family. Firing one /auth/refresh per concurrent 401 would present the same
 * token several times and trip exactly that detector, logging the user out.
 * Single-flighting keeps one refresh per token, which is also what makes the
 * server-side detection meaningful: any duplicate use is then genuinely not us.
 */
let inFlightRefresh: Promise<string> | null = null;

/**
 * Exchanges the refresh token for a new access token. Every refresh in the
 * app — at start-up, after a 401, for the live connection — goes through
 * here, so two of them can never present the same token at once.
 */
export async function refreshAccessToken(): Promise<string> {
  if (inFlightRefresh) return inFlightRefresh;

  inFlightRefresh = (async () => {
    const refreshToken = await getStoredRefreshToken();
    if (!refreshToken) {
      throw new Error(NO_STORED_REFRESH_TOKEN);
    }

    const { data } = await rawApi.post<{ accessToken: string; refreshToken: string }>(
      "/auth/refresh",
      { refreshToken },
    );
    setAccessToken(data.accessToken);
    await setStoredRefreshToken(data.refreshToken);
    return data.accessToken;
  })();

  try {
    return await inFlightRefresh;
  } finally {
    // Cleared regardless of outcome so the NEXT 401 starts a fresh attempt
    // rather than replaying a settled (possibly rejected) promise forever.
    inFlightRefresh = null;
  }
}

/**
 * A fresh access token, or — when the server refuses the session — the
 * session ended here, exactly as a refused request ends it. Rejects on any
 * failure; a network failure leaves the session alone so it can be retried.
 * Used by the 401 retry below and by the ride socket after the server
 * refuses its handshake.
 */
export async function refreshSessionOrSignOut(): Promise<string> {
  try {
    return await refreshAccessToken();
  } catch (refreshError) {
    if (isSessionRejection(refreshError)) {
      setAccessToken(null);
      await clearStoredRefreshToken();
      sessionRejectedHandler?.();
    }
    throw refreshError;
  }
}

api.interceptors.response.use(
  (response) => {
    noteServerDate(response.headers);
    return response;
  },
  async (error) => {
    const originalRequest = error.config as (typeof error.config) & { _retry?: boolean };

    if (error.response?.status !== 401 || originalRequest._retry) {
      return Promise.reject(error);
    }
    originalRequest._retry = true;

    const accessToken = await refreshSessionOrSignOut();
    originalRequest.headers = originalRequest.headers ?? {};
    originalRequest.headers.Authorization = `Bearer ${accessToken}`;
    return api(originalRequest);
  },
);
