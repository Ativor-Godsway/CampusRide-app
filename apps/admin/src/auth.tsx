import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";
import type { AuthUser } from "./api";

/**
 * Session state for the admin app.
 *
 * The access token is held in memory and mirrored to sessionStorage, NOT
 * localStorage: this is an operator tool with real authority over who can
 * drive, so a session should not outlive the browser tab. The refresh token
 * is deliberately NOT persisted at all — an admin logging in again once a day
 * is a fair price for not leaving a long-lived credential in web storage.
 */

interface Session {
  user: AuthUser;
  accessToken: string;
}

interface AuthContextValue {
  session: Session | null;
  signIn: (session: Session) => void;
  signOut: () => void;
}

const STORAGE_KEY = "campusride.admin.session";

const AuthContext = createContext<AuthContextValue | null>(null);

function readStoredSession(): Session | null {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Session;
    // Defensive: only an ADMIN session is usable here regardless of what is
    // sitting in storage.
    if (parsed?.user?.role !== "ADMIN" || !parsed.accessToken) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(readStoredSession);

  const signIn = useCallback((next: Session) => {
    setSession(next);
    try {
      sessionStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    } catch {
      // Private-mode / blocked storage: the in-memory session still works for
      // this tab, which is all the app needs.
    }
  }, []);

  const signOut = useCallback(() => {
    setSession(null);
    try {
      sessionStorage.removeItem(STORAGE_KEY);
    } catch {
      // Nothing to clean up if storage was never writable.
    }
  }, []);

  const value = useMemo(() => ({ session, signIn, signOut }), [session, signIn, signOut]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used inside <AuthProvider>");
  return ctx;
}

/**
 * Convenience for screens that only render behind the login gate: returns the
 * access token, throwing if somehow called without a session.
 */
export function useToken(): string {
  const { session } = useAuth();
  if (!session) throw new Error("useToken called outside an authenticated screen");
  return session.accessToken;
}
