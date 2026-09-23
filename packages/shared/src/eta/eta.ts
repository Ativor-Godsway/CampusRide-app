import { haversineDistanceMeters } from "../geo/distance";

/**
 * Straight-line ETA estimation (Phase 4, v1).
 *
 * Deliberately NOT a routing calculation: there is no directions API, no road
 * graph and no traffic feed in this project, and adding one is its own piece
 * of work. This estimates from great-circle distance and an assumed average
 * speed, then pads for the fact that roads are not straight lines.
 *
 * The result is shown to riders as "about N min", so it is rounded to whole
 * minutes and floored at 1 — "about 0 min" reads as broken, and a driver who
 * is metres away is still a minute from actually being at the kerb.
 */

/**
 * Assumed average speed in km/h for a vehicle on campus and its immediate
 * surroundings. Low on purpose: this covers speed bumps, pedestrians, gates
 * and junctions, not open-road driving.
 */
export const ASSUMED_AVERAGE_SPEED_KMH = 20;

/**
 * Multiplier converting straight-line distance to plausible road distance
 * (the "circuity factor"). 1.3 is the commonly used value for dense street
 * grids; it stops short trips reading as impossibly fast.
 */
export const ROAD_CIRCUITY_FACTOR = 1.3;

/** Never promise less than this, even when the driver is essentially there. */
export const MIN_ETA_MINUTES = 1;

export interface EtaPoint {
  latitude: number;
  longitude: number;
}

/**
 * Estimated minutes to travel between two points.
 *
 * Returns null when either point is missing, so callers can render "—"
 * instead of a fabricated number — an ETA invented from no location data is
 * worse than none at all.
 */
export function estimateEtaMinutes(
  from: EtaPoint | null | undefined,
  to: EtaPoint | null | undefined,
  speedKmh: number = ASSUMED_AVERAGE_SPEED_KMH,
): number | null {
  if (!from || !to) return null;
  if (!Number.isFinite(speedKmh) || speedKmh <= 0) return null;

  const straightLineMeters = haversineDistanceMeters(from, to);
  if (!Number.isFinite(straightLineMeters)) return null;

  const roadMeters = straightLineMeters * ROAD_CIRCUITY_FACTOR;
  const metersPerMinute = (speedKmh * 1000) / 60;
  const minutes = roadMeters / metersPerMinute;

  return Math.max(MIN_ETA_MINUTES, Math.round(minutes));
}

/**
 * Formats an ETA for display. "about" is doing real work here: it signals an
 * estimate rather than a promise, which matters when the underlying figure is
 * a straight-line guess.
 */
export function formatEta(minutes: number | null): string {
  if (minutes === null) return "ETA unavailable";
  if (minutes < 60) return `about ${minutes} min`;

  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `about ${hours} hr` : `about ${hours} hr ${rest} min`;
}
