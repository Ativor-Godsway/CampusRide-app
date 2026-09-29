import type { PassengerStatus, RideStatus, RideType } from "../types/ride";

export interface ActiveRideStatusInput {
  status: RideStatus;
  type: RideType;
  /** The rider's own leg (their seat row); null if they have none. */
  legStatus: PassengerStatus | null;
  driverFirstName?: string | null;
  /** Minutes until the driver reaches the pickup, or null if unknown. */
  etaMinutes?: number | null;
}

/**
 * Whether the rider has actually been picked up. LONE rides never update the
 * seat row (it stays WAITING), so for them the ride status decides — the same
 * rule the ride screen uses.
 */
function riderLeg(
  input: ActiveRideStatusInput,
): "WAITING" | "ARRIVED" | "PICKED_UP" | "DROPPED_OFF" {
  if (input.type === "LONE") {
    if (input.status === "ARRIVED") return "ARRIVED";
    if (input.status === "IN_PROGRESS") return "PICKED_UP";
    return "WAITING";
  }
  const leg = input.legStatus;
  return leg === "ARRIVED" || leg === "PICKED_UP" || leg === "DROPPED_OFF" ? leg : "WAITING";
}

/**
 * One short line for the "active ride" banner, from real state only:
 * "Finding your driver…", "Kofi is 3 min away", "On your trip", …
 */
export function activeRideStatusLine(input: ActiveRideStatusInput): string {
  const driver = input.driverFirstName?.trim() || "Your driver";

  if (input.status === "REQUESTED") return "Finding your driver…";
  if (input.status === "AWAITING_RIDER_DECISION") return "No drivers yet — tap to choose";

  const leg = riderLeg(input);
  if (leg === "DROPPED_OFF") return "You've arrived — tap for your fare";
  if (leg === "PICKED_UP") return "On your trip";
  if (leg === "ARRIVED") return `${driver} has arrived`;

  const eta = input.etaMinutes;
  if (eta !== null && eta !== undefined && Number.isFinite(eta)) {
    return `${driver} is ${Math.max(1, Math.round(eta))} min away`;
  }
  return `${driver} is on the way`;
}

/**
 * What "leaving" a live ride screen should do:
 * - "confirm": the ride can still be cancelled (searching, or waiting for a
 *   driver who hasn't picked the rider up) — ask before leaving;
 * - "minimise": the rider is on the trip (or it can no longer be cancelled)
 *   — go to Home and let the trip carry on;
 * - "leave": nothing is going on; leave normally.
 */
export function rideLeaveBehaviour(input: {
  status: RideStatus | null | undefined;
  type: RideType;
  legStatus: PassengerStatus | null;
}): "confirm" | "minimise" | "leave" {
  const { status } = input;
  if (!status || status === "COMPLETED" || status === "CANCELLED") return "leave";
  if (input.legStatus === "CANCELLED") return "leave";
  const leg = riderLeg({ ...input, status });
  if (leg === "PICKED_UP" || leg === "DROPPED_OFF" || status === "IN_PROGRESS") return "minimise";
  return "confirm";
}
