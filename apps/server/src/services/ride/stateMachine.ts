import type {
  PassengerStatus,
  RideCancelReason,
  RideStatus,
} from "@rida/shared";
import { InvalidTransitionError } from "./errors";

// ─── Ride state machine ─────────────────────────────────────────────────────

/**
 * Legal forward/backward Ride status transitions.
 * COMPLETED and CANCELLED are terminal — no outgoing transitions.
 * IN_PROGRESS is the point of no return: only -> COMPLETED.
 */
export const RIDE_TRANSITIONS: Record<RideStatus, readonly RideStatus[]> = {
  REQUESTED: ["MATCHED", "CANCELLED", "AWAITING_RIDER_DECISION"],
  MATCHED: ["ARRIVED", "REQUESTED", "CANCELLED"],
  ARRIVED: ["IN_PROGRESS", "CANCELLED"],
  IN_PROGRESS: ["COMPLETED"],
  COMPLETED: [],
  CANCELLED: [],
  AWAITING_RIDER_DECISION: ["REQUESTED", "CANCELLED"],
};

export function canTransitionRide(from: RideStatus, to: RideStatus): boolean {
  return RIDE_TRANSITIONS[from].includes(to);
}

/**
 * Statuses in which a ride counts as a driver's "active" ride — a driver may
 * hold at most one at a time. AWAITING_RIDER_DECISION is excluded: that
 * status only arises once a ride has no current driver (e.g. driver backed
 * out), so it never conflicts with a new claim.
 */
export const ACTIVE_DRIVER_STATUSES: readonly RideStatus[] = ["MATCHED", "ARRIVED", "IN_PROGRESS"];

export interface RideTransitionContext {
  /** Required when toStatus is "CANCELLED". */
  cancelReason?: RideCancelReason;
}

export interface RideTransitionResult {
  status: RideStatus;
  cancelReason: RideCancelReason | null;
}

/**
 * Validates a Ride status transition and returns the resulting field updates.
 * Throws InvalidTransitionError for any move not listed in RIDE_TRANSITIONS.
 * Throws a plain Error if transitioning to CANCELLED without a cancelReason.
 */
export function transitionRide(
  ride: { status: RideStatus },
  toStatus: RideStatus,
  ctx: RideTransitionContext = {},
): RideTransitionResult {
  if (!canTransitionRide(ride.status, toStatus)) {
    throw new InvalidTransitionError("Ride", ride.status, toStatus);
  }

  if (toStatus === "CANCELLED") {
    if (!ctx.cancelReason) {
      throw new Error(
        "transitionRide: cancelReason is required when transitioning to CANCELLED",
      );
    }
    return { status: toStatus, cancelReason: ctx.cancelReason };
  }

  return { status: toStatus, cancelReason: null };
}

// ─── Passenger state machine ────────────────────────────────────────────────

/**
 * Legal RidePassenger status transitions (Phase 6b-3: per-passenger lifecycle).
 * DROPPED_OFF and CANCELLED are terminal.
 * PICKED_UP -> CANCELLED is illegal (a picked-up passenger can't "cancel").
 */
export const PASSENGER_TRANSITIONS: Record<
  PassengerStatus,
  readonly PassengerStatus[]
> = {
  WAITING: ["ARRIVED", "CANCELLED"],
  ARRIVED: ["PICKED_UP", "CANCELLED"],
  PICKED_UP: ["DROPPED_OFF"],
  DROPPED_OFF: [],
  CANCELLED: [],
};

export function canTransitionPassenger(
  from: PassengerStatus,
  to: PassengerStatus,
): boolean {
  return PASSENGER_TRANSITIONS[from].includes(to);
}

export interface PassengerTransitionResult {
  status: PassengerStatus;
}

/**
 * Validates a RidePassenger status transition and returns the resulting field update.
 * Throws InvalidTransitionError for any move not listed in PASSENGER_TRANSITIONS.
 */
export function transitionPassenger(
  passenger: { status: PassengerStatus },
  toStatus: PassengerStatus,
): PassengerTransitionResult {
  if (!canTransitionPassenger(passenger.status, toStatus)) {
    throw new InvalidTransitionError("RidePassenger", passenger.status, toStatus);
  }
  return { status: toStatus };
}

/**
 * True if a passenger in this status counts toward a ride's occupancy —
 * i.e. they haven't cancelled and haven't been dropped off yet. Phase 6b-3
 * added ARRIVED between WAITING and PICKED_UP; a passenger waiting at the
 * curb for pickup still occupies a seat, so it counts here.
 */
export function isActivePassengerStatus(status: PassengerStatus): boolean {
  return status === "WAITING" || status === "ARRIVED" || status === "PICKED_UP";
}
