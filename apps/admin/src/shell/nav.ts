import type { IconName } from "../components/Icon";

/** The admin site's pages, in sidebar order. `badge` names the summary count shown beside it. */
export interface NavItem {
  path: string;
  label: string;
  icon: IconName;
  badge?: "safety" | "cash" | "approvals";
  /** On the phone's bottom tab bar (the rest are under More). */
  tab?: boolean;
  /** The sidebar group it sits in (none: at the top). */
  group?: string;
  /** Hidden from the sidebar but still a page (old links keep working). */
  hidden?: boolean;
}

/**
 * Grouped as the owner asked (2026-11-29): Overview · Live · Rides ·
 * Scheduled · Riders · Drivers · Payouts & commission · Places & zones ·
 * Pricing · Settings · Audit log, with the older pages (supply & demand,
 * cancellations, safety, notifications) beside the ones they belong with.
 */
export const NAV: NavItem[] = [
  { path: "/", label: "Overview", icon: "overview", tab: true },
  { path: "/live", label: "Live", icon: "map", tab: true, group: "Operations" },
  { path: "/rides", label: "Rides", icon: "car", tab: true, group: "Operations" },
  { path: "/scheduled", label: "Scheduled", icon: "clock", group: "Operations" },
  { path: "/supply", label: "Supply & demand", icon: "chart", group: "Operations" },
  { path: "/cancellations", label: "Cancellations", icon: "cancel", group: "Operations" },
  { path: "/safety", label: "Safety", icon: "shield", badge: "safety", group: "Operations" },
  { path: "/riders", label: "Riders", icon: "riders", group: "People" },
  { path: "/drivers", label: "Drivers", icon: "driver", badge: "approvals", group: "People" },
  { path: "/money", label: "Payouts & commission", icon: "cash", badge: "cash", tab: true, group: "Money" },
  { path: "/pricing", label: "Pricing", icon: "tag", group: "Money" },
  { path: "/places", label: "Places & zones", icon: "pin", group: "Setup" },
  { path: "/notifications", label: "Notifications", icon: "bell", group: "Setup" },
  { path: "/settings", label: "Settings", icon: "settings", group: "Setup" },
  { path: "/audit", label: "Audit log", icon: "list", group: "Setup" },
];

/** Old addresses that moved: /cash is now /money. */
export const MOVED: Record<string, string> = { "/cash": "/money" };

/** The nav item a path belongs to ("/drivers" for "/drivers"; null for an unknown path). */
export function navFor(path: string): NavItem | null {
  return NAV.find((n) => n.path === path) ?? null;
}

/** The sidebar: items in order, each group's label before its first item. */
export function navGroups(items: NavItem[] = NAV): Array<{ group: string | null; items: NavItem[] }> {
  const out: Array<{ group: string | null; items: NavItem[] }> = [];
  for (const item of items) {
    if (item.hidden) continue;
    const group = item.group ?? null;
    const last = out[out.length - 1];
    if (last && last.group === group) last.items.push(item);
    else out.push({ group, items: [item] });
  }
  return out;
}
