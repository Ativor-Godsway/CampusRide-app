import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError, failureText } from "../api";
import { useAuth } from "../auth";

/** Most pages: once a minute (the database plan bills compute; the server caches aggregates for 60 s). */
export const PAGE_REFRESH_MS = 60_000;
/** The live map: every 5 s (from the server's memory, not the database). */
export const LIVE_REFRESH_MS = 5_000;

export interface Polled<T> {
  data: T | null;
  error: string | null;
  loading: boolean;
  /** When the data on screen was fetched (epoch ms). */
  updatedAt: number | null;
  refresh: () => void;
}

/**
 * Loads `load()` now, again whenever `key` changes, and every `intervalMs`
 * while the browser tab is visible (paused when hidden; caught up at once
 * when it shows again). A failed refresh keeps the last data on screen with
 * the error beside it. A 401/403 signs the site out.
 */
export function usePolled<T>(
  load: () => Promise<T>,
  key: string,
  intervalMs: number = PAGE_REFRESH_MS,
  /** What the page calls this data ("Loading the audit log"), so a failure says which part failed. */
  section = "Loading this page",
): Polled<T> {
  const { signOut } = useAuth();
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [updatedAt, setUpdatedAt] = useState<number | null>(null);
  const loader = useRef(load);
  loader.current = load;
  const generation = useRef(0);
  const lastRun = useRef(0);

  const run = useCallback(async () => {
    const mine = ++generation.current;
    lastRun.current = Date.now();
    setLoading(true);
    try {
      const next = await loader.current();
      if (mine !== generation.current) return;
      setData(next);
      setError(null);
      setUpdatedAt(Date.now());
    } catch (err) {
      if (mine !== generation.current) return;
      if (err instanceof ApiError && (err.status === 401 || err.status === 403)) {
        signOut();
        return;
      }
      setError(failureText(section, err));
    } finally {
      if (mine === generation.current) setLoading(false);
    }
  }, [signOut, section]);

  // A new key (period, filters) starts afresh.
  useEffect(() => {
    setData(null);
    setUpdatedAt(null);
    void run();
  }, [key, run]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") void run();
    }, intervalMs);
    const onVisible = () => {
      if (document.visibilityState === "visible" && Date.now() - lastRun.current >= intervalMs) void run();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [intervalMs, run, key]);

  return { data, error, loading, updatedAt, refresh: () => void run() };
}

/** Re-renders every `ms` (for "Updated 12 s ago"). */
export function useNow(ms = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), ms);
    return () => window.clearInterval(t);
  }, [ms]);
  return now;
}
