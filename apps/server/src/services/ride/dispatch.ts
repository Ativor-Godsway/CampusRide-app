import type { PrismaClient } from "@prisma/client";
import { getLoneFare, getSharedFarePerRider, splitFare } from "@rida/shared";
import { emitDriverBroadcast } from "../../realtime/rideSocket";
import { DriverHasActiveRideError, RideAlreadyClaimedError } from "./errors";
import { ACTIVE_DRIVER_STATUSES } from "./stateMachine";

/**
 * Returns the candidate set of drivers who could be dispatched a ride:
 * online + approved drivers currently in the ride's pickup zone or a zone
 * adjacent to it. This is the candidate set only — ranking/"perfect match"
 * ordering of these candidates is Phase 2c, not handled here.
 */
export async function getEligibleDrivers(
  prisma: PrismaClient,
  ride: { pickupZoneId: string },
) {
  const adjacencies = await prisma.zoneAdjacency.findMany({
    where: {
      OR: [{ zoneId: ride.pickupZoneId }, { adjacentZoneId: ride.pickupZoneId }],
    },
  });

  const zoneIds = new Set<string>([ride.pickupZoneId]);
  for (const adj of adjacencies) {
    zoneIds.add(adj.zoneId);
    zoneIds.add(adj.adjacentZoneId);
  }

  return prisma.driver.findMany({
    where: {
      isOnline: true,
      isApproved: true,
      currentZoneId: { in: Array.from(zoneIds) },
    },
  });
}

/**
 * Computes the eligible-driver set for a ride, builds the broadcast payload,
 * and emits ride:broadcast to each eligible driver's personal socket room.
 * Does not change ride state — call this after a ride enters (or re-enters)
 * REQUESTED.
 */
export async function broadcastRide(prisma: PrismaClient, rideId: string) {
  const ride = await prisma.ride.findUniqueOrThrow({
    where: { id: rideId },
    include: { pickupZone: true, dropoffZone: true },
  });
  const eligible = await getEligibleDrivers(prisma, ride);

  if (eligible.length > 0) {
    const farePesewas =
      ride.type === "LONE" ? getLoneFare() : getSharedFarePerRider(ride.occupancy);
    const { driverShare } = splitFare(farePesewas);
    const expiresAt = (ride.broadcastStartedAt?.getTime() ?? Date.now()) + 90_000;

    emitDriverBroadcast(
      eligible.map((d) => d.userId),
      {
        rideId: ride.id,
        pickupZoneName: ride.pickupZone.name,
        dropoffZoneName: ride.dropoffZone.name,
        type: ride.type,
        farePesewas,
        driverSharePesewas: driverShare,
        expiresAt,
      },
    );
  }

  return eligible;
}

/**
 * Atomically claims a REQUESTED ride for a driver.
 *
 * Implemented as a single conditional UPDATE:
 *   UPDATE Ride SET driverId = :driverId, status = 'MATCHED'
 *   WHERE id = :rideId AND status = 'REQUESTED' AND driverId IS NULL
 *
 * Exactly one of N concurrent callers will affect a row (count === 1) and
 * win the claim — the rest affect zero rows and throw
 * RideAlreadyClaimedError. The win/lose decision is made by Postgres's
 * row-level locking on the conditional update itself, not by an
 * application-level read-then-write or lock. This deliberately stays a
 * single round-trip statement, no held-open transaction — an earlier version
 * wrapped this in prisma.$transaction to make the driver-active-ride check
 * below airtight, but that held a connection per concurrent caller and blew
 * past Neon's pooled connection_limit under this project's own concurrent-
 * claim test, turning clean RideAlreadyClaimedError rejections into raw
 * PrismaClientKnownRequestErrors. Not worth it for a check that's already
 * accepted as a small, non-atomic race on the rider side (see
 * ActiveRideExistsError in createRide.ts) — this mirrors that exactly.
 *
 * Before the update, checks the claiming driver doesn't already hold an
 * active ride (MATCHED/ARRIVED/IN_PROGRESS) via a plain pre-check read, the
 * same read-then-write shape createRide.ts uses for the rider-side guard.
 *
 * This blocks the common case — a driver claiming a second ride while
 * already on one. It does NOT close the rare race where the same driver
 * fires two concurrent claims (for two different REQUESTED rides) at almost
 * the same instant: both pre-check reads can pass before either update
 * commits, since the read and the write aren't in the same transaction.
 * Full atomicity for this check is tracked for post-buildathon.
 */
export async function claimRide(prisma: PrismaClient, rideId: string, driverId: string) {
  const existingActiveRide = await prisma.ride.findFirst({
    where: { driverId, status: { in: [...ACTIVE_DRIVER_STATUSES] } },
  });
  if (existingActiveRide) {
    throw new DriverHasActiveRideError(existingActiveRide);
  }

  const result = await prisma.ride.updateMany({
    where: { id: rideId, status: "REQUESTED", driverId: null },
    data: { driverId, status: "MATCHED" },
  });

  if (result.count !== 1) {
    throw new RideAlreadyClaimedError(rideId);
  }

  return prisma.ride.findUniqueOrThrow({ where: { id: rideId } });
}
