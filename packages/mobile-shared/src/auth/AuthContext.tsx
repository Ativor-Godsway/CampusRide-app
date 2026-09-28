import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import type { UserRole } from "@rida/shared";
import {
  deleteAccount as apiDeleteAccount,
  getMe,
  login as apiLogin,
  logout as apiLogout,
  refreshTokens,
  signup as apiSignup,
  type AuthUser,
} from "./api";
import {
  clearStoredRefreshToken,
  getStoredRefreshToken,
  setStoredRefreshToken,
} from "./storage";
import { getAccessToken, setAccessToken } from "./tokenStore";
import { isSessionRejection, setSessionRejectedHandler } from "./apiClient";

interface AuthContextValue {
  user: AuthUser | null;
  /** True while the initial refresh-token-on-disk check is in flight. */
  isLoading: boolean;
  isAuthenticated: boolean;
  completeSignup: (input: {
    phone: string;
    name: string;
    role: Exclude<UserRole, "ADMIN">;
    verifiedToken: string;
  }) => Promise<void>;
  completeLogin: (input: { phone: string; verifiedToken: string }) => Promise<void>;
  /**
   * Ends the session on this device: clears the stored credentials and the
   * signed-in user immediately, then revokes the refresh token on the server
   * in the background (so a slow or sleeping server never holds up leaving).
   */
  signOut: () => Promise<void>;
  /**
   * Permanently closes the account, then clears local credentials exactly as
   * signOut does. Rejects (without signing out) if the server refuses — e.g.
   * 409 while a ride is still in flight — so the caller can surface why.
   */
  deleteAccount: () => Promise<void>;
  refreshMe: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  const clearLocalSession = useCallback(async () => {
    setAccessToken(null);
    await clearStoredRefreshToken();
    setUser(null);
  }, []);

  // The API client reports a session the server has refused mid-use (revoked
  // token, deleted account); drop the user so every screen's auth gate sends
  // them back to the phone-number screen.
  useEffect(() => {
    setSessionRejectedHandler(() => setUser(null));
    return () => setSessionRejectedHandler(null);
  }, []);

  const refreshMe = useCallback(async () => {
    try {
      const { user: me } = await getMe();
      setUser(me);
    } catch (error) {
      // 404: the account behind this still-valid token no longer exists.
      if (isSessionRejection(error)) await clearLocalSession();
      throw error;
    }
  }, [clearLocalSession]);

  useEffect(() => {
    (async () => {
      const storedRefreshToken = await getStoredRefreshToken();
      if (!storedRefreshToken) {
        setIsLoading(false);
        return;
      }

      try {
        const tokens = await refreshTokens(storedRefreshToken);
        setAccessToken(tokens.accessToken);
        await setStoredRefreshToken(tokens.refreshToken);
        await refreshMe();
      } catch (error) {
        // Only forget the stored session when the server refused it. On a
        // network failure it is kept, so the next launch can try again.
        setAccessToken(null);
        if (isSessionRejection(error)) await clearStoredRefreshToken();
      } finally {
        setIsLoading(false);
      }
    })();
  }, [refreshMe]);

  const completeSignup = useCallback<AuthContextValue["completeSignup"]>(async (input) => {
    const result = await apiSignup(input);
    setAccessToken(result.accessToken);
    await setStoredRefreshToken(result.refreshToken);
    setUser(result.user);
  }, []);

  const completeLogin = useCallback<AuthContextValue["completeLogin"]>(async (input) => {
    const result = await apiLogin(input);
    setAccessToken(result.accessToken);
    await setStoredRefreshToken(result.refreshToken);
    setUser(result.user);
  }, []);

  const signOut = useCallback(async () => {
    const storedRefreshToken = await getStoredRefreshToken();
    await clearLocalSession();
    if (storedRefreshToken) {
      // Best effort, not awaited: apiLogout already swallows its own errors.
      void apiLogout(storedRefreshToken);
    }
  }, [clearLocalSession]);

  const deleteAccount = useCallback(async () => {
    // Server first: if it refuses (409 active ride, network error), we must
    // NOT clear local state — the account still exists and the user is still
    // signed in.
    await apiDeleteAccount();
    await clearLocalSession();
  }, [clearLocalSession]);

  const value: AuthContextValue = {
    user,
    isLoading,
    isAuthenticated: user !== null && getAccessToken() !== null,
    completeSignup,
    completeLogin,
    signOut,
    deleteAccount,
    refreshMe,
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within an AuthProvider");
  return ctx;
}
