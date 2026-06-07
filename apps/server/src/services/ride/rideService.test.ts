import { describe, it, expect, afterEach, afterAll } from "vitest";
import { prisma } from "../../db/prisma";
import { InvalidTransitionError } from "./errors";
import {
  applyRideTransition,
  applyPassengerTransition,
  joinSharedRide,
} from "./rideService";
import { createTestRide, createTestUser, cleanupRide } from "./testFixtures";

const createdRideIds: string[] = [];

afterEach(async () => {
  while (createdRideIds.length > 0) {
    const id = createdRideIds.pop()!;
    await cleanupRide(id);
  }
});

afterAll(async () => {
  await prisma.$disconnect();
});

// ─── Ride transitions persist correctly ─────────────────────────────────────

describe("applyRideTransition — persistence", () => {
  it("REQUESTED -> MATCHED -> ARRIVED -> IN_PROGRESS -> COMPLETED, stamping departedAt/completedAt", async () => {
    const driver = await createTestUser("DRIVER");
    const { ride } = await createTestRide({ type: "LONE", status: "REQUESTED" });
    createdRideIds.push(ride.id);

    let updated = await applyRideTransition(prisma, ride.id, "MATCHED");
    expect(updated.status).toBe("MATCHED");

    updated = await applyRideTransition(prisma, ride.id, "ARRIVED");
    expect(updated.status).toBe("ARRIVED");

    updated = await applyRideTransition(prisma, ride.id, "IN_PROGRESS");
    expect(updated.status).toBe("IN_PROGRESS");
    expect(updated.departedAt).not.toBeNull();

    updated = await applyRideTransition(prisma, ride.id, "COMPLETED");
    expect(updated.status).toBe("COMPLETED");
    expect(updated.completedAt).not.toBeNull();

    // cleanup the extra driver user manually (not tracked by cleanupRide since
    // driverId was never set on this ride)
    await prisma.user.delete({ where: { id: driver.id } });
  });

  it("REQUESTED -> CANCELLED records cancelReason RIDER_CANCELLED", async () => {
    const { ride } = await createTestRide({ type: "LONE", status: "REQUESTED" });
    createdRideIds.push(ride.id);

    const updated = await applyRideTransition(prisma, ride.id, "CANCELLED", {
      cancelReason: "RIDER_CANCELLED",
    });

    expect(updated.status).toBe("CANCELLED");
    expect(updated.cancelReason).toBe("RIDER_CANCELLED");
  });

  it("REQUESTED -> CANCELLED records cancelReason NO_DRIVERS_AVAILABLE", async () => {
    const { ride } = await createTestRide({ type: "LONE", status: "REQUESTED" });
    createdRideIds.push(ride.id);

    const updated = await applyRideTransition(prisma, ride.id, "CANCELLED", {
      cancelReason: "NO_DRIVERS_AVAILABLE",
    });

    expect(updated.cancelReason).toBe("NO_DRIVERS_AVAILABLE");
  });

  it("MATCHED -> CANCELLED records cancelReason DRIVER_BACKED_OUT", async () => {
    const driver = await createTestUser("DRIVER");
    const { ride } = await createTestRide({
      type: "LONE",
      status: "MATCHED",
      driverId: driver.id,
    });
    createdRideIds.push(ride.id);

    const updated = await applyRideTransition(prisma, ride.id, "CANCELLED", {
      cancelReason: "DRIVER_BACKED_OUT",
    });

    expect(updated.status).toBe("CANCELLED");
    expect(updated.cancelReason).toBe("DRIVER_BACKED_OUT");
  });

  it("illegal transition throws InvalidTransitionError and writes nothing", async () => {
    const { ride } = await createTestRide({ type: "LONE", status: "REQUESTED" });
    createdRideIds.push(ride.id);

    await expect(
      applyRideTransition(prisma, ride.id, "IN_PROGRESS"),
    ).rejects.toThrow(InvalidTransitionError);

    const reloaded = await prisma.ride.findUniqueOrThrow({ where: { id: ride.id } });
    expect(reloaded.status).toBe("REQUESTED");
  });

  it("driver-backout MATCHED -> REQUESTED clears driverId and preserves passengers", async () => {
    const driver = await createTestUser("DRIVER");
    const passengerUser = await createTestUser("RIDER");
    const { ride } = await createTestRide({
      type: "SHARED",
      status: "MATCHED",
      driverId: driver.id,
      occupancy: 1,
      passengers: [{ riderId: passengerUser.id, status: "WAITING", lockedFare: 1000 }],
    });
    createdRideIds.push(ride.id);

    const updated = await applyRideTransition(prisma, ride.id, "REQUESTED");

    expect(updated.status).toBe("REQUESTED");
    expect(updated.driverId).toBeNull();

    const passengers = await prisma.ridePassenger.findMany({ where: { rideId: ride.id } });
    expect(passengers).toHaveLength(1);
    expect(passengers[0]!.status).toBe("WAITING");
    expect(passengers[0]!.lockedFare).toBe(1000);
  });
});

// ─── Passenger transitions + cascade ────────────────────────────────────────

describe("applyPassengerTransition — cascade rules", () => {
  it("one passenger cancelling with another remaining keeps the ride alive", async () => {
    const riderA = await createTestUser("RIDER");
    const riderB = await createTestUser("RIDER");
    const { ride } = await createTestRide({
      type: "SHARED",
      status: "MATCHED",
      occupancy: 2,
      passengers: [
        { riderId: riderA.id, status: "WAITING", lockedFare: 700 },
        { riderId: riderB.id, status: "WAITING", lockedFare: 700 },
      ],
    });
    createdRideIds.push(ride.id);

    const passengerA = ride.passengers.find((p) => p.riderId === riderA.id)!;
    const passengerB = ride.passengers.find((p) => p.riderId === riderB.id)!;

    const result = await applyPassengerTransition(prisma, passengerA.id, "CANCELLED");

    expect(result.passenger.status).toBe("CANCELLED");
    expect(result.ride.status).toBe("MATCHED"); // unchanged, still alive
    expect(result.ride.cancelReason).toBeNull();
    expect(result.ride.occupancy).toBe(1);

    const remaining = await prisma.ridePassenger.findUniqueOrThrow({
      where: { id: passengerB.id },
    });
    expect(remaining.status).toBe("WAITING");
    expect(remaining.lockedFare).toBe(700); // not raised
  });

  it("the last passenger cancelling cancels the ride with reason ALL_PASSENGERS_LEFT", async () => {
    const riderA = await createTestUser("RIDER");
    const { ride } = await createTestRide({
      type: "SHARED",
      status: "MATCHED",
      occupancy: 1,
      passengers: [{ riderId: riderA.id, status: "WAITING", lockedFare: 1000 }],
    });
    createdRideIds.push(ride.id);

    const passengerA = ride.passengers[0]!;

    const result = await applyPassengerTransition(prisma, passengerA.id, "CANCELLED");

    expect(result.passenger.status).toBe("CANCELLED");
    expect(result.ride.status).toBe("CANCELLED");
    expect(result.ride.cancelReason).toBe("ALL_PASSENGERS_LEFT");
    expect(result.ride.occupancy).toBe(0);
  });

  it("WAITING -> PICKED_UP -> DROPPED_OFF succeeds and PICKED_UP -> CANCELLED is illegal", async () => {
    const riderA = await createTestUser("RIDER");
    const { ride } = await createTestRide({
      type: "LONE",
      status: "IN_PROGRESS",
      occupancy: 1,
      passengers: [{ riderId: riderA.id, status: "WAITING", lockedFare: 1500 }],
    });
    createdRideIds.push(ride.id);

    const passengerA = ride.passengers[0]!;

    const pickedUp = await applyPassengerTransition(prisma, passengerA.id, "PICKED_UP");
    expect(pickedUp.passenger.status).toBe("PICKED_UP");

    await expect(
      applyPassengerTransition(prisma, passengerA.id, "CANCELLED"),
    ).rejects.toThrow(InvalidTransitionError);

    const droppedOff = await applyPassengerTransition(prisma, passengerA.id, "DROPPED_OFF");
    expect(droppedOff.passenger.status).toBe("DROPPED_OFF");
  });
});

// ─── Price-lock join sequence ───────────────────────────────────────────────

describe("joinSharedRide — price-lock ratchet", () => {
  it("1 -> 2 -> 3 ratchets fares 1000 -> 700 -> 600; cancel 3 -> 2 leaves remaining at 600", async () => {
    const riderA = await createTestUser("RIDER");
    const riderB = await createTestUser("RIDER");
    const riderC = await createTestUser("RIDER");
    const riderD = await createTestUser("RIDER");

    const { ride } = await createTestRide({
      type: "SHARED",
      status: "REQUESTED",
      occupancy: 0,
      passengers: [],
    });
    createdRideIds.push(ride.id);

    // A joins -> occupancy 1 -> 1000
    const joinA = await joinSharedRide(prisma, ride.id, {
      riderId: riderA.id,
      pickupZoneId: ride.pickupZoneId,
      dropoffZoneId: ride.dropoffZoneId,
    });
    expect(joinA.passenger.lockedFare).toBe(1000);
    expect(joinA.ride.occupancy).toBe(1);

    // B joins -> occupancy 2 -> both ratchet to 700
    const joinB = await joinSharedRide(prisma, ride.id, {
      riderId: riderB.id,
      pickupZoneId: ride.pickupZoneId,
      dropoffZoneId: ride.dropoffZoneId,
    });
    expect(joinB.passenger.lockedFare).toBe(700);
    expect(joinB.ride.occupancy).toBe(2);

    let passengerA = await prisma.ridePassenger.findUniqueOrThrow({ where: { id: joinA.passenger.id } });
    expect(passengerA.lockedFare).toBe(700);

    // C joins -> occupancy 3 -> all ratchet to 600
    const joinC = await joinSharedRide(prisma, ride.id, {
      riderId: riderC.id,
      pickupZoneId: ride.pickupZoneId,
      dropoffZoneId: ride.dropoffZoneId,
    });
    expect(joinC.passenger.lockedFare).toBe(600);
    expect(joinC.ride.occupancy).toBe(3);

    passengerA = await prisma.ridePassenger.findUniqueOrThrow({ where: { id: joinA.passenger.id } });
    let passengerB = await prisma.ridePassenger.findUniqueOrThrow({ where: { id: joinB.passenger.id } });
    expect(passengerA.lockedFare).toBe(600);
    expect(passengerB.lockedFare).toBe(600);

    // C cancels -> occupancy 2 -> A and B remain at 600 (NOT raised back to 700)
    const cancelC = await applyPassengerTransition(prisma, joinC.passenger.id, "CANCELLED");
    expect(cancelC.ride.occupancy).toBe(2);

    passengerA = await prisma.ridePassenger.findUniqueOrThrow({ where: { id: joinA.passenger.id } });
    passengerB = await prisma.ridePassenger.findUniqueOrThrow({ where: { id: joinB.passenger.id } });
    expect(passengerA.lockedFare).toBe(600);
    expect(passengerB.lockedFare).toBe(600);

    // Re-fill: D joins -> occupancy 2 -> 3 again -> new joiner locks at 600,
    // existing A and B remain at 600 (already at the floor for occupancy 3).
    const joinD = await joinSharedRide(prisma, ride.id, {
      riderId: riderD.id,
      pickupZoneId: ride.pickupZoneId,
      dropoffZoneId: ride.dropoffZoneId,
    });
    expect(joinD.passenger.lockedFare).toBe(600);
    expect(joinD.ride.occupancy).toBe(3);

    passengerA = await prisma.ridePassenger.findUniqueOrThrow({ where: { id: joinA.passenger.id } });
    passengerB = await prisma.ridePassenger.findUniqueOrThrow({ where: { id: joinB.passenger.id } });
    expect(passengerA.lockedFare).toBe(600);
    expect(passengerB.lockedFare).toBe(600);
  });

  it("departure (ARRIVED -> IN_PROGRESS) freezes lockedFares permanently", async () => {
    const riderA = await createTestUser("RIDER");
    const riderB = await createTestUser("RIDER");
    const driver = await createTestUser("DRIVER");

    const { ride } = await createTestRide({
      type: "SHARED",
      status: "ARRIVED",
      driverId: driver.id,
      occupancy: 2,
      passengers: [
        { riderId: riderA.id, status: "WAITING", lockedFare: 700 },
        { riderId: riderB.id, status: "WAITING", lockedFare: 700 },
      ],
    });
    createdRideIds.push(ride.id);

    const updated = await applyRideTransition(prisma, ride.id, "IN_PROGRESS");
    expect(updated.status).toBe("IN_PROGRESS");
    expect(updated.departedAt).not.toBeNull();

    const passengers = await prisma.ridePassenger.findMany({ where: { rideId: ride.id } });
    for (const p of passengers) {
      expect(p.lockedFare).toBe(700); // unchanged / frozen
    }
  });

  it("joining a full (occupancy 4) SHARED ride throws InvalidOccupancyError", async () => {
    const riders = [];
    for (let i = 0; i < 5; i++) {
      riders.push(await createTestUser("RIDER"));
    }
    const { ride } = await createTestRide({
      type: "SHARED",
      status: "REQUESTED",
      occupancy: 4,
      passengers: riders.slice(0, 4).map((r) => ({ riderId: r.id, status: "WAITING", lockedFare: 500 })),
    });
    createdRideIds.push(ride.id);

    await expect(
      joinSharedRide(prisma, ride.id, {
        riderId: riders[4]!.id,
        pickupZoneId: ride.pickupZoneId,
        dropoffZoneId: ride.dropoffZoneId,
      }),
    ).rejects.toThrow();

    const passengers = await prisma.ridePassenger.findMany({ where: { rideId: ride.id } });
    expect(passengers).toHaveLength(4);
  });
});

// ─── Transactionality ────────────────────────────────────────────────────────

describe("applyPassengerTransition — transactionality", () => {
  it("a forced mid-step error (cancelling the last passenger of a COMPLETED ride) leaves no partial state", async () => {
    const riderA = await createTestUser("RIDER");
    const { ride } = await createTestRide({
      type: "LONE",
      status: "COMPLETED",
      occupancy: 1,
      passengers: [{ riderId: riderA.id, status: "WAITING", lockedFare: 1500 }],
    });
    createdRideIds.push(ride.id);

    const passengerA = ride.passengers[0]!;

    // The passenger transition WAITING -> CANCELLED is itself legal, but the
    // cascade (last passenger -> cancel ride) hits transitionRide(COMPLETED, CANCELLED),
    // which is illegal and throws — the whole transaction must roll back.
    await expect(
      applyPassengerTransition(prisma, passengerA.id, "CANCELLED"),
    ).rejects.toThrow(InvalidTransitionError);

    const reloadedPassenger = await prisma.ridePassenger.findUniqueOrThrow({
      where: { id: passengerA.id },
    });
    const reloadedRide = await prisma.ride.findUniqueOrThrow({ where: { id: ride.id } });

    expect(reloadedPassenger.status).toBe("WAITING"); // not persisted
    expect(reloadedRide.status).toBe("COMPLETED"); // unchanged
    expect(reloadedRide.occupancy).toBe(1); // unchanged
  });
});
