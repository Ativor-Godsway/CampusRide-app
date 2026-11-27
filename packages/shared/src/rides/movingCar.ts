/**
 * Fill moving cars first (2026-11-28). The pooling analysis of the launch
 * (Days 1–4) found 12% of Shared requests arrived while a car already on a
 * trip, with a free seat, was heading the same way, and most were missed:
 * the moving driver let the pop-up run out, or an idle driver tapped first.
 *
 * So a new live Shared request goes FIRST to the best compatible moving car:
 * - a moving car: a driver on a Shared trip (a scheduled trip that started
 *   counts) with at least one rider, live, with free seats for the request;
 * - compatible: adding the request's pickup and drop-off to the car's
 *   remaining route (from where the driver is: the pickups still to do,
 *   then every drop-off, shortest order) adds at most `maxExtraMeters` and
 *   `maxExtraMinutes` — the scheduled-rides limits (rides/scheduled.ts);
 * - best: the least added route.
 * That driver either has the rider added at once (auto-add, with Undo for
 * AUTO_ADD_UNDO_SECONDS) or gets an exclusive offer for MOVING_OFFER_SECONDS.
 * Idle drivers don't see the request until then. Declined, expired or
 * undone: normal dispatch.
 */
import { formatCedis } from "../format/currency";
import { haversineDistanceMeters } from "../geo/distance";
import { ASSUMED_AVERAGE_SPEED_KMH, ROAD_CIRCUITY_FACTOR } from "../eta/eta";
import { seatsWord } from "./seats";

export const MOVING_OFFER_SECONDS = 20;
export const AUTO_ADD_UNDO_SECONDS = 15;
/** The driver app's features header lists this when it can show an auto-added rider with Undo. */
export const AUTO_ADD_FEATURE = "auto-add";
/** A short stop at each pickup or drop-off before the new rider's pickup (the ETA). */
export const STOP_DWELL_MINUTES = 1;

export const MOVING_STEPS = ["NONE", "AUTO_ADDED", "OFFERED", "DECLINED", "EXPIRED", "UNDONE"] as const;
export type MovingStep = (typeof MOVING_STEPS)[number];

export const MOVING_STEP_LABELS: Record<MovingStep, string> = {
  NONE: "No moving car fitted",
  AUTO_ADDED: "Auto-added",
  OFFERED: "Offered to a moving car",
  DECLINED: "Moving driver declined",
  EXPIRED: "Moving driver didn't answer",
  UNDONE: "Auto-add undone",
};

export interface LatLngPoint {
  latitude: number;
  longitude: number;
}

/** A car on a trip as the step sees it: where the driver is, and the stops still to do. */
export interface MovingRoute {
  from: LatLngPoint;
  pickups: readonly LatLngPoint[];
  dropoffs: readonly LatLngPoint[];
}

export interface MovingLimits {
  maxExtraMeters: number;
  maxExtraMinutes: number;
}

function permutations(n: number): number[][] {
  if (n <= 1) return [Array.from({ length: n }, (_, i) => i)];
  const out: number[][] = [];
  for (const rest of permutations(n - 1)) {
    for (let i = 0; i <= rest.length; i++) out.push([...rest.slice(0, i), n - 1, ...rest.slice(i)]);
  }
  return out;
}

const road = (a: LatLngPoint, b: LatLngPoint) => haversineDistanceMeters(a, b) * ROAD_CIRCUITY_FACTOR;
const minutesFor = (meters: number) => meters / ((ASSUMED_AVERAGE_SPEED_KMH * 1000) / 60);

/** The shortest route from the driver: every pickup, then every drop-off. Metres, and the stops in order. */
export function shortestRoute(route: MovingRoute): { meters: number; stops: Array<{ kind: "PICKUP" | "DROPOFF"; index: number }> } {
  let best = { meters: Number.POSITIVE_INFINITY, stops: [] as Array<{ kind: "PICKUP" | "DROPOFF"; index: number }> };
  for (const po of permutations(route.pickups.length)) {
    for (const dorder of permutations(route.dropoffs.length)) {
      const path = [route.from, ...po.map((i) => route.pickups[i]!), ...dorder.map((i) => route.dropoffs[i]!)];
      let m = 0;
      for (let i = 1; i < path.length; i++) m += road(path[i - 1]!, path[i]!);
      if (m < best.meters) {
        best = {
          meters: m,
          stops: [...po.map((index) => ({ kind: "PICKUP" as const, index })), ...dorder.map((index) => ({ kind: "DROPOFF" as const, index }))],
        };
      }
    }
  }
  return best;
}

export interface MovingFit {
  /** Road metres and driving minutes the request adds to the car's remaining route. */
  extraMeters: number;
  extraMinutes: number;
  /** About when the car reaches the new pickup (driving plus a short stop at each stop before it). */
  pickupEtaMinutes: number;
  fits: boolean;
}

/** What adding this pickup and drop-off does to a moving car's route. */
export function movingCarFit(route: MovingRoute, pickup: LatLngPoint, dropoff: LatLngPoint, limits: MovingLimits): MovingFit {
  const before = shortestRoute(route);
  const withNew: MovingRoute = { from: route.from, pickups: [...route.pickups, pickup], dropoffs: [...route.dropoffs, dropoff] };
  const after = shortestRoute(withNew);
  const extraMeters = Math.max(0, after.meters - before.meters);
  const extraMinutes = minutesFor(extraMeters);
  // Along the new route, to the new pickup.
  const newIndex = withNew.pickups.length - 1;
  let at = route.from;
  let meters = 0;
  let stopsBefore = 0;
  for (const stop of after.stops) {
    const p = stop.kind === "PICKUP" ? withNew.pickups[stop.index]! : withNew.dropoffs[stop.index]!;
    meters += road(at, p);
    at = p;
    if (stop.kind === "PICKUP" && stop.index === newIndex) break;
    stopsBefore += 1;
  }
  return {
    extraMeters,
    extraMinutes,
    pickupEtaMinutes: Math.max(1, Math.round(minutesFor(meters) + stopsBefore * STOP_DWELL_MINUTES)),
    fits: extraMeters <= limits.maxExtraMeters && extraMinutes <= limits.maxExtraMinutes,
  };
}

/** Within this many metres, two cars add "the same" route: the one reaching the pickup sooner wins. */
export const MOVING_TIE_METERS = 50;

/** The compatible car that adds the least route (a near tie: the sooner pickup), or null. */
export function bestMovingCar<T>(
  cars: ReadonlyArray<{ car: T; route: MovingRoute }>,
  pickup: LatLngPoint,
  dropoff: LatLngPoint,
  limits: MovingLimits,
): { car: T; fit: MovingFit } | null {
  let best: { car: T; fit: MovingFit } | null = null;
  for (const c of cars) {
    const fit = movingCarFit(c.route, pickup, dropoff, limits);
    if (!fit.fits) continue;
    const better =
      !best ||
      fit.extraMeters < best.fit.extraMeters - MOVING_TIE_METERS ||
      (Math.abs(fit.extraMeters - best.fit.extraMeters) <= MOVING_TIE_METERS && fit.pickupEtaMinutes < best.fit.pickupEtaMinutes);
    if (better) best = { car: c.car, fit };
  }
  return best;
}

/** Whole minutes for a label ("+3 min"), at least 1. */
export function addedMinutes(extraMinutes: number): number {
  return Math.max(1, Math.round(extraMinutes));
}

/** The driver's banner: "Rider added · Ama · Pentagon Block C · 2 seats · +GH₵14 · +3 min". */
export function riderAddedText(input: { firstName: string; pickupLabel: string; seats: number; farePesewas: number; extraMinutes: number }): string {
  return [
    "Rider added",
    input.firstName,
    input.pickupLabel,
    ...(input.seats > 1 ? [seatsWord(input.seats)] : []),
    `+${formatCedis(input.farePesewas)}`,
    `+${addedMinutes(input.extraMinutes)} min`,
  ].join(" · ");
}

/** The on-trip offer line: "+GH₵7 · +3 min · Pentagon Block C → JQB". */
export function movingOfferLine(input: { farePesewas: number; extraMinutes: number; from: string; to: string }): string {
  return `+${formatCedis(input.farePesewas)} · +${addedMinutes(input.extraMinutes)} min · ${input.from} → ${input.to}`;
}

/** The board's mark for a request that fits the driver's car: "On your way · +3 min". */
export function onYourWayLabel(extraMinutes: number): string {
  return `On your way · +${addedMinutes(extraMinutes)} min`;
}

/** The rider's screen and push: "You've joined Kofi's car, already on the way. Pickup in about 4 min". */
export function joinedCarText(driverFirstName: string, pickupEtaMinutes: number | null): string {
  const eta = pickupEtaMinutes !== null ? ` Pickup in about ${Math.max(1, Math.round(pickupEtaMinutes))} min` : "";
  return `You've joined ${driverFirstName || "your driver"}'s car, already on the way.${eta}`;
}

/** Whether the driver has auto-add on: their own choice, else the admin default. */
export function autoAddOn(driverChoice: boolean | null | undefined, adminDefault: boolean): boolean {
  return driverChoice ?? adminDefault;
}
