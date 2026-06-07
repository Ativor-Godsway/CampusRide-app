import { describe, it, expect } from "vitest";
import type { ZoneAdjacency } from "../types/zone";
import {
  BEST_FIT,
  areAdjacent,
  hopDistance,
  isOnPath,
  designateBestFit,
  type BestFitDriver,
  type BestFitRequest,
} from "./bestFit";

// ─── Fixture zone graph ───────────────────────────────────────────────────────
//
//   ADJ2 -- PICKUP -- ADJ1 -- DROPOFF
//                       |
//                    TWOHOP1
//
//   FAR is disconnected from everything else.

const PICKUP = "zone-pickup";
const DROPOFF = "zone-dropoff";
const ADJ1 = "zone-adj1"; // 1 hop from pickup, also adjacent to dropoff -> on path
const ADJ2 = "zone-adj2"; // 1 hop from pickup, not adjacent to dropoff -> not on path
const TWOHOP1 = "zone-twohop1"; // 2 hops from pickup (via ADJ1)
const FAR = "zone-far"; // disconnected

const ADJACENCY: ZoneAdjacency[] = [
  { id: "adj-1", zoneId: PICKUP, adjacentZoneId: ADJ1 },
  { id: "adj-2", zoneId: PICKUP, adjacentZoneId: ADJ2 },
  { id: "adj-3", zoneId: ADJ1, adjacentZoneId: DROPOFF },
  { id: "adj-4", zoneId: ADJ1, adjacentZoneId: TWOHOP1 },
];

const REQUEST: BestFitRequest = { pickupZoneId: PICKUP, dropoffZoneId: DROPOFF };

function driver(driverUserId: string, currentZoneId: string | null): BestFitDriver {
  return { driverUserId, currentZoneId };
}

// ─── Graph helpers ─────────────────────────────────────────────────────────────

describe("areAdjacent", () => {
  it("true for directly adjacent zones (either direction)", () => {
    expect(areAdjacent(PICKUP, ADJ1, ADJACENCY)).toBe(true);
    expect(areAdjacent(ADJ1, PICKUP, ADJACENCY)).toBe(true);
  });

  it("false for the same zone", () => {
    expect(areAdjacent(PICKUP, PICKUP, ADJACENCY)).toBe(false);
  });

  it("false for zones two or more hops apart", () => {
    expect(areAdjacent(PICKUP, TWOHOP1, ADJACENCY)).toBe(false);
    expect(areAdjacent(PICKUP, FAR, ADJACENCY)).toBe(false);
  });
});

describe("hopDistance", () => {
  it("0 for the same zone", () => {
    expect(hopDistance(PICKUP, PICKUP, ADJACENCY)).toBe(0);
  });

  it("1 for directly adjacent zones", () => {
    expect(hopDistance(PICKUP, ADJ1, ADJACENCY)).toBe(1);
    expect(hopDistance(PICKUP, ADJ2, ADJACENCY)).toBe(1);
  });

  it("2 for adjacent-to-adjacent zones", () => {
    expect(hopDistance(PICKUP, TWOHOP1, ADJACENCY)).toBe(2);
    expect(hopDistance(PICKUP, DROPOFF, ADJACENCY)).toBe(2);
  });

  it("null when no path exists within maxHops", () => {
    expect(hopDistance(PICKUP, FAR, ADJACENCY)).toBeNull();
  });

  it("respects a custom maxHops cap", () => {
    expect(hopDistance(PICKUP, TWOHOP1, ADJACENCY, 1)).toBeNull();
  });
});

describe("isOnPath", () => {
  it("true for the pickup and dropoff zones themselves (endpoints)", () => {
    expect(isOnPath(PICKUP, PICKUP, DROPOFF, ADJACENCY)).toBe(true);
    expect(isOnPath(DROPOFF, PICKUP, DROPOFF, ADJACENCY)).toBe(true);
  });

  it("true for a zone adjacent to both pickup and dropoff (a bridge)", () => {
    expect(isOnPath(ADJ1, PICKUP, DROPOFF, ADJACENCY)).toBe(true);
  });

  it("false for a zone adjacent to pickup only", () => {
    expect(isOnPath(ADJ2, PICKUP, DROPOFF, ADJACENCY)).toBe(false);
  });

  it("false for a zone two hops away", () => {
    expect(isOnPath(TWOHOP1, PICKUP, DROPOFF, ADJACENCY)).toBe(false);
  });
});

// ─── designateBestFit ───────────────────────────────────────────────────────────

describe("designateBestFit", () => {
  it("same-zone driver outscores adjacent driver outscores two-hop driver", () => {
    const drivers = [driver("same", PICKUP), driver("adjacent", ADJ2), driver("twohop", TWOHOP1)];

    const result = designateBestFit(REQUEST, drivers, ADJACENCY);
    const byId = Object.fromEntries(result.map((r) => [r.driverUserId, r]));

    expect(byId.same!.score).toBeGreaterThan(byId.adjacent!.score);
    expect(byId.adjacent!.score).toBeGreaterThan(byId.twohop!.score);

    expect(byId.same!.bestFit).toBe(true);
    expect(byId.adjacent!.bestFit).toBe(false);
    expect(byId.twohop!.bestFit).toBe(false);
  });

  it("tie: two same-zone drivers both get bestFit: true", () => {
    const drivers = [driver("a", PICKUP), driver("b", PICKUP)];

    const result = designateBestFit(REQUEST, drivers, ADJACENCY);

    expect(result.find((r) => r.driverUserId === "a")!.bestFit).toBe(true);
    expect(result.find((r) => r.driverUserId === "b")!.bestFit).toBe(true);
    expect(result[0]!.score).toBe(result[1]!.score);
  });

  it("proximity-dominance: the route bonus can never let a farther driver outrank a closer one", () => {
    // Config-level property: spacing guarantees +1 can only break ties.
    expect(BEST_FIT.PROXIMITY_ADJACENT + BEST_FIT.ROUTE_ALIGNMENT_BONUS).toBeLessThan(
      BEST_FIT.PROXIMITY_SAME_ZONE,
    );
    expect(BEST_FIT.PROXIMITY_TWO_HOP + BEST_FIT.ROUTE_ALIGNMENT_BONUS).toBeLessThan(
      BEST_FIT.PROXIMITY_ADJACENT,
    );
    expect(BEST_FIT.PROXIMITY_FAR + BEST_FIT.ROUTE_ALIGNMENT_BONUS).toBeLessThanOrEqual(
      BEST_FIT.PROXIMITY_TWO_HOP,
    );

    // Concrete scenario: an adjacent driver ON the route (5 + 1 = 6) must
    // never outrank or tie a same-zone driver (10 + 1 = 11, since the
    // pickup zone is always on its own path).
    const onPathAdjacent = driver("on-path-adjacent", ADJ1);
    const sameZone = driver("same-zone", PICKUP);

    const result = designateBestFit(REQUEST, [onPathAdjacent, sameZone], ADJACENCY);
    const byId = Object.fromEntries(result.map((r) => [r.driverUserId, r]));

    expect(byId["on-path-adjacent"]!.score).toBe(
      BEST_FIT.PROXIMITY_ADJACENT + BEST_FIT.ROUTE_ALIGNMENT_BONUS,
    );
    expect(byId["same-zone"]!.score).toBeGreaterThan(byId["on-path-adjacent"]!.score);
    expect(byId["on-path-adjacent"]!.bestFit).toBe(false);
    expect(byId["same-zone"]!.bestFit).toBe(true);
  });

  it("route tiebreaker: of two equally-adjacent drivers, only the on-path one is best fit", () => {
    const onPath = driver("on-path", ADJ1); // adjacent to pickup AND dropoff
    const offPath = driver("off-path", ADJ2); // adjacent to pickup only

    const result = designateBestFit(REQUEST, [onPath, offPath], ADJACENCY);
    const byId = Object.fromEntries(result.map((r) => [r.driverUserId, r]));

    expect(byId["on-path"]!.score).toBe(BEST_FIT.PROXIMITY_ADJACENT + BEST_FIT.ROUTE_ALIGNMENT_BONUS);
    expect(byId["off-path"]!.score).toBe(BEST_FIT.PROXIMITY_ADJACENT);
    expect(byId["on-path"]!.bestFit).toBe(true);
    expect(byId["off-path"]!.bestFit).toBe(false);
  });

  it("single eligible driver is best fit regardless of score", () => {
    const result = designateBestFit(REQUEST, [driver("solo", FAR)], ADJACENCY);

    expect(result).toHaveLength(1);
    expect(result[0]!.score).toBe(BEST_FIT.PROXIMITY_FAR);
    expect(result[0]!.bestFit).toBe(true);
  });

  it("empty eligible set returns []", () => {
    expect(designateBestFit(REQUEST, [], ADJACENCY)).toEqual([]);
  });

  it("guarantee: every non-empty input yields at least one bestFit: true (including all-tied-at-zero)", () => {
    const drivers = [driver("a", FAR), driver("b", FAR), driver("c", null)];

    const result = designateBestFit(REQUEST, drivers, ADJACENCY);

    expect(result.every((r) => r.score === 0)).toBe(true);
    expect(result.filter((r) => r.bestFit).length).toBeGreaterThanOrEqual(1);
    expect(result.every((r) => r.bestFit)).toBe(true);
  });

  it("a driver with no currentZoneId is treated as far (score 0, no route bonus)", () => {
    const result = designateBestFit(REQUEST, [driver("no-zone", null)], ADJACENCY);

    expect(result[0]!.score).toBe(BEST_FIT.PROXIMITY_FAR);
    expect(result[0]!.bestFit).toBe(true);
  });

  it("does not mutate its inputs (pure function)", () => {
    const drivers = [driver("a", PICKUP), driver("b", ADJ2)];
    const driversCopy = JSON.parse(JSON.stringify(drivers));
    const adjacencyCopy = JSON.parse(JSON.stringify(ADJACENCY));

    designateBestFit(REQUEST, drivers, ADJACENCY);

    expect(drivers).toEqual(driversCopy);
    expect(ADJACENCY).toEqual(adjacencyCopy);
  });
});
