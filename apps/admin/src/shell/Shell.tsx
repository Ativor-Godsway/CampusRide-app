import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { getSummary, type Summary } from "../api";
import { useAuth, useToken } from "../auth";
import { Icon, Logo } from "../components/Icon";
import { cedis } from "../lib/money";
import { Link, useRouter } from "../lib/router";
import { initials } from "../lib/labels";
import { usePolled } from "../lib/usePolled";
import { NAV, type NavItem } from "./nav";
import { ShellContext, useShell as useContextSummary } from "./ShellContext";

function Badge({ item, summary }: { item: NavItem; summary: Summary | null }) {
  if (!summary || !item.badge) return null;
  if (item.badge === "safety" && summary.openSos > 0) {
    return (
      <span className="nav-badge badge-red" aria-label={`${summary.openSos} open SOS`}>
        {summary.openSos}
      </span>
    );
  }
  if (item.badge === "cash" && summary.cashOutstandingPesewas > 0) {
    return (
      <span className="nav-badge badge-amber" aria-label={`${cedis(summary.cashOutstandingPesewas)} still owed`}>
        {cedis(Math.round(summary.cashOutstandingPesewas / 100) * 100)}
      </span>
    );
  }
  if (item.badge === "approvals" && summary.driversNeedingApproval > 0) {
    return (
      <span className="nav-badge badge-green" aria-label={`${summary.driversNeedingApproval} need approval`}>
        {summary.driversNeedingApproval}
      </span>
    );
  }
  return null;
}

/**
 * The admin site's frame. Wide screens (≥ 900 px): the left sidebar with
 * every page, badges (open SOS, cash still owed, drivers to approve) and the
 * signed-in admin. Narrow screens (an iPhone): a bottom tab bar (Overview,
 * Live map, Rides, Cash owed, More), safe areas respected.
 */
export function Shell({ children }: { children: ReactNode }) {
  const token = useToken();
  const { session, signOut } = useAuth();
  const { path } = useRouter();
  const polled = usePolled(() => getSummary(token), "summary");
  const [summary, setSummary] = useState<Summary | null>(null);
  useEffect(() => {
    if (polled.data) setSummary(polled.data);
  }, [polled.data]);
  const refreshSummary = polled.refresh;
  const shell = useMemo(() => ({ summary, refreshSummary }), [summary, refreshSummary]);
  const isActive = useCallback((item: NavItem) => (item.path === "/" ? path === "/" : path.startsWith(item.path)), [path]);
  const name = session?.user.name ?? "Admin";
  const moreActive = !NAV.some((n) => n.tab && isActive(n)) && path !== "/";

  return (
    <ShellContext.Provider value={shell}>
      <a href="#main" className="skip-link">
        Skip to content
      </a>
      <div className="shell">
        <nav className="sidebar" aria-label="Admin sections">
          <div className="brand">
            <Logo />
            <div>
              <span className="brand-name">CampusRide</span>
              <span className="brand-sub">Admin</span>
            </div>
          </div>
          <ul className="nav-list">
            {NAV.map((item) => (
              <li key={item.path}>
                <Link to={item.path} className={isActive(item) ? "nav-link active" : "nav-link"} aria-current={isActive(item) ? "page" : undefined}>
                  <Icon name={item.icon} />
                  <span>{item.label}</span>
                  <Badge item={item} summary={summary} />
                </Link>
              </li>
            ))}
          </ul>
          <div className="me">
            <span className="avatar" aria-hidden="true">
              {initials(name)}
            </span>
            <div className="me-text">
              <span className="me-name">{name}</span>
              <span className="me-how">{session?.signedInWith === "passkey" ? "Signed in with passkey" : session?.signedInWith === "code" ? "Signed in with code" : "Signed in"}</span>
            </div>
            <button type="button" className="icon-button" aria-label="Sign out" title="Sign out" onClick={() => signOut()}>
              <Icon name="signout" />
            </button>
          </div>
        </nav>
        <main id="main" className="main" tabIndex={-1}>
          {children}
        </main>
        <nav className="tabbar" aria-label="Admin sections">
          {NAV.filter((n) => n.tab).map((item) => (
            <Link key={item.path} to={item.path} className={isActive(item) ? "tab active" : "tab"} aria-current={isActive(item) ? "page" : undefined}>
              <span className="tab-icon">
                <Icon name={item.icon} size={22} />
                {item.badge ? <Badge item={item} summary={summary} /> : null}
              </span>
              <span>{item.label === "Cash owed" ? "Cash" : item.label}</span>
            </Link>
          ))}
          <Link to="/more" className={moreActive ? "tab active" : "tab"} aria-current={path === "/more" ? "page" : undefined}>
            <span className="tab-icon">
              <Icon name="more" size={22} />
              {summary && summary.openSos > 0 ? <span className="tab-dot" aria-label={`${summary.openSos} open SOS`} /> : null}
            </span>
            <span>More</span>
          </Link>
        </nav>
      </div>
    </ShellContext.Provider>
  );
}

/** The phone's More tab: every page not on the tab bar, then signing out. */
export function MorePage() {
  const { session, signOut } = useAuth();
  const { summary } = useContextSummary();
  return (
    <div className="page more-page">
      <h1>More</h1>
      <ul className="more-list">
        {NAV.filter((n) => !n.tab).map((item) => (
          <li key={item.path}>
            <Link to={item.path} className="more-link">
              <Icon name={item.icon} />
              <span>{item.label}</span>
              <Badge item={item} summary={summary} />
              <Icon name="chevron" size={16} className="more-chevron" />
            </Link>
          </li>
        ))}
      </ul>
      <p className="muted small">Signed in as {session?.user.name}.</p>
      <button type="button" className="danger-button" onClick={() => signOut()}>
        Sign out
      </button>
    </div>
  );
}

