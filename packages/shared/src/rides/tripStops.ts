/**
 * The driver's trip as a list of STOPS — "pick up Ama at Legon Hall",
 * "drop off Kofi at Akuafo Hall" — for the stop-based trip screen, used for
 * Ride alone (one pickup, one drop-off) and Shared (up to four of each)
 * alike. Pure, so the ordering rules are tested once here.
 */
import { haversineDistanceMeters } from "../geo/distance";
import type { PassengerStatus } from "../types/ride";

/** How long a rider has to come out once the driver is at the pickup before "Rider didn't show" unlocks. */
export const NO_SHOW_AFTER_MS = 3 * 60_000;

/** Within this many metres of a stop's zone centre, the driver is "at" it (auto-arrival). */
export const AT_STOP_RADIUS_METERS = 60;

/** Seats in a shared car. */
export const CAR_SEATS = 4;

export interface TripZone {
  id: string;
  name: string;
  latitude: number;
  longitude: number;
}

export interface TripPassenger {
  id: string;
  riderName?: string | null;
  riderPhone?: string | null;
  pickupZoneId: string;
  dropoffZoneId: string;
  lockedFare: number | null;
  status: PassengerStatus;
  /** ISO time the driver reached this rider's pickup. */
  arrivedAt?: string | null;
}

export type TripStopKind = "PICKUP" | "DROPOFF";

export interface TripStop {
  /** Stable key: `${passengerId}:${kind}`. */
  key: string;
  kind: TripStopKind;
  passengerId: string;
  /** "Ama" — first name, or "Your rider" when unknown. */
  riderFirstName: string;
  riderPhone: string | null;
  zone: TripZone;
  /** What this rider pays (shown large at their drop-off). */
  farePesewas: number | null;
  passengerStatus: PassengerStatus;
  arrivedAt: string | null;
}

export interface TripPlan {
  /** Stops still to do, in the order to do them. */
  upcoming: TripStop[];
  /** How many stops are already done (for "3 of 4"). */
  doneCount: number;
  /** done + upcoming. */
  totalCount: number;
}

export function firstName(name: string | null | undefined): string {
  const first = name?.trim().split(/\s+/)[0];
  return first ? first : "Your rider";
}

function isGone(status: PassengerStatus): boolean {
  return status === "CANCELLED";
}

/**
 * Orders the remaining stops.
 *
 * - A rider's drop-off never comes before their pickup.
 * - A pickup the driver is already at (rider ARRIVED) comes first, so the
 *   stop being worked on never jumps away mid-pickup.
 * - Otherwise nearest-next from `from` (the driver's position), each stop
 *   then measured from the previous one — a greedy route, good enough for
 *   four riders across a campus. Pickups win a tie, so a car picks up before
 *   it drops off at the same spot.
 */
export function planTripStops(input: {
  passengers: readonly TripPassenger[];
  zones: ReadonlyMap<string, TripZone> | Record<string, TripZone>;
  from: { latitude: number; longitude: number } | null;
}): TripPlan {
  const zoneOf = (id: string): TripZone | undefined =>
    input.zones instanceof Map ? input.zones.get(id) : (input.zones as Record<string, TripZone>)[id];

  const live = input.passengers.filter((p) => !isGone(p.status));
  let doneCount = 0;
  const pending: TripStop[] = [];

  for (const p of live) {
    const base = {
      passengerId: p.id,
      riderFirstName: firstName(p.riderName),
      riderPhone: p.riderPhone ?? null,
      farePesewas: p.lockedFare,
      passengerStatus: p.status,
      arrivedAt: p.arrivedAt ?? null,
    };
    const pickupZone = zoneOf(p.pickupZoneId);
    const dropoffZone = zoneOf(p.dropoffZoneId);

    const pickedUp = p.status === "PICKED_UP" || p.status === "DROPPED_OFF";
    if (pickedUp) doneCount += 1;
    else if (pickupZone) pending.push({ ...base, key: `${p.id}:PICKUP`, kind: "PICKUP", zone: pickupZone });

    if (p.status === "DROPPED_OFF") doneCount += 1;
    else if (dropoffZone) pending.push({ ...base, key: `${p.id}:DROPOFF`, kind: "DROPOFF", zone: dropoffZone });
  }

  const upcoming: TripStop[] = [];
  const pickupDone = new Set(live.filter((p) => p.status === "PICKED_UP").map((p) => p.id));

  // Pin a pickup in progress.
  const atPickup = pending.find((s) => s.kind === "PICKUP" && s.passengerStatus === "ARRIVED");
  let cursor: { latitude: number; longitude: number } | null = input.from;
  if (atPickup) {
    upcoming.push(atPickup);
    pending.splice(pending.indexOf(atPickup), 1);
    pickupDone.add(atPickup.passengerId);
    cursor = atPickup.zone;
  }

  while (pending.length > 0) {
    const available = pending.filter((s) => s.kind === "PICKUP" || pickupDone.has(s.passengerId));
    const pool = available.length > 0 ? available : pending;
    let best = pool[0]!;
    if (cursor) {
      let bestDistance = Infinity;
      for (const s of pool) {
        const d = haversineDistanceMeters(cursor, s.zone) + (s.kind === "DROPOFF" ? 0.5 : 0);
        if (d < bestDistance) {
          bestDistance = d;
          best = s;
        }
      }
    }
    upcoming.push(best);
    pending.splice(pending.indexOf(best), 1);
    if (best.kind === "PICKUP") pickupDone.add(best.passengerId);
    cursor = best.zone;
  }

  return { upcoming, doneCount, totalCount: doneCount + upcoming.length };
}

export type SeatState = "onboard" | "coming" | "empty";

/** Seat dots: filled = on board, light = being picked up, empty = free. */
export function seatStates(passengers: readonly Pick<TripPassenger, "status">[], seats = CAR_SEATS): SeatState[] {
  const onboard = passengers.filter((p) => p.status === "PICKED_UP").length;
  const coming = passengers.filter((p) => p.status === "WAITING" || p.status === "ARRIVED").length;
  return Array.from({ length: seats }, (_, i) =>
    i < onboard ? "onboard" : i < onboard + coming ? "coming" : "empty",
  );
}

/** True when `position` is within AT_STOP_RADIUS_METERS of the stop's zone centre. */
export function isAtStop(
  position: { latitude: number; longitude: number } | null,
  zone: { latitude: number; longitude: number },
  radiusMeters = AT_STOP_RADIUS_METERS,
): boolean {
  return position !== null && haversineDistanceMeters(position, zone) <= radiusMeters;
}

/** When "Rider didn't show" unlocks, or null if the driver hasn't arrived. */
export function noShowAvailableAt(arrivedAt: string | null | undefined): number | null {
  if (!arrivedAt) return null;
  const t = Date.parse(arrivedAt);
  return Number.isFinite(t) ? t + NO_SHOW_AFTER_MS : null;
}

/** "1:24" — how long the driver has been waiting at a pickup. */
export function formatWait(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}
