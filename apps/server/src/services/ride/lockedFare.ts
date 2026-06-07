import { getSharedFarePerRider } from "@rida/shared";
import type { PassengerStatus } from "@rida/shared";
import { isActivePassengerStatus } from "./stateMachine";

export interface LockedFarePassenger {
  id: string;
  status: PassengerStatus;
  lockedFare: number;
}

export type LockedFareEvent =
  /** A new passenger has joined a SHARED ride (occupancy increased). */
  | { type: "JOIN" }
  /** A passenger has cancelled (occupancy decreased). */
  | { type: "CANCEL" }
  /** The ride has departed (ARRIVED -> IN_PROGRESS); fares freeze permanently. */
  | { type: "DEPARTURE" };

/**
 * Recomputes lockedFare for each passenger of a SHARED ride in response to an
 * occupancy-changing event. Pure — returns a new array, never mutates.
 *
 * Rules (downward-only ratchet):
 * - JOIN: occupancy increases (the new passenger is already included in
 *   `passengers`). Every active (WAITING/PICKED_UP) passenger's lockedFare is
 *   recomputed to getSharedFarePerRider(activeCount) — the new, lower rate.
 *   Math.min guards against ever raising a fare.
 * - CANCEL: occupancy decreases. Remaining passengers keep their existing
 *   lockedFare — fares are never raised back up.
 * - DEPARTURE: fares are frozen; no changes.
 */
export function recomputeLockedFares(
  passengers: readonly LockedFarePassenger[],
  event: LockedFareEvent,
): LockedFarePassenger[] {
  if (event.type !== "JOIN") {
    return passengers.map((p) => ({ ...p }));
  }

  const activeCount = passengers.filter((p) =>
    isActivePassengerStatus(p.status),
  ).length;
  const newRate = getSharedFarePerRider(activeCount);

  return passengers.map((p) => {
    if (!isActivePassengerStatus(p.status)) {
      return { ...p };
    }
    return { ...p, lockedFare: Math.min(p.lockedFare, newRate) };
  });
}
