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

api.interceptors.response.use(
  (response) => response,
  async (error) => {
    const originalRequest = error.config as (typeof error.config) & { _retry?: boolean };

    if (error.response?.status !== 401 || originalRequest._retry) {
      return Promise.reject(error);
    }
    originalRequest._retry = true;

    const refreshToken = await getStoredRefreshToken();
    if (!refreshToken) {
      return Promise.reject(error);
    }

    try {
      const { data } = await rawApi.post<{ accessToken: string; refreshToken: string }>(
        "/auth/refresh",
        { refreshToken },
      );
      setAccessToken(data.accessToken);
      await setStoredRefreshToken(data.refreshToken);

      originalRequest.headers = originalRequest.headers ?? {};
      originalRequest.headers.Authorization = `Bearer ${data.accessToken}`;
      return api(originalRequest);
    } catch (refreshError) {
      setAccessToken(null);
      await clearStoredRefreshToken();
      return Promise.reject(refreshError);
    }
  },
);
