/**
 * In-memory access token store. The access token is intentionally never
 * persisted to disk — only the refresh token (in expo-secure-store) survives
 * an app restart. On cold start, AuthProvider exchanges the stored refresh
 * token for a fresh access token via /auth/refresh.
 */
let accessToken: string | null = null;

export function getAccessToken(): string | null {
  return accessToken;
}

export function setAccessToken(token: string | null): void {
  accessToken = token;
}
