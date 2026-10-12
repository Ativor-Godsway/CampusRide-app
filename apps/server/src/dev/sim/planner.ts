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

// ─── Exact pins (campus places) ──────────────────────────────────────────────

/** How many of the places nearest the driver a pickup is chosen from. */
const NEARBY_PLACES = 8;
/** A drop-off at least this far from the pickup (a real trip, not across the road). */
export const MIN_SIM_TRIP_METERS = 300;

function metersBetween(a: { latitude: number; longitude: number }, b: { latitude: number; longitude: number }): number {
  const kx = Math.cos((a.latitude * Math.PI) / 180) * 111_320;
  return Math.hypot((a.latitude - b.latitude) * 110_574, (a.longitude - b.longitude) * kx);
}

/** One of the campus places nearest `near` (the driver's zone), so pickups are close to the driver. */
export function pickPickupPlace(near: { latitude: number; longitude: number }, places: readonly PlannerZone[], rng: Rng): PlannerZone {
  if (places.length === 0) throw new Error("No places to pick from");
  const nearby = [...places].sort((a, b) => metersBetween(near, a) - metersBetween(near, b)).slice(0, NEARBY_PLACES);
  return pick(nearby, rng);
}

/** Any place at least MIN_SIM_TRIP_METERS from the pickup (any other place if none is that far). */
export function pickDropoffPlace(places: readonly PlannerZone[], pickup: PlannerZone, rng: Rng): PlannerZone {
  const far = places.filter((p) => p.id !== pickup.id && metersBetween(p, pickup) >= MIN_SIM_TRIP_METERS);
  const pool = far.length > 0 ? far : places.filter((p) => p.id !== pickup.id);
  if (pool.length === 0) throw new Error("Need at least two places to plan a trip");
  return pick(pool, rng);
}

/** A point `meters` or less from `p`, in a random direction. */
export function nudge(p: { latitude: number; longitude: number }, meters: number, rng: Rng): { latitude: number; longitude: number } {
  const d = meters * Math.sqrt(rng());
  const angle = rng() * 2 * Math.PI;
  const kx = Math.cos((p.latitude * Math.PI) / 180) * 111_320;
  return {
    latitude: Number((p.latitude + (d * Math.cos(angle)) / 110_574).toFixed(6)),
    longitude: Number((p.longitude + (d * Math.sin(angle)) / kx).toFixed(6)),
  };
}

export interface PlannedEnd {
  /** For the log: "Night Market", "Night Market (pin moved)", "near Night Market (dropped pin)". */
  description: string;
  /**
   * One end of the POST /rides body as the rider app sends it — or, on a
   * database without places, a zone id (as older app builds book).
   */
  body: { placeId?: string; latitude?: number; longitude?: number } | { zoneId: string };
}

/**
 * How a fake rider gives one end, mixed like real riders: the place itself
 * (half the time), the place with its pin nudged up to 40 m ("Move pin to
 * the exact spot"), or a pin dropped up to 80 m from it.
 */
export function planEnd(place: PlannerZone, rng: Rng): PlannedEnd {
  const r = rng();
  if (r < 0.5) return { description: place.name, body: { placeId: place.id } };
  if (r < 0.8) return { description: `${place.name} (pin moved)`, body: { placeId: place.id, ...nudge(place, 40, rng) } };
  return { description: `near ${place.name} (dropped pin)`, body: nudge(place, 80, rng) };
}

export const SIM_PICKUP_NOTES = [
  "At the main entrance",
  "Blue shirt, by the notice board",
  "Under the big tree",
  "Waiting at the bus stop",
  "By the security post",
] as const;

/** A note for the driver about a third of the time, else null. */
export function pickPickupNote(rng: Rng): string | null {
  return rng() < 0.33 ? pick(SIM_PICKUP_NOTES, rng) : null;
}
