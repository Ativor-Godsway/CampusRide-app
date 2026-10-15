import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { logout, setSessionHooks, type AuthUser } from "./api";

/**
 * Session state for the admin app.
 *
 * Admin sessions are short and the server decides their length: a 10-minute
 * access token, renewed with a single-use refresh token while the site is in
 * use; 30 minutes without activity, or 8 hours from signing in, ends them.
 * Both tokens live in memory mirrored to sessionStorage — never
 * localStorage — so a session dies with the browser tab, and the page also
 * signs itself out after INACTIVITY_MS without a click or key press, so a
 * screen of rider phone numbers isn't left open on an unattended computer.
 */

interface Session {
  user: AuthUser;
  accessToken: string;
  refreshToken?: string;
  /** When the server ends this session whatever happens (ISO). */
  sessionExpiresAt?: string;
}

interface AuthContextValue {
  session: Session | null;
  /** Why the last session ended, for the login screen; null after a deliberate sign-out. */
  endedReason: string | null;
  signIn: (session: Session) => void;
  signOut: (reason?: string) => void;
}

const STORAGE_KEY = "campusride.admin.session";
const INACTIVITY_MS = 30 * 60_000;

const AuthContext = createContext<AuthContextValue | null>(null);

function readStoredSession(): Session | null {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Session;
    // Defensive: only an ADMIN session is usable here regardless of what is
    // sitting in storage, and never one past its hard end.
    if (parsed?.user?.role !== "ADMIN" || !parsed.accessToken) return null;
    if (parsed.sessionExpiresAt && Date.parse(parsed.sessionExpiresAt) <= Date.now()) return null;
    return parsed;
  } catch {
    return null;
  }
}

function store(session: Session | null): void {
  try {
    if (session) sessionStorage.setItem(STORAGE_KEY, JSON.stringify(session));
    else sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    // Private-mode / blocked storage: the in-memory session still works for
    // this tab, which is all the app needs.
  }
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(readStoredSession);
  const [endedReason, setEndedReason] = useState<string | null>(null);
  const latest = useRef(session);
  latest.current = session;

  const update = useCallback((next: Session | null) => {
    latest.current = next;
    setSession(next);
    store(next);
  }, []);

  const signIn = useCallback(
    (next: Session) => {
      setEndedReason(null);
      update(next);
    },
    [update],
  );

  const signOut = useCallback(
    (reason?: string) => {
      const wasSignedIn = latest.current !== null;
      const refreshToken = latest.current?.refreshToken;
      update(null);
      // A screen signing out after the session already ended keeps the reason shown.
      setEndedReason((previous) => reason ?? (wasSignedIn ? null : previous));
      if (refreshToken) void logout(refreshToken);
    },
    [update],
  );

  // Let the API client renew the access token, and end the session when the
  // server won't.
  useEffect(() => {
    setSessionHooks({
      refreshToken: () => latest.current?.refreshToken ?? null,
      onRenewed: (tokens) => {
        if (latest.current) update({ ...latest.current, ...tokens });
      },
      onEnded: (message) => {
        update(null);
        setEndedReason(message);
      },
    });
    return () => setSessionHooks(null);
  }, [update]);

  // The hard end, even with the tab left open.
  const expiresAt = session?.sessionExpiresAt;
  useEffect(() => {
    if (!expiresAt) return;
    const ms = Date.parse(expiresAt) - Date.now();
    const timer = window.setTimeout(
      () => signOut("Your admin session has ended (sessions last at most 8 hours). Please sign in again."),
      Math.max(0, ms),
    );
    return () => window.clearTimeout(timer);
  }, [expiresAt, signOut]);

  // Sign out after a while without any activity on the page.
  const signedIn = session !== null;
  useEffect(() => {
    if (!signedIn) return;
    let timer = window.setTimeout(idle, INACTIVITY_MS);
    function idle() {
      signOut("You were signed out after 30 minutes without activity. Please sign in again.");
    }
    function activity() {
      window.clearTimeout(timer);
      timer = window.setTimeout(idle, INACTIVITY_MS);
    }
    const events = ["mousedown", "keydown", "touchstart", "scroll"] as const;
    for (const e of events) window.addEventListener(e, activity, { passive: true });
    return () => {
      window.clearTimeout(timer);
      for (const e of events) window.removeEventListener(e, activity);
    };
  }, [signedIn, signOut]);

  const value = useMemo(() => ({ session, endedReason, signIn, signOut }), [session, endedReason, signIn, signOut]);

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
