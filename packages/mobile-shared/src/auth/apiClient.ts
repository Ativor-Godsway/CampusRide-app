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
      throw new Error("No stored refresh token");
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
      setAccessToken(null);
      await clearStoredRefreshToken();
      return Promise.reject(refreshError);
    }
  },
);
