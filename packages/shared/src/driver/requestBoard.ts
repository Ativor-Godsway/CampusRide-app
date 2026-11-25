/**
 * The driver app's request board (2026-11-25): every open request on campus,
 * filtered by pickup then drop-off, and several taken at once ("Add to my
 * trip"). The server lists them (GET /driver/requests/board) and has the
 * final say on every take (claim / add-passenger); these are the app's rules
 * for the chips and for what a selection may hold, so the driver never picks
 * something the car can't take.
 */

import { PRICING } from "../pricing/pricing";

export interface BoardRequest {
  rideId: string;
  type: "LONE" | "SHARED";
  seats?: number;
  pickupZoneId: string;
  pickupZoneName: string;
  dropoffZoneId: string;
  dropoffZoneName: string;
  pickupDistanceMeters?: number | null;
  createdAt: string;
}

export interface BoardChip {
  /** A zone id, or "ALL". */
  key: string;
  label: string;
  count: number;
}

export const BOARD_ALL = "ALL";

function chips<T>(items: readonly T[], keyOf: (t: T) => string, labelOf: (t: T) => string): BoardChip[] {
  const by = new Map<string, BoardChip>();
  for (const item of items) {
    const key = keyOf(item);
    const chip = by.get(key) ?? { key, label: labelOf(item), count: 0 };
    chip.count += 1;
    by.set(key, chip);
  }
  const sorted = [...by.values()].sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
  return [{ key: BOARD_ALL, label: "All", count: items.length }, ...sorted];
}

/** "All (7)", then each pickup zone with open requests: "Pentagon Hostel (3)", most first. */
export function boardPickupChips(items: readonly BoardRequest[]): BoardChip[] {
  return chips(items, (r) => r.pickupZoneId, (r) => r.pickupZoneName);
}

/** The drop-offs among the requests that match the pickup filter. */
export function boardDropoffChips(items: readonly BoardRequest[], pickup: string): BoardChip[] {
  return chips(
    items.filter((r) => pickup === BOARD_ALL || r.pickupZoneId === pickup),
    (r) => r.dropoffZoneId,
    (r) => r.dropoffZoneName,
  );
}

/** The requests matching both filters, nearest pickup first (unknown distance last, then newest). */
export function filterBoard<T extends BoardRequest>(items: readonly T[], filter: { pickup: string; dropoff: string }): T[] {
  return items
    .filter((r) => filter.pickup === BOARD_ALL || r.pickupZoneId === filter.pickup)
    .filter((r) => filter.dropoff === BOARD_ALL || r.dropoffZoneId === filter.dropoff)
    .sort(
      (a, b) =>
        (a.pickupDistanceMeters ?? Infinity) - (b.pickupDistanceMeters ?? Infinity) || b.createdAt.localeCompare(a.createdAt),
    );
}

/**
 * A filter that no longer matches anything (its requests were taken) falls
 * back to All, so the driver is never left looking at an empty filter.
 */
export function settleBoardFilter(items: readonly BoardRequest[], filter: { pickup: string; dropoff: string }): { pickup: string; dropoff: string } {
  const pickup = filter.pickup === BOARD_ALL || items.some((r) => r.pickupZoneId === filter.pickup) ? filter.pickup : BOARD_ALL;
  if (pickup !== filter.pickup) return { pickup: BOARD_ALL, dropoff: BOARD_ALL };
  const inPickup = items.filter((r) => pickup === BOARD_ALL || r.pickupZoneId === pickup);
  const dropoff = filter.dropoff === BOARD_ALL || inPickup.some((r) => r.dropoffZoneId === filter.dropoff) ? filter.dropoff : BOARD_ALL;
  return { pickup, dropoff };
}

/** The driver's trip, as the board sees it. */
export interface BoardCar {
  rideId: string;
  type: "LONE" | "SHARED";
  freeSeats: number;
}

export type BoardPlan =
  | {
      ok: true;
      /** With no trip: the request claimed first (it becomes the trip). Null on a trip. */
      claim: string | null;
      /** Added to the car, in this order. */
      add: string[];
      seats: number;
    }
  | { ok: false; message: string };

const seatsOf = (r: Pick<BoardRequest, "seats">) => r.seats ?? 1;

/**
 * What "Add to my trip" will do with this selection, or why it can't:
 * - no trip: the nearest Shared request is claimed (or the one Ride alone
 *   request, which must be taken on its own), the rest added to that car;
 * - a Shared trip: all added, Shared only, within the free seats;
 * - a Ride alone trip: nothing.
 * At most PRICING.MAX_SHARED_OCCUPANCY (4) riders in a car.
 */
export function planBoardTake(selected: readonly BoardRequest[], car: BoardCar | null): BoardPlan {
  if (selected.length === 0) return { ok: false, message: "Choose at least one request." };
  const seats = selected.reduce((n, r) => n + seatsOf(r), 0);
  const lone = selected.filter((r) => r.type === "LONE");
  if (car) {
    if (car.type !== "SHARED") return { ok: false, message: "Your trip is Ride alone: no one else can join it." };
    if (lone.length > 0) return { ok: false, message: "Ride alone requests need an empty car." };
    if (seats > car.freeSeats) {
      return { ok: false, message: car.freeSeats === 0 ? "Your car is full." : `Only ${car.freeSeats} free seat${car.freeSeats === 1 ? "" : "s"} in your car.` };
    }
    return { ok: true, claim: null, add: selected.map((r) => r.rideId), seats };
  }
  if (lone.length > 0) {
    if (selected.length > 1) return { ok: false, message: "A Ride alone request can't share the car: take it on its own." };
    return { ok: true, claim: lone[0]!.rideId, add: [], seats };
  }
  if (seats > PRICING.MAX_SHARED_OCCUPANCY) return { ok: false, message: `A car takes at most ${PRICING.MAX_SHARED_OCCUPANCY} riders.` };
  const [first, ...rest] = [...selected].sort((a, b) => (a.pickupDistanceMeters ?? Infinity) - (b.pickupDistanceMeters ?? Infinity));
  return { ok: true, claim: first!.rideId, add: rest.map((r) => r.rideId), seats };
}

/** One request's result after "Add to my trip". */
export type BoardTakeResult = { rideId: string; outcome: "added" | "taken" | "refused"; message?: string };

/** "2 added. 1 already taken." — what the board says afterwards. */
export function boardTakeSummary(results: readonly BoardTakeResult[]): string {
  const added = results.filter((r) => r.outcome === "added").length;
  const taken = results.filter((r) => r.outcome === "taken").length;
  const refused = results.filter((r) => r.outcome === "refused");
  const parts = [
    added ? `${added} added.` : null,
    taken ? `${taken === 1 ? "1 was" : `${taken} were`} already taken.` : null,
    ...refused.map((r) => r.message ?? "One couldn't be added."),
  ].filter(Boolean);
  return parts.join(" ") || "Nothing was added.";
}
