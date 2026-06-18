import { describe, it, expect, afterEach, afterAll } from "vitest";
import { prisma } from "../../db/prisma";
import { getSharedFarePerRider, getSharedTotalFare } from "@rida/shared";
import { claimRide } from "./dispatch";
import { joinSharedRide, applyPassengerTransition, applyRideTransition } from "./rideService";
import { suggestFillsForRide } from "./ranking";
import { addRiderToCar, departRide } from "./assembly";
import {
  NoSeatsAvailableError,
  NotRideOwnerError,
  RequestRideUnavailableError,
  RideNotFillableError,
  RideNotReadyToDepartError,
} from "./errors";
import {
  createTestRide,
  createTestDriver,
  createTestUser,
  cleanupRide,
  cleanupDriver,
  getTestZones,
  getThreeTestZones,
} from "./testFixtures";
import { collectionExternalRef } from "../payment/paymentFlow";

const createdRideIds: string[] = [];
const createdDriverUserIds: string[] = [];

afterEach(async () => {
  while (createdRideIds.length > 0) {
    await cleanupRide(createdRideIds.pop()!);
  }
  while (createdDriverUserIds.length > 0) {
    await cleanupDriver(createdDriverUserIds.pop()!);
  }
});

afterAll(async () => {
  await prisma.$disconnect();
});

// ─── End-to-end shared-car assembly ─────────────────────────────────────────

describe("Phase 2d — end-to-end shared-car assembly", () => {
  it("walks a car from a single rider through fills, a cancellation, a backfill, departure, and completion", async () => {
    const { pickup, dropoff } = await getTestZones();

    // This test merges rider B/C/D's RidePassenger rows onto rideA, which
    // creates cross-ride user references that the generic cleanupRide
    // helper (one ride at a time, in push order) can't unwind. Clean up
    // manually in a finally block: delete the anchor (rideA) first so its
    // cascade removes the merged RidePassenger rows, then the rest.
    const driver = await createTestDriver({ isOnline: true, isApproved: true, currentZoneId: pickup.id });

    // 1. Rider A requests SHARED (zone pickup -> dropoff). Ride enters REQUESTED.
    const { ride: rideA, rider: riderA } = await createTestRide({
      type: "SHARED",
      status: "REQUESTED",
      occupancy: 1,
      pickupZoneId: pickup.id,
      dropoffZoneId: dropoff.id,
    });

    const otherRideIds: string[] = [];
    const riderIds: string[] = [riderA.id];

    try {
    // 2. Driver claims A's ride -> MATCHED, then A boards as the first passenger.
    const claimed = await claimRide(prisma, rideA.id, driver.user.id);
    expect(claimed.status).toBe("MATCHED");

    const joinA = await joinSharedRide(prisma, rideA.id, {
      riderId: riderA.id,
      pickupZoneId: pickup.id,
      dropoffZoneId: dropoff.id,
    });
    expect(joinA.ride.occupancy).toBe(1);
    expect(joinA.passenger.lockedFare).toBe(getSharedFarePerRider(1)); // 1000

    // 3. Riders B and C each request SHARED in combinable (same) zones.
    const { ride: rideB, rider: riderB } = await createTestRide({
      type: "SHARED",
      status: "REQUESTED",
      occupancy: 1,
      pickupZoneId: pickup.id,
      dropoffZoneId: dropoff.id,
    });
    otherRideIds.push(rideB.id);
    riderIds.push(riderB.id);

    const { ride: rideC, rider: riderC } = await createTestRide({
      type: "SHARED",
      status: "REQUESTED",
      occupancy: 1,
      pickupZoneId: pickup.id,
      dropoffZoneId: dropoff.id,
    });
    otherRideIds.push(rideC.id);
    riderIds.push(riderC.id);

    // suggestFillsForRide (2c) surfaces both, ranked.
    let anchor = await prisma.ride.findUniqueOrThrow({
      where: { id: rideA.id },
      include: { passengers: true },
    });
    let suggestions = suggestFillsForRide(anchor, [rideB, rideC], [], new Date());
    expect(suggestions.map((r) => r.id).sort()).toEqual([rideB.id, rideC.id].sort());

    // 4. Driver adds B -> occupancy 2, A & B ratchet to 700 each.
    anchor = await addRiderToCar(prisma, driver.user.id, rideA.id, rideB.id);
    expect(anchor.occupancy).toBe(2);
    expect(anchor.passengers).toHaveLength(2);
    for (const p of anchor.passengers) {
      expect(p.lockedFare).toBe(getSharedFarePerRider(2)); // 700
    }

    const mergedB = await prisma.ride.findUniqueOrThrow({ where: { id: rideB.id } });
    expect(mergedB.status).toBe("CANCELLED");
    expect(mergedB.cancelReason).toBe("MERGED_INTO_ANOTHER_RIDE");
    expect(mergedB.mergedIntoRideId).toBe(rideA.id);

    // 5. Driver adds C -> occupancy 3, A/B/C ratchet to 600 each.
    anchor = await addRiderToCar(prisma, driver.user.id, rideA.id, rideC.id);
    expect(anchor.occupancy).toBe(3);
    expect(anchor.passengers).toHaveLength(3);
    for (const p of anchor.passengers) {
      expect(p.lockedFare).toBe(getSharedFarePerRider(3)); // 600
    }

    const mergedC = await prisma.ride.findUniqueOrThrow({ where: { id: rideC.id } });
    expect(mergedC.status).toBe("CANCELLED");
    expect(mergedC.cancelReason).toBe("MERGED_INTO_ANOTHER_RIDE");
    expect(mergedC.mergedIntoRideId).toBe(rideA.id);

    // 6. Rider B cancels before departure -> occupancy 2, A & C STAY at 600
    // (downward-only ratchet, no raise back to 700).
    const passengerB = anchor.passengers.find((p) => p.riderId === riderB.id)!;
    const cancelResult = await applyPassengerTransition(prisma, passengerB.id, "CANCELLED");
    expect(cancelResult.ride.occupancy).toBe(2);
    for (const p of cancelResult.ride.passengers) {
      if (p.id === passengerB.id) continue;
      expect(p.lockedFare).toBe(getSharedFarePerRider(3)); // still 600
    }

    // Driver sees the open seat: suggestFillsForRide again.
    anchor = await prisma.ride.findUniqueOrThrow({
      where: { id: rideA.id },
      include: { passengers: true },
    });
    expect(anchor.occupancy).toBe(2);

    const { ride: rideD, rider: riderD } = await createTestRide({
      type: "SHARED",
      status: "REQUESTED",
      occupancy: 1,
      pickupZoneId: pickup.id,
      dropoffZoneId: dropoff.id,
    });
    otherRideIds.push(rideD.id);
    riderIds.push(riderD.id);

    suggestions = suggestFillsForRide(anchor, [rideD], [], new Date());
    expect(suggestions.map((r) => r.id)).toEqual([rideD.id]);

    // 7. Driver adds D -> occupancy 3 again, D locks at 600, A & C remain 600.
    anchor = await addRiderToCar(prisma, driver.user.id, rideA.id, rideD.id);
    expect(anchor.occupancy).toBe(3);

    const activePassengers = anchor.passengers.filter((p) => p.status !== "CANCELLED");
    expect(activePassengers).toHaveLength(3);
    const activeRiderIds = activePassengers.map((p) => p.riderId).sort();
    expect(activeRiderIds).toEqual([riderA.id, riderC.id, riderD.id].sort());
    for (const p of activePassengers) {
      expect(p.lockedFare).toBe(getSharedFarePerRider(3)); // 600
    }

    // 8. Driver ARRIVED -> departRide -> IN_PROGRESS, fares frozen, occupancy
    // final = 3, departedAt stamped.
    await applyRideTransition(prisma, rideA.id, "ARRIVED");
    const departed = await departRide(prisma, driver.user.id, rideA.id);
    expect(departed.status).toBe("IN_PROGRESS");
    expect(departed.departedAt).not.toBeNull();
    expect(departed.occupancy).toBe(3);

    // Total of locked fares matches the pricing engine for the final occupancy.
    const finalPassengers = await prisma.ridePassenger.findMany({
      where: { rideId: rideA.id, status: { not: "CANCELLED" } },
    });
    const totalLocked = finalPassengers.reduce((sum, p) => sum + (p.lockedFare ?? 0), 0);
    expect(totalLocked).toBe(getSharedTotalFare(3)); // 1800

    // 9. Attempt addRiderToCar after departure -> rejected.
    const { ride: rideE, rider: riderE } = await createTestRide({
      type: "SHARED",
      status: "REQUESTED",
      occupancy: 1,
      pickupZoneId: pickup.id,
      dropoffZoneId: dropoff.id,
    });
    otherRideIds.push(rideE.id);
    riderIds.push(riderE.id);

    await expect(addRiderToCar(prisma, driver.user.id, rideA.id, rideE.id)).rejects.toThrow(
      RideNotFillableError,
    );

    // 10. Driver completes -> COMPLETED.
    const completed = await applyRideTransition(prisma, rideA.id, "COMPLETED");
    expect(completed.status).toBe("COMPLETED");
    expect(completed.completedAt).not.toBeNull();
    } finally {
      // rideA cascades its (merged) RidePassenger rows, releasing the
      // RidePassenger_riderId_fkey references to riderB/C/D before those
      // users are deleted.
      await prisma.ride.deleteMany({ where: { id: rideA.id } });
      await prisma.ride.deleteMany({ where: { id: { in: otherRideIds } } });
      await prisma.driver.deleteMany({ where: { userId: driver.user.id } });
      await prisma.user.deleteMany({ where: { id: { in: [...riderIds, driver.user.id] } } });
    }
  });
});

// ─── addRiderToCar — guard rails ────────────────────────────────────────────

describe("addRiderToCar — guard rails", () => {
  it("throws NotRideOwnerError when the calling driver does not own the anchor ride", async () => {
    const { pickup, dropoff } = await getTestZones();

    const owner = await createTestDriver({ isOnline: true, isApproved: true });
    createdDriverUserIds.push(owner.user.id);
    const intruder = await createTestDriver({ isOnline: true, isApproved: true });
    createdDriverUserIds.push(intruder.user.id);

    const { ride: anchor } = await createTestRide({
      type: "SHARED",
      status: "MATCHED",
      driverId: owner.user.id,
      occupancy: 0,
      passengers: [],
      pickupZoneId: pickup.id,
      dropoffZoneId: dropoff.id,
    });
    createdRideIds.push(anchor.id);

    const { ride: request } = await createTestRide({
      type: "SHARED",
      status: "REQUESTED",
      occupancy: 1,
      pickupZoneId: pickup.id,
      dropoffZoneId: dropoff.id,
    });
    createdRideIds.push(request.id);

    await expect(addRiderToCar(prisma, intruder.user.id, anchor.id, request.id)).rejects.toThrow(
      NotRideOwnerError,
    );
  });

  it("throws NoSeatsAvailableError when the anchor ride is already at occupancy 4", async () => {
    const { pickup, dropoff } = await getTestZones();

    const driver = await createTestDriver({ isOnline: true, isApproved: true });
    createdDriverUserIds.push(driver.user.id);

    const { ride: anchor } = await createTestRide({
      type: "SHARED",
      status: "MATCHED",
      driverId: driver.user.id,
      occupancy: 4,
      passengers: [],
      pickupZoneId: pickup.id,
      dropoffZoneId: dropoff.id,
    });
    createdRideIds.push(anchor.id);

    const { ride: request } = await createTestRide({
      type: "SHARED",
      status: "REQUESTED",
      occupancy: 1,
      pickupZoneId: pickup.id,
      dropoffZoneId: dropoff.id,
    });
    createdRideIds.push(request.id);

    await expect(addRiderToCar(prisma, driver.user.id, anchor.id, request.id)).rejects.toThrow(
      NoSeatsAvailableError,
    );
  });

  it("adds a request whose zones don't line up with the anchor's — compatibility is a sort hint, not a guardrail here", async () => {
    const { pickup, adjacent, distant } = await getThreeTestZones();
    void adjacent;

    const driver = await createTestDriver({ isOnline: true, isApproved: true });
    createdDriverUserIds.push(driver.user.id);

    // This test merges `rider`'s RidePassenger row onto the anchor, which —
    // same as the Phase 2d e2e test above — creates a cross-ride user
    // reference cleanupRide (one ride at a time) can't unwind via the shared
    // createdRideIds array. Clean up manually: delete the anchor first so
    // its cascade removes the merged RidePassenger row, then the request.
    const { ride: anchor, rider: anchorRider } = await createTestRide({
      type: "SHARED",
      status: "MATCHED",
      driverId: driver.user.id,
      occupancy: 0,
      passengers: [],
      pickupZoneId: pickup.id,
      dropoffZoneId: pickup.id,
    });

    // Far-away zones, no adjacency configured -> not combinable — but
    // addRiderToCar no longer rejects on this (product decision: a driver
    // may combine any pending request; compatibility is surfaced only as a
    // sort/badge hint in the fill-suggestions list, never enforced here).
    const { ride: request, rider } = await createTestRide({
      type: "SHARED",
      status: "REQUESTED",
      occupancy: 1,
      pickupZoneId: distant.id,
      dropoffZoneId: distant.id,
    });

    try {
      const updatedAnchor = await addRiderToCar(prisma, driver.user.id, anchor.id, request.id);

      expect(updatedAnchor.occupancy).toBe(1);
      expect(updatedAnchor.passengers).toHaveLength(1);
      expect(updatedAnchor.passengers[0]!.riderId).toBe(rider.id);

      const mergedRequest = await prisma.ride.findUniqueOrThrow({ where: { id: request.id } });
      expect(mergedRequest.status).toBe("CANCELLED");
      expect(mergedRequest.cancelReason).toBe("MERGED_INTO_ANOTHER_RIDE");
    } finally {
      await prisma.ride.delete({ where: { id: anchor.id } }).catch(() => undefined);
      await cleanupRide(request.id);
      await prisma.user.deleteMany({ where: { id: anchorRider.id } });
    }
  });

  it("throws RideNotFillableError for a REQUESTED (unclaimed) anchor ride", async () => {
    const { pickup, dropoff } = await getTestZones();

    const driver = await createTestDriver({ isOnline: true, isApproved: true });
    createdDriverUserIds.push(driver.user.id);

    // driverId is set directly (not via a normal claim) so the ownership
    // check passes and the status check (REQUESTED, not MATCHED/ARRIVED) is
    // what's actually exercised.
    const { ride: anchor } = await createTestRide({
      type: "SHARED",
      status: "REQUESTED",
      driverId: driver.user.id,
      occupancy: 1,
      pickupZoneId: pickup.id,
      dropoffZoneId: dropoff.id,
    });
    createdRideIds.push(anchor.id);

    const { ride: request } = await createTestRide({
      type: "SHARED",
      status: "REQUESTED",
      occupancy: 1,
      pickupZoneId: pickup.id,
      dropoffZoneId: dropoff.id,
    });
    createdRideIds.push(request.id);

    await expect(addRiderToCar(prisma, driver.user.id, anchor.id, request.id)).rejects.toThrow(
      RideNotFillableError,
    );
  });
});

// ─── Forced-error rollback ───────────────────────────────────────────────────

describe("addRiderToCar — forced-error rollback", () => {
  it("rolls back the request-ride absorb if joinSharedRideTx fails afterwards (no torn state)", async () => {
    const { pickup, dropoff } = await getTestZones();

    const driver = await createTestDriver({ isOnline: true, isApproved: true });
    createdDriverUserIds.push(driver.user.id);

    // Anchor is MATCHED with combinable zones but type LONE -- passes the
    // owner/status/seat/combinability checks, but joinSharedRideTx rejects
    // non-SHARED rides, throwing partway through the transaction.
    const { ride: anchor } = await createTestRide({
      type: "LONE",
      status: "MATCHED",
      driverId: driver.user.id,
      occupancy: 1,
      pickupZoneId: pickup.id,
      dropoffZoneId: dropoff.id,
    });
    createdRideIds.push(anchor.id);

    const { ride: request } = await createTestRide({
      type: "SHARED",
      status: "REQUESTED",
      occupancy: 1,
      pickupZoneId: pickup.id,
      dropoffZoneId: dropoff.id,
    });
    createdRideIds.push(request.id);

    await expect(addRiderToCar(prisma, driver.user.id, anchor.id, request.id)).rejects.toThrow();

    const reloaded = await prisma.ride.findUniqueOrThrow({ where: { id: request.id } });
    expect(reloaded.status).toBe("REQUESTED");
    expect(reloaded.driverId).toBeNull();
    expect(reloaded.cancelReason).toBeNull();
    expect(reloaded.mergedIntoRideId).toBeNull();
  });
});

// ─── departRide — guard rails ────────────────────────────────────────────────

describe("departRide — guard rails", () => {
  it("throws NotRideOwnerError when the calling driver does not own the ride", async () => {
    const { pickup, dropoff } = await getTestZones();

    const owner = await createTestDriver({ isOnline: true, isApproved: true });
    createdDriverUserIds.push(owner.user.id);
    const intruder = await createTestDriver({ isOnline: true, isApproved: true });
    createdDriverUserIds.push(intruder.user.id);

    const { ride } = await createTestRide({
      type: "SHARED",
      status: "ARRIVED",
      driverId: owner.user.id,
      occupancy: 1,
      pickupZoneId: pickup.id,
      dropoffZoneId: dropoff.id,
    });
    createdRideIds.push(ride.id);

    await expect(departRide(prisma, intruder.user.id, ride.id)).rejects.toThrow(NotRideOwnerError);
  });

  it("throws RideNotReadyToDepartError when the ride is not ARRIVED", async () => {
    const { pickup, dropoff } = await getTestZones();

    const driver = await createTestDriver({ isOnline: true, isApproved: true });
    createdDriverUserIds.push(driver.user.id);

    const { ride } = await createTestRide({
      type: "SHARED",
      status: "MATCHED",
      driverId: driver.user.id,
      occupancy: 1,
      pickupZoneId: pickup.id,
      dropoffZoneId: dropoff.id,
    });
    createdRideIds.push(ride.id);

    await expect(departRide(prisma, driver.user.id, ride.id)).rejects.toThrow(
      RideNotReadyToDepartError,
    );
  });
});

// ─── Phase 4c: departure initiates collections ──────────────────────────────

describe("departRide — payment collection wiring (Phase 4c)", () => {
  it("initiates a COLLECTION Payment for every active passenger, for their lockedFare, with the deterministic externalRef", async () => {
    const { pickup, dropoff } = await getTestZones();

    const driver = await createTestDriver({ isOnline: true, isApproved: true });
    createdDriverUserIds.push(driver.user.id);

    const riderB = await createTestUser("RIDER");
    const riderC = await createTestUser("RIDER");
    const riderD = await createTestUser("RIDER");

    const { ride } = await createTestRide({
      type: "SHARED",
      status: "ARRIVED",
      driverId: driver.user.id,
      occupancy: 3,
      pickupZoneId: pickup.id,
      dropoffZoneId: dropoff.id,
      passengers: [
        { riderId: riderB.id, status: "WAITING", lockedFare: 600 },
        { riderId: riderC.id, status: "WAITING", lockedFare: 600 },
        // A cancelled passenger must NOT get a collection initiated.
        { riderId: riderD.id, status: "CANCELLED", lockedFare: 600 },
      ],
    });
    createdRideIds.push(ride.id);

    const result = await departRide(prisma, driver.user.id, ride.id);
    expect(result.status).toBe("IN_PROGRESS");

    const payments = await prisma.payment.findMany({ where: { rideId: ride.id, type: "COLLECTION" } });
    expect(payments).toHaveLength(2);

    const byRider = new Map(payments.map((p) => [p.riderId, p]));
    for (const riderId of [riderB.id, riderC.id]) {
      const payment = byRider.get(riderId);
      expect(payment).toBeDefined();
      expect(payment!.amount).toBe(600);
      expect(payment!.providerRef).toBe(collectionExternalRef(ride.id, riderId));
      expect(payment!.status).toBe("PENDING");
    }

    // The cancelled passenger never gets a collection.
    expect(byRider.get(riderD.id)).toBeUndefined();
  });
});

// ─── Concurrency: two drivers absorbing the same request ride ───────────────

describe("addRiderToCar — concurrency", () => {
  it("exactly one of two concurrent drivers absorbs the same REQUESTED ride", async () => {
    const { pickup, dropoff } = await getTestZones();

    const driver1 = await createTestDriver({ isOnline: true, isApproved: true });
    createdDriverUserIds.push(driver1.user.id);
    const driver2 = await createTestDriver({ isOnline: true, isApproved: true });
    createdDriverUserIds.push(driver2.user.id);

    const { ride: anchor1, rider: anchor1Rider } = await createTestRide({
      type: "SHARED",
      status: "MATCHED",
      driverId: driver1.user.id,
      occupancy: 0,
      passengers: [],
      pickupZoneId: pickup.id,
      dropoffZoneId: dropoff.id,
    });

    const { ride: anchor2, rider: anchor2Rider } = await createTestRide({
      type: "SHARED",
      status: "MATCHED",
      driverId: driver2.user.id,
      occupancy: 0,
      passengers: [],
      pickupZoneId: pickup.id,
      dropoffZoneId: dropoff.id,
    });

    const { ride: request, rider: requestRider } = await createTestRide({
      type: "SHARED",
      status: "REQUESTED",
      occupancy: 1,
      pickupZoneId: pickup.id,
      dropoffZoneId: dropoff.id,
    });

    try {
      const results = await Promise.allSettled([
        addRiderToCar(prisma, driver1.user.id, anchor1.id, request.id),
        addRiderToCar(prisma, driver2.user.id, anchor2.id, request.id),
      ]);

      const fulfilled = results.filter((r) => r.status === "fulfilled");
      const rejected = results.filter((r) => r.status === "rejected");

      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(
        RequestRideUnavailableError,
      );

      const reloaded = await prisma.ride.findUniqueOrThrow({ where: { id: request.id } });
      expect(reloaded.status).toBe("CANCELLED");
      expect(reloaded.cancelReason).toBe("MERGED_INTO_ANOTHER_RIDE");
      expect([anchor1.id, anchor2.id]).toContain(reloaded.mergedIntoRideId);

      // The winning anchor cascades its merged RidePassenger row (which
      // references requestRider) before requestRider's user row is deleted.
      const winnerId = reloaded.mergedIntoRideId!;
      const loserId = winnerId === anchor1.id ? anchor2.id : anchor1.id;
      await prisma.ride.deleteMany({ where: { id: winnerId } });
      await prisma.ride.deleteMany({ where: { id: { in: [loserId, request.id] } } });
    } finally {
      await prisma.ride.deleteMany({ where: { id: { in: [anchor1.id, anchor2.id, request.id] } } });
      await prisma.driver.deleteMany({ where: { userId: { in: [driver1.user.id, driver2.user.id] } } });
      await prisma.user.deleteMany({
        where: {
          id: {
            in: [anchor1Rider.id, anchor2Rider.id, requestRider.id, driver1.user.id, driver2.user.id],
          },
        },
      });
    }
  });
});
