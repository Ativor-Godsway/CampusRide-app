import { prisma } from "../../db/prisma";
import type { PassengerStatus, RideStatus, RideType } from "@rida/shared";

let counter = 0;

export async function createTestUser(role: "RIDER" | "DRIVER" = "RIDER") {
  counter += 1;
  return prisma.user.create({
    data: {
      phone: `+233-2a-test-${Date.now()}-${counter}`,
      name: `Phase2a Test ${role} ${counter}`,
      role,
    },
  });
}

export async function getTestZones() {
  const zones = await prisma.zone.findMany({ take: 2 });
  if (zones.length < 2) {
    throw new Error("Seed zones (npm run db:seed) before running ride service tests");
  }
  return { pickup: zones[0]!, dropoff: zones[1]! };
}

/** Returns 3 distinct zones for tests that need a "distant" (non-adjacent) zone. */
export async function getThreeTestZones() {
  const zones = await prisma.zone.findMany({ take: 3 });
  if (zones.length < 3) {
    throw new Error("Seed zones (npm run db:seed) before running ride service tests");
  }
  return { pickup: zones[0]!, adjacent: zones[1]!, distant: zones[2]! };
}

export interface CreateTestDriverOptions {
  isOnline?: boolean;
  isApproved?: boolean;
  currentZoneId?: string | null;
}

/** Creates a DRIVER user plus its Driver profile row. */
export async function createTestDriver(opts: CreateTestDriverOptions = {}) {
  counter += 1;
  const user = await createTestUser("DRIVER");
  const driver = await prisma.driver.create({
    data: {
      userId: user.id,
      carMake: "Toyota",
      carModel: "Corolla",
      carColor: "Blue",
      plate: `GT-2a-${Date.now()}-${counter}`,
      photoUrl: "https://example.com/photo.jpg",
      isApproved: opts.isApproved ?? true,
      isOnline: opts.isOnline ?? true,
      currentZoneId: opts.currentZoneId ?? null,
    },
  });
  return { user, driver };
}

/**
 * Deletes a test driver and its underlying user. Tolerates the user already
 * having been removed by cleanupRide (e.g. after claimRide set it as the
 * ride's driverId).
 */
export async function cleanupDriver(userId: string) {
  await prisma.driver.deleteMany({ where: { userId } });
  await prisma.user.deleteMany({ where: { id: userId } });
}

/** Creates a one-way ZoneAdjacency row for eligibility tests. */
export async function createZoneAdjacency(zoneId: string, adjacentZoneId: string) {
  return prisma.zoneAdjacency.create({ data: { zoneId, adjacentZoneId } });
}

/** Deletes ZoneAdjacency rows by id. */
export async function cleanupZoneAdjacencies(ids: string[]) {
  if (ids.length === 0) return;
  await prisma.zoneAdjacency.deleteMany({ where: { id: { in: ids } } });
}

export interface CreateRidePassengerInput {
  riderId: string;
  status?: PassengerStatus;
  lockedFare?: number | null;
}

export interface CreateTestRideOptions {
  type: RideType;
  status?: RideStatus;
  occupancy?: number;
  driverId?: string | null;
  passengers?: CreateRidePassengerInput[];
  pickupZoneId?: string;
  dropoffZoneId?: string;
  broadcastStartedAt?: Date | null;
  decisionStartedAt?: Date | null;
  createdAt?: Date;
}

export async function createTestRide(opts: CreateTestRideOptions) {
  const { pickup, dropoff } = await getTestZones();
  const pickupZoneId = opts.pickupZoneId ?? pickup.id;
  const dropoffZoneId = opts.dropoffZoneId ?? dropoff.id;
  const rider = await createTestUser("RIDER");

  const ride = await prisma.ride.create({
    data: {
      riderId: rider.id,
      driverId: opts.driverId ?? null,
      type: opts.type,
      status: opts.status ?? "REQUESTED",
      pickupZoneId,
      dropoffZoneId,
      occupancy: opts.occupancy ?? 1,
      broadcastStartedAt: opts.broadcastStartedAt,
      decisionStartedAt: opts.decisionStartedAt,
      ...(opts.createdAt ? { createdAt: opts.createdAt } : {}),
      passengers: opts.passengers
        ? {
            create: opts.passengers.map((p) => ({
              riderId: p.riderId,
              pickupZoneId,
              dropoffZoneId,
              status: p.status ?? "WAITING",
              lockedFare: p.lockedFare ?? null,
            })),
          }
        : undefined,
    },
    include: { passengers: true },
  });

  return { ride, rider, pickup, dropoff };
}

/** Deletes a test ride (cascades to its passengers) and the users it referenced. */
export async function cleanupRide(rideId: string) {
  const ride = await prisma.ride.findUnique({
    where: { id: rideId },
    include: { passengers: true },
  });
  if (!ride) return;

  const userIds = new Set<string>([ride.riderId, ...ride.passengers.map((p) => p.riderId)]);
  if (ride.driverId) userIds.add(ride.driverId);

  await prisma.ride.delete({ where: { id: rideId } });
  await prisma.user.deleteMany({ where: { id: { in: Array.from(userIds) } } });
}
