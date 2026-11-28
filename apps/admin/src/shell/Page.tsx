import type { ReactNode } from "react";
import { Icon } from "../components/Icon";
import { Chip } from "../components/Chip";
import { Link } from "../lib/router";
import { ago } from "../lib/time";
import { useNow } from "../lib/usePolled";
import { useShell } from "./ShellContext";
import { useInvestorView } from "../lib/useInvestorView";

/** Settings → Display: the "Investor view" switch (masks people everywhere, hides audit details and settings edits). */
export function InvestorSwitch() {
  const { on, toggle } = useInvestorView();
  return (
    <div className="switch-row">
      <button type="button" role="switch" aria-checked={on} aria-label="Investor view" className="big-switch" onClick={toggle} />
      <span>
        <strong>Investor view {on ? "on" : "off"}</strong>
        <span className="muted small">
          For a screen share: riders, drivers and admins become &ldquo;Rider #4821&rdquo; and &ldquo;Driver D317&rdquo;, phone numbers &ldquo;054 *** **46&rdquo;,
          plates and photos are hidden, the audit log is hidden and settings can&apos;t be changed. A small badge shows in the corner while it&apos;s on.
          It stays on until you switch it off or sign out.
        </span>
      </span>
    </div>
  );
}

/** "Updated 2 min ago" and a small refresh button, in the page header's corner. */
export function Freshness({ updatedAt, onRefresh, loading }: { updatedAt: number | null; onRefresh: () => void; loading?: boolean }) {
  const now = useNow(15_000);
  return (
    <span className="freshness">
      <span className="muted" aria-live="off">
        {loading && !updatedAt ? "Loading…" : updatedAt ? `Updated ${ago(updatedAt, now)}` : ""}
      </span>
      <button type="button" className={`icon-button refresh-button${loading ? " spinning" : ""}`} onClick={onRefresh} disabled={loading} aria-label="Refresh" title="Refresh">
        <Icon name="refresh" size={16} />
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
  return (
    <>
      <header className="topbar">
        <div className="topbar-title">
          <h1>{title}</h1>
          {subtitle ? <p className="subtitle">{subtitle}</p> : null}
        </div>
        {controls ? <div className="topbar-tools">{controls}</div> : null}
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

/** While investor view is on: a small badge in the corner (it is switched in Settings → Display). */
export function InvestorBadge() {
  const { on } = useInvestorView();
  if (!on) return null;
  return (
    <Link to="/settings?section=display" className="investor-badge" title="Names, phone numbers and plates are hidden. Switch it off in Settings → Display.">
      <Icon name="eye" size={14} /> Investor view
    </Link>
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
