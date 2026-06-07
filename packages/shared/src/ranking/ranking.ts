/**
 * CampusRide ranking/scoring engine — pure functions, no side effects, no DB.
 *
 * "Combinable" and "score" are zone-heuristic only (no real routing/maps):
 * two requests are combinable if their pickup zones are the same-or-adjacent
 * AND their dropoff zones are the same-or-adjacent. A human driver is the
 * final filter, so the net is intentionally wide.
 */

import type { ZoneAdjacency } from "../types/zone";

// ─── Config ──────────────────────────────────────────────────────────────────

export const RANKING = {
  /** Pickup/dropoff zone matches the reference (driver zone or anchor ride) exactly. */
  FIT_SAME_ZONE: 100,
  /** Pickup/dropoff zone is adjacent (via ZoneAdjacency) to the reference. */
  FIT_ADJACENT_ZONE: 50,
  /** Anti-starvation: score added per second a request has been waiting. */
  WAIT_BOOST_PER_SEC: 1,
  /** Cap on the wait boost so a long wait can't infinitely dominate fit. */
  WAIT_BOOST_MAX: 600,
} as const;

// ─── Zone heuristics ──────────────────────────────────────────────────────────

export interface ZonePair {
  pickupZoneId: string;
  dropoffZoneId: string;
}

function areZonesAdjacent(
  a: string,
  b: string,
  adjacency: readonly ZoneAdjacency[],
): boolean {
  return adjacency.some(
    (adj) =>
      (adj.zoneId === a && adj.adjacentZoneId === b) ||
      (adj.zoneId === b && adj.adjacentZoneId === a),
  );
}

function isSameOrAdjacent(
  a: string,
  b: string,
  adjacency: readonly ZoneAdjacency[],
): boolean {
  return a === b || areZonesAdjacent(a, b, adjacency);
}

/** FIT_SAME_ZONE if the zones match exactly, FIT_ADJACENT_ZONE if adjacent, else 0. */
function computeFitScore(
  a: string,
  b: string,
  adjacency: readonly ZoneAdjacency[],
): number {
  if (a === b) return RANKING.FIT_SAME_ZONE;
  if (areZonesAdjacent(a, b, adjacency)) return RANKING.FIT_ADJACENT_ZONE;
  return 0;
}

/**
 * Two requests are combinable if pickup zones are same-or-adjacent AND
 * dropoff zones are same-or-adjacent.
 */
export function areCombinable(
  a: ZonePair,
  b: ZonePair,
  adjacency: readonly ZoneAdjacency[],
): boolean {
  return (
    isSameOrAdjacent(a.pickupZoneId, b.pickupZoneId, adjacency) &&
    isSameOrAdjacent(a.dropoffZoneId, b.dropoffZoneId, adjacency)
  );
}

// ─── Scoring ──────────────────────────────────────────────────────────────────

export interface ScorableRequest extends ZonePair {
  createdAt: Date;
  /** Stamped when the ride enters REQUESTED/broadcast (Phase 2b); falls back to createdAt. */
  broadcastStartedAt: Date | null;
}

/**
 * The reference a request's "fit" is scored against:
 * - "proximity": a driver's current zone (Moment proximity ranking).
 * - "anchor": another ride's pickup/dropoff zones (fill-the-car).
 */
export type RankingContext =
  | { kind: "proximity"; zoneId: string; adjacency: readonly ZoneAdjacency[] }
  | { kind: "anchor"; ride: ZonePair; adjacency: readonly ZoneAdjacency[] };

/**
 * Score = fit component + min(secondsWaited * WAIT_BOOST_PER_SEC, WAIT_BOOST_MAX).
 * Higher ranks first. Exact-zone fit outranks adjacent fit, but a
 * long-waiting adjacent request can eventually overtake a fresh exact-zone
 * one (anti-starvation).
 *
 * - "proximity": fit is based on the request's pickup zone vs. the driver's zone.
 * - "anchor": fit is the weaker of the pickup-fit and dropoff-fit vs. the
 *   anchor ride's zones (both ends must line up for a real combine).
 */
export function scoreRequest(
  request: ScorableRequest,
  context: RankingContext,
  now: Date,
): number {
  let fit: number;
  if (context.kind === "proximity") {
    fit = computeFitScore(request.pickupZoneId, context.zoneId, context.adjacency);
  } else {
    const pickupFit = computeFitScore(
      request.pickupZoneId,
      context.ride.pickupZoneId,
      context.adjacency,
    );
    const dropoffFit = computeFitScore(
      request.dropoffZoneId,
      context.ride.dropoffZoneId,
      context.adjacency,
    );
    fit = Math.min(pickupFit, dropoffFit);
  }

  const waitStart = request.broadcastStartedAt ?? request.createdAt;
  const secondsWaited = Math.max(0, (now.getTime() - waitStart.getTime()) / 1000);
  const waitBoost = Math.min(secondsWaited * RANKING.WAIT_BOOST_PER_SEC, RANKING.WAIT_BOOST_MAX);

  return fit + waitBoost;
}
