import type { PassengerStatus } from "@rida/shared";

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
 * Shared seats are priced per trip, not per occupancy (far-trip pricing,
 * 2026-11-24: GH₵7, or GH₵9 for a trip between the north and south ends — locked when
 * the rider asks, services/ride/farePricing.ts). So no event moves a fare:
 * - JOIN: everyone keeps the fare they were quoted. (Until 2026-11-24 a join
 *   clamped every seat to the one flat rate, which would have cut a GH₵9
 *   seat to GH₵7 the moment someone joined.)
 * - CANCEL: fares are never raised back up.
 * - DEPARTURE: fares are frozen.
 * If occupancy discounts ever come back, store each seat's own list price
 * first: the discount has to apply to it, not replace it.
 */
export function recomputeLockedFares(
  passengers: readonly LockedFarePassenger[],
  _event: LockedFareEvent,
): LockedFarePassenger[] {
  return passengers.map((p) => ({ ...p }));
}
