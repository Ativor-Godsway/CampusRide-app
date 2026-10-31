import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { keepSessionAlive, logout, setSessionHooks, type AuthUser } from "./api";

/**
 * Session state for the admin app.
 *
 * The server decides how long a session lasts: a 10-minute access token,
 * renewed with a single-use refresh token; an hour without renewing, or 12
 * hours from signing in, ends it. This page renews in the background while
 * someone is clicking or typing (every RENEW_WHILE_ACTIVE_MS of activity), so
 * reading one screen for a long time doesn't end it, and signs itself out
 * after INACTIVITY_MS with no click or key press in any tab, so a screen of
 * rider phone numbers isn't left open on an unattended computer.
 *
 * Every tab of the site shares one session (localStorage, kept in step by
 * `storage` events), so a new tab stays signed in, and renewals are taken one
 * tab at a time (api.ts) so two tabs never present the same refresh token.
 */

export interface Session {
  user: AuthUser;
  accessToken: string;
  refreshToken?: string;
  /** When the server ends this session whatever happens (ISO). */
  sessionExpiresAt?: string;
  /** When the tokens were last renewed (epoch ms); the background renewal counts from it. */
  renewedAt?: number;
  /** How this session began, shown under the admin's name. */
  signedInWith?: "passkey" | "code";
}

interface AuthContextValue {
  session: Session | null;
  /** Why the last session ended, for the login screen; null after a deliberate sign-out. */
  endedReason: string | null;
  signIn: (session: Session) => void;
  signOut: (reason?: string) => void;
}

const STORAGE_KEY = "campusride.admin.session";
/** The last click or key press in any tab (epoch ms). */
const ACTIVITY_KEY = "campusride.admin.activity";
const INACTIVITY_MS = 60 * 60_000;
/** While active, the tokens are renewed once they are this old (well inside the server's idle hour). */
const RENEW_WHILE_ACTIVE_MS = 10 * 60_000;
/** How often the page checks for inactivity and renewal. */
const CHECK_MS = 60_000;
/** Activity is written to storage at most this often. */
const ACTIVITY_WRITE_MS = 15_000;

const AuthContext = createContext<AuthContextValue | null>(null);

function readStoredSession(): Session | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Session;
    // Defensive: only an ADMIN session is usable here regardless of what is
    // sitting in storage, and never one past its hard end or its idle hour.
    if (parsed?.user?.role !== "ADMIN" || !parsed.accessToken) return null;
    if (parsed.sessionExpiresAt && Date.parse(parsed.sessionExpiresAt) <= Date.now()) return null;
    if (Date.now() - lastActivity() > INACTIVITY_MS) return null;
    return parsed;
  } catch {
    return null;
  }
}

function store(session: Session | null): void {
  try {
    if (session) localStorage.setItem(STORAGE_KEY, JSON.stringify(session));
    else localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Private mode / blocked storage: the in-memory session still works for
    // this tab, which is all the app needs.
  }
}

/** The last activity in any tab; 0 when none is recorded. */
function lastActivity(): number {
  try {
    return Number(localStorage.getItem(ACTIVITY_KEY)) || 0;
  } catch {
    return 0;
  }
}

function recordActivity(at: number): void {
  try {
    localStorage.setItem(ACTIVITY_KEY, String(at));
  } catch {
    // As above.
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
      recordActivity(Date.now());
      update({ ...next, renewedAt: Date.now() });
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

  // Another tab signed in, renewed or signed out: follow it.
  useEffect(() => {
    function onStorage(event: StorageEvent) {
      if (event.key !== STORAGE_KEY && event.key !== null) return;
      const next = readStoredSession();
      latest.current = next;
      setSession(next);
    }
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  // Let the API client renew the access token, and end the session when the
  // server won't. `current` reads storage, where another tab may have renewed.
  useEffect(() => {
    setSessionHooks({
      current: () => {
        const stored = readStoredSession() ?? latest.current;
        return stored ? { accessToken: stored.accessToken, refreshToken: stored.refreshToken ?? null } : null;
      },
      onRenewed: (tokens) => {
        const base = readStoredSession() ?? latest.current;
        if (base) update({ ...base, ...tokens, renewedAt: Date.now() });
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
      () => signOut("Your admin session has ended (sessions last at most 12 hours). Please sign in again."),
      Math.max(0, ms),
    );
    return () => window.clearTimeout(timer);
  }, [expiresAt, signOut]);

  // Activity in this tab is shared with the others; once a minute, sign out
  // after an hour with none anywhere, or renew if there was some since the
  // tokens were last renewed and they're getting old.
  const signedIn = session !== null;
  useEffect(() => {
    if (!signedIn) return;
    let lastWrite = 0;
    function activity() {
      const now = Date.now();
      if (now - lastWrite < ACTIVITY_WRITE_MS) return;
      lastWrite = now;
      recordActivity(now);
    }
    activity();
    const events = ["mousedown", "keydown", "touchstart", "scroll"] as const;
    for (const e of events) window.addEventListener(e, activity, { passive: true });
    const timer = window.setInterval(() => {
      const now = Date.now();
      const active = lastActivity();
      if (now - active > INACTIVITY_MS) {
        signOut("You were signed out after an hour without activity. Please sign in again.");
        return;
      }
      const renewedAt = latest.current?.renewedAt ?? 0;
      if (active > renewedAt && now - renewedAt >= RENEW_WHILE_ACTIVE_MS) void keepSessionAlive();
    }, CHECK_MS);
    return () => {
      window.clearInterval(timer);
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
