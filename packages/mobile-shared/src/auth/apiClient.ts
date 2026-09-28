import axios from "axios";
import { getServerUrl } from "../config/serverUrl";
import { getAccessToken, setAccessToken } from "./tokenStore";
import { clearStoredRefreshToken, getStoredRefreshToken, setStoredRefreshToken } from "./storage";

const SERVER_URL = getServerUrl();

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
  return config;
});

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
 * True when the server ANSWERED and refused the session — 400/401 from
 * /auth/refresh, or 404 from /me for an account that no longer exists — as
 * opposed to the request never getting an answer. A phone on a bad
 * connection, or a Render server still waking up, must not be logged out;
 * nor must a 429 rate-limit.
 */
export function isSessionRejection(error: unknown): boolean {
  if (error instanceof Error && error.message === NO_STORED_REFRESH_TOKEN) return true;
  const status = (error as { response?: { status?: number } } | null)?.response?.status;
  return status === 400 || status === 401 || status === 404;
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

async function refreshAccessToken(): Promise<string> {
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

api.interceptors.response.use(
  (response) => response,
  async (error) => {
    const originalRequest = error.config as (typeof error.config) & { _retry?: boolean };

    if (error.response?.status !== 401 || originalRequest._retry) {
      return Promise.reject(error);
    }
    originalRequest._retry = true;

    try {
      const accessToken = await refreshAccessToken();

      originalRequest.headers = originalRequest.headers ?? {};
      originalRequest.headers.Authorization = `Bearer ${accessToken}`;
      return api(originalRequest);
    } catch (refreshError) {
      if (isSessionRejection(refreshError)) {
        setAccessToken(null);
        await clearStoredRefreshToken();
        sessionRejectedHandler?.();
      }
      return Promise.reject(refreshError);
    }
  },
);
