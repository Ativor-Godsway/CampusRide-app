import { createContext, useCallback, useContext, useEffect, useMemo, useState, type AnchorHTMLAttributes, type ReactNode } from "react";

/**
 * A small history router: every page has a real URL (deep-linkable, back
 * and forward work), detail panels are query parameters on the page they
 * open over (?ride=…, ?driver=…, ?rider=…), and the page's filters live in
 * the query too. No routing library: the site has a dozen flat pages.
 */

interface Location {
  path: string;
  search: URLSearchParams;
}

interface RouterValue extends Location {
  navigate: (to: string, opts?: { replace?: boolean }) => void;
  /** Changes some query parameters of the current page (null removes one). */
  setParams: (changes: Record<string, string | null>, opts?: { replace?: boolean }) => void;
}

const RouterContext = createContext<RouterValue | null>(null);

function read(): Location {
  return { path: window.location.pathname.replace(/\/+$/, "") || "/", search: new URLSearchParams(window.location.search) };
}

export function RouterProvider({ children }: { children: ReactNode }) {
  const [location, setLocation] = useState<Location>(read);

  useEffect(() => {
    const onPop = () => setLocation(read());
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  const navigate = useCallback((to: string, opts: { replace?: boolean } = {}) => {
    if (to === `${window.location.pathname}${window.location.search}`) return;
    if (opts.replace) window.history.replaceState(null, "", to);
    else window.history.pushState(null, "", to);
    setLocation(read());
    if (!opts.replace) window.scrollTo?.(0, 0);
  }, []);

  const setParams = useCallback(
    (changes: Record<string, string | null>, opts: { replace?: boolean } = {}) => {
      const search = new URLSearchParams(window.location.search);
      for (const [key, value] of Object.entries(changes)) {
        if (value === null || value === "") search.delete(key);
        else search.set(key, value);
      }
      const query = search.toString();
      const to = `${window.location.pathname}${query ? `?${query}` : ""}`;
      if (opts.replace) window.history.replaceState(null, "", to);
      else window.history.pushState(null, "", to);
      setLocation(read());
    },
    [],
  );

  const value = useMemo(() => ({ ...location, navigate, setParams }), [location, navigate, setParams]);
  return <RouterContext.Provider value={value}>{children}</RouterContext.Provider>;
}

export function useRouter(): RouterValue {
  const ctx = useContext(RouterContext);
  if (!ctx) throw new Error("useRouter must be used inside <RouterProvider>");
  return ctx;
}

/** An in-site link: a real <a href> (open in a new tab works), navigated without a reload. */
export function Link({ to, children, onClick, ...rest }: { to: string; children: ReactNode } & AnchorHTMLAttributes<HTMLAnchorElement>) {
  const router = useContext(RouterContext);
  return (
    <a
      href={to}
      {...rest}
      onClick={(e) => {
        onClick?.(e);
        if (e.defaultPrevented || !router || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
        e.preventDefault();
        router.navigate(to);
      }}
    >
      {children}
    </a>
  );
}

/** The URL of the current page with some query parameters changed. */
export function withParams(path: string, search: URLSearchParams, changes: Record<string, string | null>): string {
  const next = new URLSearchParams(search);
  for (const [key, value] of Object.entries(changes)) {
    if (value === null || value === "") next.delete(key);
    else next.set(key, value);
  }
  const query = next.toString();
  return `${path}${query ? `?${query}` : ""}`;
}
