/**
 * CampusRide best-fit driver designation (Phase 2e) — pure functions, no
 * side effects, no DB.
 *
 * This is the inverse of the rest of the ranking engine: instead of ranking
 * requests for one driver, it ranks eligible drivers for one request and
 * flags the top scorer(s) as `bestFit: true`.
 */

import type { ZoneAdjacency } from "../types/zone";

// ─── Config ──────────────────────────────────────────────────────────────────

/**
 * Proximity tiers are spaced (10/5/1/0) so the +1 route-alignment bonus can
 * only ever break ties between equally-proximate drivers — it can never let
 * a farther driver outrank a closer one. This is deliberate: on a small
 * campus, proximity dominates and route alignment is a tiebreaker only.
 */
export const BEST_FIT = {
  /** Driver is in the pickup zone (0 hops). */
  PROXIMITY_SAME_ZONE: 10,
  /** Driver is 1 hop from the pickup zone. */
  PROXIMITY_ADJACENT: 5,
  /** Driver is 2 hops from the pickup zone. */
  PROXIMITY_TWO_HOP: 1,
  /** Driver is more than 2 hops from the pickup zone (still eligible). */
  PROXIMITY_FAR: 0,
  /** Driver's current zone lies on the pickup -> dropoff adjacency path. Tiebreaker only. */
  ROUTE_ALIGNMENT_BONUS: 1,
} as const;

// ─── Graph helpers ────────────────────────────────────────────────────────────

function neighborsOf(zoneId: string, adjacency: readonly ZoneAdjacency[]): string[] {
  const neighbors: string[] = [];
  for (const adj of adjacency) {
    if (adj.zoneId === zoneId) neighbors.push(adj.adjacentZoneId);
    else if (adj.adjacentZoneId === zoneId) neighbors.push(adj.zoneId);
  }
  return neighbors;
}

/** True if `zoneAId` and `zoneBId` are directly adjacent (1 hop), via either direction of the adjacency edge. */
export function areAdjacent(
  zoneAId: string,
  zoneBId: string,
  adjacency: readonly ZoneAdjacency[],
): boolean {
  return hopDistance(zoneAId, zoneBId, adjacency, 1) === 1;
}

/**
 * BFS hop distance from `fromZoneId` to `toZoneId`, capped at `maxHops`
 * (default 2). Returns 0 for the same zone, 1 if directly adjacent, 2 if
 * adjacent-to-adjacent, etc., or `null` if no path within `maxHops`.
 */
export function hopDistance(
  fromZoneId: string,
  toZoneId: string,
  adjacency: readonly ZoneAdjacency[],
  maxHops = 2,
): number | null {
  if (fromZoneId === toZoneId) return 0;

  let frontier = new Set<string>([fromZoneId]);
  const visited = new Set<string>(frontier);

  for (let hop = 1; hop <= maxHops; hop++) {
    const next = new Set<string>();
    for (const zoneId of frontier) {
      for (const neighbor of neighborsOf(zoneId, adjacency)) {
        if (visited.has(neighbor)) continue;
        if (neighbor === toZoneId) return hop;
        visited.add(neighbor);
        next.add(neighbor);
      }
    }
    frontier = next;
  }

  return null;
}

/**
 * True if `zoneId` lies "between" `pickupZoneId` and `dropoffZoneId` in the
 * adjacency graph: either it IS one of the two endpoints, or it is directly
 * adjacent to both (a one-hop bridge connecting them). This is a simple
 * graph check, not real routing.
 */
export function isOnPath(
  zoneId: string,
  pickupZoneId: string,
  dropoffZoneId: string,
  adjacency: readonly ZoneAdjacency[],
): boolean {
  if (zoneId === pickupZoneId || zoneId === dropoffZoneId) return true;
  return (
    areAdjacent(zoneId, pickupZoneId, adjacency) && areAdjacent(zoneId, dropoffZoneId, adjacency)
  );
}

// ─── Best-fit designation ─────────────────────────────────────────────────────

export interface BestFitRequest {
  pickupZoneId: string;
  dropoffZoneId: string;
}

export interface BestFitDriver {
  /** Driver.userId — matches Ride.driverId per existing dispatch/claim code. */
  driverUserId: string;
  currentZoneId: string | null;
}

export interface BestFitResult {
  driverUserId: string;
  score: number;
  bestFit: boolean;
}

function proximityScore(hops: number | null): number {
  switch (hops) {
    case 0:
      return BEST_FIT.PROXIMITY_SAME_ZONE;
    case 1:
      return BEST_FIT.PROXIMITY_ADJACENT;
    case 2:
      return BEST_FIT.PROXIMITY_TWO_HOP;
    default:
      return BEST_FIT.PROXIMITY_FAR;
  }
}

/**
 * Scores each eligible driver for `request` and flags the top scorer(s) as
 * `bestFit: true`. Score = proximity (hop distance to pickup) + route
 * alignment bonus (driver's zone on the pickup -> dropoff path).
 *
 * - Assumes `eligibleDrivers` is already the filtered eligible set; this
 *   does not re-check eligibility.
 * - Guarantees at least one `bestFit: true` for any non-empty input
 *   (including a single driver, regardless of their absolute score).
 * - Pure: no DB, no Socket.io, no mutation of inputs.
 */
export function designateBestFit(
  request: BestFitRequest,
  eligibleDrivers: readonly BestFitDriver[],
  adjacency: readonly ZoneAdjacency[],
): BestFitResult[] {
  if (eligibleDrivers.length === 0) return [];

  const scored = eligibleDrivers.map((driver) => {
    const hops =
      driver.currentZoneId !== null
        ? hopDistance(driver.currentZoneId, request.pickupZoneId, adjacency)
        : null;
    const onPath =
      driver.currentZoneId !== null &&
      isOnPath(driver.currentZoneId, request.pickupZoneId, request.dropoffZoneId, adjacency);

    const score = proximityScore(hops) + (onPath ? BEST_FIT.ROUTE_ALIGNMENT_BONUS : 0);

    return { driverUserId: driver.driverUserId, score };
  });

  const maxScore = Math.max(...scored.map((s) => s.score));

  return scored.map((s) => ({ ...s, bestFit: s.score === maxScore }));
}
