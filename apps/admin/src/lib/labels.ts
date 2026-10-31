import type { ChipTone } from "../components/Chip";

/** How a ride's status reads on a chip: always a word, never colour alone. */
export function rideStatusChip(ride: { status: string; cancelReason?: string | null; cancelledBy?: string | null }): { label: string; tone: ChipTone } {
  switch (ride.status) {
    case "REQUESTED":
      return { label: "Looking for driver", tone: "amber" };
    case "AWAITING_RIDER_DECISION":
      return { label: "No driver", tone: "amber" };
    case "MATCHED":
      return { label: "Driver on the way", tone: "green" };
    case "ARRIVED":
      return { label: "Driver arrived", tone: "green" };
    case "IN_PROGRESS":
      return { label: "On trip", tone: "green" };
    case "COMPLETED":
      return { label: "Completed", tone: "neutral" };
    case "CANCELLED":
      if (ride.cancelReason === "MERGED_INTO_ANOTHER_RIDE") return { label: "Joined a car", tone: "neutral" };
      if (ride.cancelReason === "NO_DRIVERS_AVAILABLE") return { label: "No driver", tone: "amber" };
      if (ride.cancelReason === "DRIVER_BACKED_OUT") return { label: "Driver cancelled", tone: "red" };
      if (ride.cancelReason === "ALL_PASSENGERS_LEFT") return { label: "Riders left", tone: "red" };
      return { label: "Rider cancelled", tone: "red" };
    default:
      return { label: ride.status, tone: "neutral" };
  }
}

export const RIDE_STATUS_FILTERS: Array<{ value: string; label: string }> = [
  { value: "", label: "Any status" },
  { value: "REQUESTED", label: "Looking for driver" },
  { value: "AWAITING_RIDER_DECISION", label: "No driver (rider deciding)" },
  { value: "MATCHED", label: "Driver on the way" },
  { value: "ARRIVED", label: "Driver arrived" },
  { value: "IN_PROGRESS", label: "On trip" },
  { value: "COMPLETED", label: "Completed" },
  { value: "CANCELLED", label: "Cancelled" },
];

export function rideTypeLabel(type: string): string {
  return type === "SHARED" ? "Shared" : "Alone";
}

/** "Ama O." for tables (the full name is in the detail). */
export function shortName(name: string): string {
  const parts = name.trim().split(/\s+/);
  if (parts.length < 2) return name;
  return `${parts[0]} ${parts[parts.length - 1]![0]}.`;
}

/** "KA" for an avatar. */
export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  return ((parts[0]?.[0] ?? "") + (parts.length > 1 ? parts[parts.length - 1]![0] : "")).toUpperCase() || "?";
}

export const OFFER_OUTCOME_LABELS: Record<string, string> = {
  ACCEPTED: "Accepted",
  DECLINED: "Declined",
  TIMED_OUT: "Timed out",
  TAKEN: "Taken by another driver",
  CANCELLED: "Rider cancelled",
  EXPIRED: "Expired",
};

export const SESSION_END_LABELS: Record<string, string> = {
  OFFLINE: "Went offline",
  TIMEOUT: "Lost touch with phone",
  ADMIN: "Taken offline by admin",
  ACCOUNT_CLOSED: "Account closed",
};
