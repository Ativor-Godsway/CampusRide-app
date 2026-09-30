/**
 * The simulator's choices, kept pure (randomness injected) so they can be
 * tested: where a fake rider is picked up, where they go, which ride type,
 * whether they give up, and what they decide when nobody takes the ride.
 */
import type { RideType, RiderCancelReason, RiderDecisionAction } from "@rida/shared";
import { riderCancelReasonsFor } from "@rida/shared";

export type Rng = () => number;

export interface PlannerZone {
  id: string;
  name: string;
  latitude: number;
  longitude: number;
}

function pick<T>(items: readonly T[], rng: Rng): T {
  return items[Math.min(items.length - 1, Math.floor(rng() * items.length))]!;
}

function distanceSq(a: PlannerZone, b: PlannerZone): number {
  return (a.latitude - b.latitude) ** 2 + (a.longitude - b.longitude) ** 2;
}

/** How many of the closest adjacent zones count as "nearby" for pickups. */
const NEARBY_ZONES = 3;

/**
 * The driver's own zone 60% of the time, otherwise one of the nearest zones
 * adjacent to it. On the dev database every zone is adjacent to every other
 * (a full mesh), so "adjacent" alone would mean "anywhere"; taking the
 * closest few keeps pickups genuinely near the driver.
 */
export function pickPickupZone(
  driverZone: PlannerZone,
  adjacent: readonly PlannerZone[],
  rng: Rng,
): PlannerZone {
  const nearby = adjacent
    .filter((z) => z.id !== driverZone.id)
    .sort((a, b) => distanceSq(driverZone, a) - distanceSq(driverZone, b))
    .slice(0, NEARBY_ZONES);
  if (nearby.length === 0 || rng() < 0.6) return driverZone;
  return pick(nearby, rng);
}

/** Any zone other than the pickup. */
export function pickDropoffZone(zones: readonly PlannerZone[], pickup: PlannerZone, rng: Rng): PlannerZone {
  const others = zones.filter((z) => z.id !== pickup.id);
  if (others.length === 0) throw new Error("Need at least two zones to plan a trip");
  return pick(others, rng);
}

export function pickRideType(sharedRatio: number, rng: Rng): RideType {
  return rng() < sharedRatio ? "SHARED" : "LONE";
}

/** Chance that a Shared request brings a second rider going the same way. */
export const PAIR_CHANCE = 0.3;

/** Milliseconds after requesting that this rider gives up, or null if they wait. */
export function planGiveUp(cancelRatio: number, rng: Rng): number | null {
  if (rng() >= cancelRatio) return null;
  return 20_000 + Math.floor(rng() * 40_001);
}

/** A reason the rider app offers while still searching (never a driver-stage one). */
export function pickSearchingCancelReason(rng: Rng): RiderCancelReason {
  return pick(riderCancelReasonsFor("searching"), rng);
}

/**
 * What the rider does when the 90s search runs out: mostly keep waiting, a
 * Shared rider sometimes switches to Ride alone, and some give up.
 */
export function pickDecision(type: RideType, rng: Rng): RiderDecisionAction {
  const r = rng();
  if (type === "SHARED") {
    if (r < 0.45) return "KEEP_WAITING";
    if (r < 0.75) return "SWITCH_TO_LONE";
    return "CANCEL";
  }
  return r < 0.65 ? "KEEP_WAITING" : "CANCEL";
}
