import type { Prisma } from "@prisma/client";
import type { ZoneAdjacency } from "@rida/shared";
import { RANKING, areCombinable, scoreRequest, BEST_FIT, designateBestFit } from "@rida/shared";
import type { BestFitDriver, BestFitRequest, BestFitResult } from "@rida/shared";

/**
 * READ-ONLY ranking/scoring (Phase 2c). Nothing in this file writes to the
 * DB — all functions are pure over the arrays passed in. Computed fresh on
 * every call; never cache or persist a rank.
 */

export type Ride = Prisma.RideGetPayload<Record<string, never>>;
export type RideWithPassengers = Prisma.RideGetPayload<{ include: { passengers: true } }>;

const PRICING_MAX_SHARED_OCCUPANCY = 4;

// ─── Moment: proximity ranking for isolated requests ────────────────────────

/**
 * Ranks unclaimed REQUESTED rides by proximity to a driver's current zone,
 * using `scoreRequest` (exact-zone fit > adjacent-zone fit, with anti-
 * starvation wait boost). Best-first.
 */
export function rankIsolatedRequests(
  requests: readonly Ride[],
  driverZone: string,
  adjacency: readonly ZoneAdjacency[],
  now: Date,
): Ride[] {
  return requests
    .filter((r) => r.status === "REQUESTED" && r.driverId === null)
    .map((r) => ({
      ride: r,
      score: scoreRequest(r, { kind: "proximity", zoneId: driverZone, adjacency }, now),
    }))
    .sort((a, b) => b.score - a.score)
    .map(({ ride }) => ride);
}

// ─── Moment 1: cluster detection ────────────────────────────────────────────

export interface Cluster {
  rides: Ride[];
  /** Representative pickup/dropoff zone for the cluster (the first member's). */
  pickupZoneId: string;
  dropoffZoneId: string;
  /** Total active occupancy across all member rides. */
  headcount: number;
  /** Sum of each member's score (relative to the cluster's first ride). */
  score: number;
}

/**
 * Groups unclaimed REQUESTED SHARED rides into transitively-combinable
 * clusters (pickup zones same-or-adjacent AND dropoff zones same-or-adjacent,
 * chained transitively). Only groups of >= 2 are returned as clusters —
 * singletons fall through to `rankIsolatedRequests`. Sorted best-first by
 * cluster score.
 */
export function detectClusters(
  requests: readonly Ride[],
  adjacency: readonly ZoneAdjacency[],
  now: Date,
): Cluster[] {
  const candidates = requests.filter(
    (r) => r.status === "REQUESTED" && r.driverId === null && r.type === "SHARED",
  );

  // Union-find over candidate indices.
  const parent = candidates.map((_, i) => i);
  function find(i: number): number {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]!]!;
      i = parent[i]!;
    }
    return i;
  }
  function union(a: number, b: number): void {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[ra] = rb;
  }

  for (let i = 0; i < candidates.length; i++) {
    for (let j = i + 1; j < candidates.length; j++) {
      if (areCombinable(candidates[i]!, candidates[j]!, adjacency)) {
        union(i, j);
      }
    }
  }

  const groups = new Map<number, Ride[]>();
  for (let i = 0; i < candidates.length; i++) {
    const root = find(i);
    const group = groups.get(root) ?? [];
    group.push(candidates[i]!);
    groups.set(root, group);
  }

  const clusters: Cluster[] = [];
  for (const rides of groups.values()) {
    if (rides.length < 2) continue;

    const anchor = rides[0]!;
    const score = rides.reduce(
      (sum, r) =>
        sum + scoreRequest(r, { kind: "anchor", ride: anchor, adjacency }, now),
      0,
    );

    clusters.push({
      rides,
      pickupZoneId: anchor.pickupZoneId,
      dropoffZoneId: anchor.dropoffZoneId,
      headcount: rides.reduce((sum, r) => sum + r.occupancy, 0),
      score,
    });
  }

  return clusters.sort((a, b) => b.score - a.score);
}

// ─── Moment 2: fill-the-car ──────────────────────────────────────────────────

/**
 * For a driver's claimed-but-not-departed SHARED ride (`anchorRide`) with
 * free seats, returns combinable pending requests ranked best-first that
 * could be added — without making any change. Excludes:
 * - candidates that aren't REQUESTED/unclaimed SHARED requests,
 * - candidates not combinable with the anchor's pickup/dropoff zones,
 * - candidates whose riders are already passengers on the anchor,
 * - candidates that would push the anchor's occupancy past 4.
 */
export function suggestFillsForRide(
  anchorRide: RideWithPassengers,
  candidateRequests: readonly Ride[],
  adjacency: readonly ZoneAdjacency[],
  now: Date,
): Ride[] {
  const existingRiderIds = new Set(anchorRide.passengers.map((p) => p.riderId));
  const freeSeats = PRICING_MAX_SHARED_OCCUPANCY - anchorRide.occupancy;
  if (freeSeats <= 0) return [];

  return candidateRequests
    .filter(
      (r) =>
        r.id !== anchorRide.id &&
        r.status === "REQUESTED" &&
        r.driverId === null &&
        r.type === "SHARED" &&
        !existingRiderIds.has(r.riderId) &&
        r.occupancy <= freeSeats &&
        areCombinable(r, anchorRide, adjacency),
    )
    .map((r) => ({
      ride: r,
      score: scoreRequest(r, { kind: "anchor", ride: anchorRide, adjacency }, now),
    }))
    .sort((a, b) => b.score - a.score)
    .map(({ ride }) => ride);
}

// re-export for convenience so callers of this module don't need a second
// import from @rida/shared just for the constants/predicates.
export { RANKING, areCombinable, scoreRequest, BEST_FIT, designateBestFit };
export type { BestFitDriver, BestFitRequest, BestFitResult };
