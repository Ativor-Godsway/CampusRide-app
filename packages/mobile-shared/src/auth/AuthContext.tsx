import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { AppState } from "react-native";
import type { UserRole } from "@rida/shared";
import {
  confirmTerms as apiConfirmTerms,
  deleteAccount as apiDeleteAccount,
  getMe,
  login as apiLogin,
  logout as apiLogout,
  signup as apiSignup,
  type AuthUser,
  type LoginResponse,
} from "./api";
import {
  clearStoredRefreshToken,
  getStoredRefreshToken,
  setStoredRefreshToken,
} from "./storage";
import { getAccessToken, setAccessToken } from "./tokenStore";
import { refreshSessionOrSignOut, setSessionRejectedHandler } from "./apiClient";
import { getCurrentPushToken, setCurrentPushToken } from "../push/currentToken";
import { resetRideSocket } from "../realtime/socket";

interface AuthContextValue {
  user: AuthUser | null;
  /**
   * True until the app knows whether this phone is signed in: the stored
   * session is being restored. It stays true — retrying — while the server
   * can't be reached, rather than showing the sign-in screen to someone who
   * is signed in.
   */
  isLoading: boolean;
  isAuthenticated: boolean;
  /**
   * Set while restoring the session keeps failing to reach the server (no
   * connection, server restarting). The app says so and keeps retrying.
   */
  sessionProblem: "unreachable" | null;
  /** Tries restoring the session again now (a "Try again" button). */
  retrySession: () => void;
  completeSignup: (input: {
    phone: string;
    name: string;
    role: Exclude<UserRole, "ADMIN">;
    verifiedToken: string;
  }) => Promise<void>;
  completeLogin: (input: { phone: string; verifiedToken: string }) => Promise<void>;
  /** Signs in with a session the server already gave (verifyCode's "signedIn"). */
  completeSignIn: (session: LoginResponse) => Promise<void>;
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
  deleteAccount: (code: string) => Promise<void>;
  /** "I'm 18 or older and I agree to the Terms and Privacy Policy", for an account from before sign-up asked. */
  confirmTerms: () => Promise<void>;
  refreshMe: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

/** Restoring the session retries after 2 s, 4 s, 8 s… up to every 30 s. */
const RESTORE_RETRY_BASE_MS = 2_000;
const RESTORE_RETRY_MAX_MS = 30_000;

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [sessionProblem, setSessionProblem] = useState<"unreachable" | null>(null);

  const clearLocalSession = useCallback(async () => {
    // The live connection belongs to the person leaving.
    resetRideSocket();
    setAccessToken(null);
    await clearStoredRefreshToken();
    setUser(null);
  }, []);

  // The API client reports a session the server has refused mid-use (revoked
  // token, deleted account); drop the user so every screen's auth gate sends
  // them back to the phone-number screen.
  useEffect(() => {
    setSessionRejectedHandler(() => {
      resetRideSocket();
      setUser(null);
    });
    return () => setSessionRejectedHandler(null);
  }, []);

  // A 401 from /me means the token was refused, and the API client has
  // already refreshed — or, if the session is truly over, signed out. Any
  // other failure (no connection) changes nothing.
  const refreshMe = useCallback(async () => {
    const { user: me } = await getMe();
    setUser(me);
  }, []);

  // ── Restoring the session at launch ───────────────────────────────────────
  // Signed in, signed out, or — while the server can't be reached — not
  // known yet. Only the server refusing the stored session (401) signs the
  // user out; anything else is retried, and they stay on a "connecting"
  // screen, never the sign-in screen.
  const restoring = useRef(false);
  const restored = useRef(false);
  const retryTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const failures = useRef(0);

  const restoreSession = useCallback(async () => {
    if (restoring.current || restored.current) return;
    restoring.current = true;
    if (retryTimer.current) clearTimeout(retryTimer.current);
    retryTimer.current = null;
    let outcome: "done" | "retry" = "done";
    try {
      // Rejects only when the keychain can't be read (iPhone locked): retry.
      const storedRefreshToken = await getStoredRefreshToken();
      if (storedRefreshToken) {
        // Signs out by itself if the server refuses the session.
        await refreshSessionOrSignOut();
        await refreshMe();
      }
    } catch {
      // Refused (401): refreshSessionOrSignOut already cleared everything,
      // and there is no stored token left. Otherwise, try again.
      outcome = (await getStoredRefreshToken().catch(() => "unknown")) ? "retry" : "done";
    } finally {
      restoring.current = false;
    }
    if (outcome === "done") {
      restored.current = true;
      failures.current = 0;
      setSessionProblem(null);
      setIsLoading(false);
      return;
    }
    failures.current += 1;
    setSessionProblem("unreachable");
    const delay = Math.min(RESTORE_RETRY_MAX_MS, RESTORE_RETRY_BASE_MS * 2 ** (failures.current - 1));
    retryTimer.current = setTimeout(() => void restoreSession(), delay);
  }, [refreshMe]);

  useEffect(() => {
    void restoreSession();
    // Coming back to the app is a good moment to try again straight away.
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") void restoreSession();
    });
    return () => {
      subscription.remove();
      if (retryTimer.current) clearTimeout(retryTimer.current);
    };
  }, [restoreSession]);

  const retrySession = useCallback(() => void restoreSession(), [restoreSession]);

  const completeSignup = useCallback<AuthContextValue["completeSignup"]>(async (input) => {
    const result = await apiSignup(input);
    // A new person on this phone: never reuse a connection made for someone else.
    resetRideSocket();
    setAccessToken(result.accessToken);
    await setStoredRefreshToken(result.refreshToken);
    setUser(result.user);
  }, []);

  const completeSignIn = useCallback<AuthContextValue["completeSignIn"]>(async (session) => {
    // A new person on this phone: never reuse a connection made for someone else.
    resetRideSocket();
    setAccessToken(session.accessToken);
    await setStoredRefreshToken(session.refreshToken);
    setUser(session.user);
  }, []);

  const completeLogin = useCallback<AuthContextValue["completeLogin"]>(
    async (input) => completeSignIn(await apiLogin(input)),
    [completeSignIn],
  );

  const signOut = useCallback(async () => {
    const storedRefreshToken = await getStoredRefreshToken();
    const pushToken = getCurrentPushToken();
    setCurrentPushToken(null);
    await clearLocalSession();
    if (storedRefreshToken) {
      // Best effort, not awaited: apiLogout already swallows its own errors.
      // The push token goes with it, so this phone stops getting the
      // signed-out user's notifications.
      void apiLogout(storedRefreshToken, pushToken);
    }
  }, [clearLocalSession]);

  const deleteAccount = useCallback(async (code: string) => {
    // Server first: if it refuses (409 active ride, network error), we must
    // NOT clear local state — the account still exists and the user is still
    // signed in.
    await apiDeleteAccount(code);
    // The server deleted every push token of the account.
    setCurrentPushToken(null);
    await clearLocalSession();
  }, [clearLocalSession]);

  const confirmTerms = useCallback(async () => {
    setUser(await apiConfirmTerms());
  }, []);

  const value: AuthContextValue = {
    user,
    isLoading,
    isAuthenticated: user !== null && getAccessToken() !== null,
    sessionProblem,
    retrySession,
    completeSignup,
    completeLogin,
    completeSignIn,
    signOut,
    deleteAccount,
    confirmTerms,
    refreshMe,
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within an AuthProvider");
  return ctx;
}
