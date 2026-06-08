import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import type { UserRole } from "@rida/shared";
import {
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
  signOut: () => Promise<void>;
  refreshMe: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  const refreshMe = useCallback(async () => {
    const { user: me } = await getMe();
    setUser(me);
  }, []);

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
      } catch {
        setAccessToken(null);
        await clearStoredRefreshToken();
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
    if (storedRefreshToken) {
      await apiLogout(storedRefreshToken);
    }
    setAccessToken(null);
    await clearStoredRefreshToken();
    setUser(null);
  }, []);

  const value: AuthContextValue = {
    user,
    isLoading,
    isAuthenticated: user !== null && getAccessToken() !== null,
    completeSignup,
    completeLogin,
    signOut,
    refreshMe,
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within an AuthProvider");
  return ctx;
}
