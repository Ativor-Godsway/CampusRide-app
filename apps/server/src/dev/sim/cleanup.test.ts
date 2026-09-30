/**
 * sim:cleanup must remove the simulator's riders and their trips — and
 * NEVER another account, not even one that shares the phone range or the
 * "Test " name, and not the real driver who carried the fake riders.
 */
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../../db/prisma";
import { createTestDriver, createTestUser, getTestZones } from "../../services/ride/testFixtures";
import { cleanupSimulatorData, SimCleanupEntangledError } from "./cleanup";
import { ensureSimRiders, isSimulatorPhone, simRiderPhone } from "./simAccounts";

const lookalikePhones = ["+233099900001", "+233099900002"];

async function removeLookalikes() {
  const users = await prisma.user.findMany({ where: { phone: { in: lookalikePhones } }, select: { id: true } });
  const ids = users.map((u) => u.id);
  await prisma.ridePassenger.deleteMany({ where: { riderId: { in: ids } } });
  await prisma.ride.deleteMany({ where: { riderId: { in: ids } } });
  await prisma.user.deleteMany({ where: { id: { in: ids } } });
}

beforeEach(async () => {
  await cleanupSimulatorData(prisma).catch(() => {});
  await removeLookalikes();
});
afterAll(async () => {
  await removeLookalikes();
});

async function rideFor(riderId: string, extra: { driverId?: string; status?: "COMPLETED" | "REQUESTED" } = {}) {
  const { pickup, dropoff } = await getTestZones();
  return prisma.ride.create({
    data: {
      riderId,
      driverId: extra.driverId ?? null,
      type: "SHARED",
      status: extra.status ?? "COMPLETED",
      pickupZoneId: pickup.id,
      dropoffZoneId: dropoff.id,
      passengers: { create: { riderId, pickupZoneId: pickup.id, dropoffZoneId: dropoff.id, lockedFare: 500 } },
    },
  });
}

describe("simulator account shape", () => {
  it("uses the reserved +233099 range with valid nine-digit numbers", () => {
    expect(simRiderPhone(0)).toBe("+233099000001");
    expect(isSimulatorPhone(simRiderPhone(19))).toBe(true);
    expect(isSimulatorPhone("+233241234567")).toBe(false);
    expect(isSimulatorPhone("+233000000001")).toBe(false); // the dev mock driver
  });
});

describe("cleanupSimulatorData", () => {
  it("removes simulator riders and their trips, and leaves every other account alone", async () => {
    const [ama, kofi] = await ensureSimRiders(prisma, 2);
    const realRider = await createTestUser("RIDER");
    const { user: realDriver } = await createTestDriver();
    // Same phone range, but not a simulator account (wrong name / wrong role).
    const lookalikeRider = await prisma.user.create({
      data: { phone: lookalikePhones[0]!, name: "Mock Check", role: "RIDER" },
    });
    const lookalikeDriver = await prisma.user.create({
      data: { phone: lookalikePhones[1]!, name: "Test Driver", role: "DRIVER" },
    });

    // A fake trip the real driver carried, with a rating each way and a ledger row.
    const fakeTrip = await rideFor(ama!.id, { driverId: realDriver.id });
    await prisma.rating.create({ data: { rideId: fakeTrip.id, raterId: ama!.id, rateeId: realDriver.id, stars: 5 } });
    await prisma.rating.create({ data: { rideId: fakeTrip.id, raterId: realDriver.id, rateeId: ama!.id, stars: 4 } });
    await prisma.commissionLedger.create({ data: { driverUserId: realDriver.id, rideId: fakeTrip.id, amountPesewas: 75 } });

    // A REAL rider's car that a fake rider was added to: only the fake seat goes.
    const realTrip = await rideFor(realRider.id, { driverId: realDriver.id });
    const { pickup, dropoff } = await getTestZones();
    await prisma.ridePassenger.create({
      data: { rideId: realTrip.id, riderId: kofi!.id, pickupZoneId: pickup.id, dropoffZoneId: dropoff.id, lockedFare: 500 },
    });
    const lookalikeTrip = await rideFor(lookalikeRider.id);

    const report = await cleanupSimulatorData(prisma);

    expect(report.accounts).toBe(2);
    expect(report.rides).toBe(1);
    expect(report.ratings).toBe(2);
    expect(report.ledgerRows).toBe(1);
    expect(await prisma.user.count({ where: { id: { in: [ama!.id, kofi!.id] } } })).toBe(0);
    expect(await prisma.ride.findUnique({ where: { id: fakeTrip.id } })).toBeNull();

    // Everyone else survives, with their trips.
    for (const id of [realRider.id, realDriver.id, lookalikeRider.id, lookalikeDriver.id]) {
      expect(await prisma.user.findUnique({ where: { id } }), id).not.toBeNull();
    }
    expect(await prisma.driver.count({ where: { userId: realDriver.id } })).toBe(1);
    expect(await prisma.ride.findUnique({ where: { id: realTrip.id } })).not.toBeNull();
    expect(await prisma.ride.findUnique({ where: { id: lookalikeTrip.id } })).not.toBeNull();
    const realSeats = await prisma.ridePassenger.findMany({ where: { rideId: realTrip.id } });
    expect(realSeats.map((s) => s.riderId)).toEqual([realRider.id]);
  });

  it("refuses, deleting nothing, when a real rider sits in a simulator rider's car", async () => {
    const [ama] = await ensureSimRiders(prisma, 1);
    const realRider = await createTestUser("RIDER");
    const trip = await rideFor(ama!.id);
    const { pickup, dropoff } = await getTestZones();
    await prisma.ridePassenger.create({
      data: { rideId: trip.id, riderId: realRider.id, pickupZoneId: pickup.id, dropoffZoneId: dropoff.id, lockedFare: 500 },
    });

    await expect(cleanupSimulatorData(prisma)).rejects.toBeInstanceOf(SimCleanupEntangledError);
    expect(await prisma.user.findUnique({ where: { id: ama!.id } })).not.toBeNull();
    expect(await prisma.ride.findUnique({ where: { id: trip.id } })).not.toBeNull();

    // Tidy up so later runs start clean.
    await prisma.ridePassenger.deleteMany({ where: { rideId: trip.id, riderId: realRider.id } });
  });

  it("is a no-op when there is nothing to remove", async () => {
    const report = await cleanupSimulatorData(prisma);
    expect(report.accounts).toBe(0);
  });
});
