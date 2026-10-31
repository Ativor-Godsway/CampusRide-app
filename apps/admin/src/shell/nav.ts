import type { IconName } from "../components/Icon";

/** The admin site's pages, in sidebar order. `badge` names the summary count shown beside it. */
export interface NavItem {
  path: string;
  label: string;
  icon: IconName;
  badge?: "safety" | "cash" | "approvals";
  /** On the phone's bottom tab bar (the rest are under More). */
  tab?: boolean;
}

export const NAV: NavItem[] = [
  { path: "/", label: "Overview", icon: "overview", tab: true },
  { path: "/live", label: "Live map", icon: "map", tab: true },
  { path: "/rides", label: "Rides", icon: "car", tab: true },
  { path: "/supply", label: "Supply & demand", icon: "chart" },
  { path: "/cancellations", label: "Cancellations", icon: "cancel" },
  { path: "/drivers", label: "Drivers", icon: "driver", badge: "approvals" },
  { path: "/cash", label: "Cash owed", icon: "cash", badge: "cash", tab: true },
  { path: "/riders", label: "Riders", icon: "riders" },
  { path: "/places", label: "Places", icon: "pin" },
  { path: "/safety", label: "Safety", icon: "shield", badge: "safety" },
  { path: "/notifications", label: "Notifications", icon: "bell" },
  { path: "/settings", label: "Settings", icon: "settings" },
];

/** The nav item a path belongs to ("/drivers" for "/drivers"; null for an unknown path). */
export function navFor(path: string): NavItem | null {
  return NAV.find((n) => n.path === path) ?? null;
}
