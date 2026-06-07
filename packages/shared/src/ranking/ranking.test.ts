import { describe, it, expect } from "vitest";
import type { ZoneAdjacency } from "../types/zone";
import { RANKING, areCombinable, scoreRequest, type ScorableRequest } from "./ranking";

const ZONE_A = "zone-a";
const ZONE_B = "zone-b"; // adjacent to A
const ZONE_C = "zone-c"; // not adjacent to A or B
const ZONE_D = "zone-d"; // adjacent to A's dropoff partner

const ADJACENCY: ZoneAdjacency[] = [
  { id: "adj-1", zoneId: ZONE_A, adjacentZoneId: ZONE_B },
  { id: "adj-2", zoneId: ZONE_A, adjacentZoneId: ZONE_D },
];

const NOW = new Date("2026-01-01T00:00:00.000Z");

function makeRequest(overrides: Partial<ScorableRequest> & { pickupZoneId: string; dropoffZoneId: string }): ScorableRequest {
  return {
    createdAt: NOW,
    broadcastStartedAt: NOW,
    ...overrides,
  };
}

// ─── areCombinable ───────────────────────────────────────────────────────────

describe("areCombinable", () => {
  it("same pickup and dropoff zones -> true", () => {
    const a = { pickupZoneId: ZONE_A, dropoffZoneId: ZONE_C };
    const b = { pickupZoneId: ZONE_A, dropoffZoneId: ZONE_C };
    expect(areCombinable(a, b, ADJACENCY)).toBe(true);
  });

  it("adjacent pickup and adjacent dropoff -> true", () => {
    const a = { pickupZoneId: ZONE_A, dropoffZoneId: ZONE_A };
    const b = { pickupZoneId: ZONE_B, dropoffZoneId: ZONE_D };
    expect(areCombinable(a, b, ADJACENCY)).toBe(true);
  });

  it("non-adjacent pickup -> false even if dropoff matches", () => {
    const a = { pickupZoneId: ZONE_A, dropoffZoneId: ZONE_C };
    const b = { pickupZoneId: ZONE_C, dropoffZoneId: ZONE_C };
    expect(areCombinable(a, b, ADJACENCY)).toBe(false);
  });

  it("non-adjacent dropoff -> false even if pickup matches", () => {
    const a = { pickupZoneId: ZONE_A, dropoffZoneId: ZONE_A };
    const b = { pickupZoneId: ZONE_A, dropoffZoneId: ZONE_C };
    expect(areCombinable(a, b, ADJACENCY)).toBe(false);
  });
});

// ─── scoreRequest — proximity ────────────────────────────────────────────────

describe("scoreRequest — proximity", () => {
  it("same-zone request outranks adjacent-zone request when both just created", () => {
    const sameZone = makeRequest({ pickupZoneId: ZONE_A, dropoffZoneId: ZONE_C, broadcastStartedAt: NOW });
    const adjacentZone = makeRequest({ pickupZoneId: ZONE_B, dropoffZoneId: ZONE_C, broadcastStartedAt: NOW });

    const context = { kind: "proximity" as const, zoneId: ZONE_A, adjacency: ADJACENCY };

    const sameScore = scoreRequest(sameZone, context, NOW);
    const adjacentScore = scoreRequest(adjacentZone, context, NOW);

    expect(sameScore).toBe(RANKING.FIT_SAME_ZONE);
    expect(adjacentScore).toBe(RANKING.FIT_ADJACENT_ZONE);
    expect(sameScore).toBeGreaterThan(adjacentScore);
  });

  it("a non-combinable zone scores 0 fit (no boost) when fresh", () => {
    const farZone = makeRequest({ pickupZoneId: ZONE_C, dropoffZoneId: ZONE_C, broadcastStartedAt: NOW });
    const context = { kind: "proximity" as const, zoneId: ZONE_A, adjacency: ADJACENCY };
    expect(scoreRequest(farZone, context, NOW)).toBe(0);
  });
});

// ─── Anti-starvation ─────────────────────────────────────────────────────────

describe("scoreRequest — anti-starvation wait boost", () => {
  const context = { kind: "proximity" as const, zoneId: ZONE_A, adjacency: ADJACENCY };

  it("a long-waiting adjacent-zone request overtakes a fresh same-zone request", () => {
    const fitGap = RANKING.FIT_SAME_ZONE - RANKING.FIT_ADJACENT_ZONE; // 50
    const justOverGap = new Date(NOW.getTime() + (fitGap + 1) * 1000);

    const freshSameZone = makeRequest({ pickupZoneId: ZONE_A, dropoffZoneId: ZONE_C, broadcastStartedAt: justOverGap });
    const longWaitingAdjacent = makeRequest({ pickupZoneId: ZONE_B, dropoffZoneId: ZONE_C, broadcastStartedAt: NOW });

    const freshScore = scoreRequest(freshSameZone, context, justOverGap);
    const waitingScore = scoreRequest(longWaitingAdjacent, context, justOverGap);

    // Crossover: same-zone fit (100, no wait) is overtaken by adjacent-zone
    // fit (50) + (fitGap + 1)s of wait boost (51) = 101.
    expect(freshScore).toBe(RANKING.FIT_SAME_ZONE);
    expect(waitingScore).toBe(RANKING.FIT_ADJACENT_ZONE + fitGap + 1);
    expect(waitingScore).toBeGreaterThan(freshScore);
  });

  it("WAIT_BOOST_MAX caps the wait boost", () => {
    const wayLater = new Date(NOW.getTime() + (RANKING.WAIT_BOOST_MAX + 1000) * 1000);
    const longWaitingAdjacent = makeRequest({ pickupZoneId: ZONE_B, dropoffZoneId: ZONE_C, broadcastStartedAt: NOW });

    const score = scoreRequest(longWaitingAdjacent, context, wayLater);

    expect(score).toBe(RANKING.FIT_ADJACENT_ZONE + RANKING.WAIT_BOOST_MAX);
  });

  it("falls back to createdAt when broadcastStartedAt is null", () => {
    const req = makeRequest({
      pickupZoneId: ZONE_A,
      dropoffZoneId: ZONE_C,
      createdAt: NOW,
      broadcastStartedAt: null,
    });
    const tenSecondsLater = new Date(NOW.getTime() + 10_000);
    expect(scoreRequest(req, context, tenSecondsLater)).toBe(RANKING.FIT_SAME_ZONE + 10);
  });
});
