import type { ReactNode } from "react";
import { Icon } from "../components/Icon";
import { Chip } from "../components/Chip";
import { Link } from "../lib/router";
import { ago } from "../lib/time";
import { useNow } from "../lib/usePolled";
import { useShell } from "./ShellContext";
import { GlobalSearch } from "./GlobalSearch";

const LAUNCH_WORDS = { OFF: "Off", COUNTDOWN: "Countdown", LIVE: "Live" } as const;

/** "Updated 12 s ago · Refresh". */
export function Freshness({ updatedAt, onRefresh, loading }: { updatedAt: number | null; onRefresh: () => void; loading?: boolean }) {
  const now = useNow(5000);
  return (
    <span className="freshness">
      <span className="muted" aria-live="off">
        {loading && !updatedAt ? "Loading…" : updatedAt ? `Updated ${ago(updatedAt, now)}` : ""}
      </span>
      <button type="button" className="text-button small" onClick={onRefresh} disabled={loading}>
        <Icon name="refresh" size={14} />
        Refresh
      </button>
    </span>
  );
}

/**
 * Every page's frame: the top bar (title 28/800 and subtitle, the page's own
 * controls, the launch mode pill linking to Settings, global search), then
 * the page. On a phone the search and pill fold under the title.
 */
export function Page({ title, subtitle, controls, children, wide = false }: { title: string; subtitle?: ReactNode; controls?: ReactNode; children: ReactNode; wide?: boolean }) {
  const { summary } = useShell();
  const mode = summary?.launchMode ?? null;
  return (
    <>
      <header className="topbar">
        <div className="topbar-title">
          <h1>{title}</h1>
          {subtitle ? <p className="subtitle">{subtitle}</p> : null}
        </div>
        <div className="topbar-tools">
          {controls}
          {mode ? (
            <Link to="/settings" className={`launch-pill launch-${mode.toLowerCase()}`} aria-label={`Launch mode: ${LAUNCH_WORDS[mode]}. Open Settings`}>
              <span className="dot" aria-hidden="true" />
              Launch mode: {LAUNCH_WORDS[mode]}
            </Link>
          ) : null}
          <GlobalSearch />
        </div>
      </header>
      {summary?.database === "down" ? (
        <div className="page-alert">
          <Chip tone="red">Database</Chip> The server can&apos;t reach the database right now. Numbers may be out of date.
        </div>
      ) : null}
      <div className={`page${wide ? " page-wide" : ""}`}>{children}</div>
    </>
  );
}

/** A titled block on a page (bordered card, radius 20). */
export function Section({ title, actions, children, className = "" }: { title?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={`card ${className}`}>
      {title || actions ? (
        <div className="card-head">
          {title ? <h2>{title}</h2> : null}
          {actions ? <div className="card-actions">{actions}</div> : null}
        </div>
      ) : null}
      {children}
    </section>
  );
}
