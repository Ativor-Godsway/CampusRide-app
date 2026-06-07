import { describe, it, expect } from "vitest";
import type { ZoneAdjacency } from "@rida/shared";
import { RANKING } from "@rida/shared";
import {
  rankIsolatedRequests,
  detectClusters,
  suggestFillsForRide,
  type Ride,
  type RideWithPassengers,
} from "./ranking";

const NOW = new Date("2026-01-01T00:00:00.000Z");

let rideCounter = 0;

function makeRide(overrides: Partial<Ride> & Pick<Ride, "pickupZoneId" | "dropoffZoneId">): Ride {
  rideCounter += 1;
  return {
    id: `ride-${rideCounter}`,
    riderId: `rider-${rideCounter}`,
    driverId: null,
    type: "SHARED",
    status: "REQUESTED",
    occupancy: 1,
    fareTotal: null,
    driverShare: null,
    paymentStatus: "PENDING",
    cancelReason: null,
    createdAt: NOW,
    departedAt: null,
    completedAt: null,
    broadcastStartedAt: NOW,
    decisionStartedAt: null,
    ...overrides,
  } as Ride;
}

function makeRideWithPassengers(
  overrides: Partial<Ride> & Pick<Ride, "pickupZoneId" | "dropoffZoneId">,
  passengerRiderIds: string[],
): RideWithPassengers {
  const ride = makeRide(overrides);
  return {
    ...ride,
    passengers: passengerRiderIds.map((riderId, i) => ({
      id: `passenger-${i}-${ride.id}`,
      rideId: ride.id,
      riderId,
      pickupZoneId: ride.pickupZoneId,
      dropoffZoneId: ride.dropoffZoneId,
      fareCharged: null,
      lockedFare: null,
      status: "WAITING",
    })),
  } as unknown as RideWithPassengers;
}

// Zone layout:
//   Z1 -- Z2 -- Z3   (chain of adjacency, Z1-Z3 NOT directly adjacent)
//   ZD (a shared dropoff zone, isolated)
//   Z9 / ZD9 (unrelated, no adjacency to anything)
const Z1 = "zone-1";
const Z2 = "zone-2";
const Z3 = "zone-3";
const ZD = "zone-dropoff";
const Z9 = "zone-9";
const ZD9 = "zone-dropoff-9";

const ADJACENCY: ZoneAdjacency[] = [
  { id: "adj-1-2", zoneId: Z1, adjacentZoneId: Z2 },
  { id: "adj-2-3", zoneId: Z2, adjacentZoneId: Z3 },
];

// ─── rankIsolatedRequests ─────────────────────────────────────────────────────

describe("rankIsolatedRequests", () => {
  it("ranks same-zone above adjacent-zone (proximity to driver)", () => {
    const sameZone = makeRide({ pickupZoneId: Z1, dropoffZoneId: ZD, broadcastStartedAt: NOW });
    const adjacentZone = makeRide({ pickupZoneId: Z2, dropoffZoneId: ZD, broadcastStartedAt: NOW });

    const ranked = rankIsolatedRequests([adjacentZone, sameZone], Z1, ADJACENCY, NOW);

    expect(ranked.map((r) => r.id)).toEqual([sameZone.id, adjacentZone.id]);
  });

  it("excludes rides that are not REQUESTED or already claimed", () => {
    const requested = makeRide({ pickupZoneId: Z1, dropoffZoneId: ZD });
    const matched = makeRide({ pickupZoneId: Z1, dropoffZoneId: ZD, status: "MATCHED", driverId: "driver-1" });
    const cancelled = makeRide({ pickupZoneId: Z1, dropoffZoneId: ZD, status: "CANCELLED", cancelReason: "RIDER_CANCELLED" });

    const ranked = rankIsolatedRequests([requested, matched, cancelled], Z1, ADJACENCY, NOW);

    expect(ranked.map((r) => r.id)).toEqual([requested.id]);
  });
});

// ─── detectClusters ────────────────────────────────────────────────────────

describe("detectClusters", () => {
  it("groups 3 transitively-combinable SHARED requests into one cluster, excluding a far-away 4th", () => {
    // ride1 (Z1) and ride2 (Z2) are directly combinable (adjacent pickups, same dropoff).
    // ride2 (Z2) and ride3 (Z3) are directly combinable.
    // ride1 (Z1) and ride3 (Z3) are NOT directly combinable (Z1-Z3 not adjacent),
    // but end up in the same cluster transitively via ride2.
    const ride1 = makeRide({ pickupZoneId: Z1, dropoffZoneId: ZD });
    const ride2 = makeRide({ pickupZoneId: Z2, dropoffZoneId: ZD });
    const ride3 = makeRide({ pickupZoneId: Z3, dropoffZoneId: ZD });

    // Unrelated ride in a far zone with no adjacency to the cluster.
    const farRide = makeRide({ pickupZoneId: Z9, dropoffZoneId: ZD9 });

    const clusters = detectClusters([ride1, ride2, ride3, farRide], ADJACENCY, NOW);

    expect(clusters).toHaveLength(1);
    expect(clusters[0]!.rides.map((r) => r.id).sort()).toEqual(
      [ride1.id, ride2.id, ride3.id].sort(),
    );
    expect(clusters[0]!.headcount).toBe(3);
    expect(clusters[0]!.rides.find((r) => r.id === farRide.id)).toBeUndefined();
  });

  it("does not form a cluster from a single unmatched request (singletons fall through)", () => {
    const lonely = makeRide({ pickupZoneId: Z9, dropoffZoneId: ZD9 });
    const clusters = detectClusters([lonely], ADJACENCY, NOW);
    expect(clusters).toHaveLength(0);
  });

  it("ignores LONE rides and already-claimed/non-REQUESTED rides", () => {
    const ride1 = makeRide({ pickupZoneId: Z1, dropoffZoneId: ZD });
    const ride2 = makeRide({ pickupZoneId: Z1, dropoffZoneId: ZD });
    const lone = makeRide({ pickupZoneId: Z1, dropoffZoneId: ZD, type: "LONE" });
    const claimed = makeRide({ pickupZoneId: Z1, dropoffZoneId: ZD, status: "MATCHED", driverId: "driver-1" });

    const clusters = detectClusters([ride1, ride2, lone, claimed], ADJACENCY, NOW);

    expect(clusters).toHaveLength(1);
    expect(clusters[0]!.rides.map((r) => r.id).sort()).toEqual([ride1.id, ride2.id].sort());
  });
});

// ─── suggestFillsForRide ─────────────────────────────────────────────────────

describe("suggestFillsForRide", () => {
  it("suggests combinable pending requests, excludes non-combinable, over-capacity, and existing-passenger requests", () => {
    const anchor = makeRideWithPassengers(
      { pickupZoneId: Z1, dropoffZoneId: ZD, status: "MATCHED", driverId: "driver-1", occupancy: 2, type: "SHARED" },
      ["existing-rider-A", "existing-rider-B"],
    );

    const combinable = makeRide({ pickupZoneId: Z2, dropoffZoneId: ZD, occupancy: 2 });
    const nonCombinable = makeRide({ pickupZoneId: Z9, dropoffZoneId: ZD9, occupancy: 1 });
    const overCapacity = makeRide({ pickupZoneId: Z1, dropoffZoneId: ZD, occupancy: 3 });
    const existingPassengerRequest = makeRide({
      pickupZoneId: Z1,
      dropoffZoneId: ZD,
      occupancy: 1,
      riderId: "existing-rider-A",
    });

    const suggestions = suggestFillsForRide(
      anchor,
      [combinable, nonCombinable, overCapacity, existingPassengerRequest],
      ADJACENCY,
      NOW,
    );

    expect(suggestions.map((r) => r.id)).toEqual([combinable.id]);
  });

  it("returns nothing when the anchor ride is already at full occupancy", () => {
    const anchor = makeRideWithPassengers(
      { pickupZoneId: Z1, dropoffZoneId: ZD, status: "MATCHED", driverId: "driver-1", occupancy: 4, type: "SHARED" },
      ["r1", "r2", "r3", "r4"],
    );
    const candidate = makeRide({ pickupZoneId: Z1, dropoffZoneId: ZD, occupancy: 1 });

    expect(suggestFillsForRide(anchor, [candidate], ADJACENCY, NOW)).toEqual([]);
  });

  it("ranks suggestions best-first by score relative to the anchor", () => {
    const anchor = makeRideWithPassengers(
      { pickupZoneId: Z1, dropoffZoneId: ZD, status: "MATCHED", driverId: "driver-1", occupancy: 1, type: "SHARED" },
      ["existing-rider-A"],
    );

    // Same-zone (Z1/ZD) match -> higher fit than adjacent-zone (Z2/ZD) match.
    const sameZone = makeRide({ pickupZoneId: Z1, dropoffZoneId: ZD, occupancy: 1, broadcastStartedAt: NOW });
    const adjacentZone = makeRide({ pickupZoneId: Z2, dropoffZoneId: ZD, occupancy: 1, broadcastStartedAt: NOW });

    const suggestions = suggestFillsForRide(anchor, [adjacentZone, sameZone], ADJACENCY, NOW);

    expect(suggestions.map((r) => r.id)).toEqual([sameZone.id, adjacentZone.id]);
  });
});

// ─── No DB writes ────────────────────────────────────────────────────────────

describe("Phase 2c — read-only guarantee", () => {
  it("ranking functions return new arrays/objects and do not mutate their inputs", () => {
    const ride1 = makeRide({ pickupZoneId: Z1, dropoffZoneId: ZD });
    const ride2 = makeRide({ pickupZoneId: Z2, dropoffZoneId: ZD });
    const inputs = [ride2, ride1];
    const inputsCopy = JSON.parse(JSON.stringify(inputs));

    rankIsolatedRequests(inputs, Z1, ADJACENCY, NOW);
    detectClusters(inputs, ADJACENCY, NOW);

    expect(JSON.parse(JSON.stringify(inputs))).toEqual(inputsCopy);
  });

  it("RANKING weights are the named constants used throughout (no magic numbers)", () => {
    expect(RANKING.FIT_SAME_ZONE).toBe(100);
    expect(RANKING.FIT_ADJACENT_ZONE).toBe(50);
    expect(RANKING.WAIT_BOOST_PER_SEC).toBe(1);
    expect(RANKING.WAIT_BOOST_MAX).toBe(600);
  });
});
