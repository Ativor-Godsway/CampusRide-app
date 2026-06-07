import type { PrismaClient } from "@prisma/client";
import { RideAlreadyClaimedError } from "./errors";

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
 * Hook for pushing a "new ride available" event to eligible drivers.
 *
 * TODO(Phase 5): wire this to Socket.io — emit a "ride:broadcast" event to
 * each driverId's socket room so their client shows the incoming ride.
 * For now this is a no-op so dispatch logic can be exercised headlessly.
 */
export function notifyEligibleDrivers(rideId: string, driverIds: readonly string[]): void {
  void rideId;
  void driverIds;
}

/**
 * Computes the eligible-driver set for a ride and invokes the
 * notifyEligibleDrivers hook. Does not change ride state — call this after
 * a ride enters (or re-enters) REQUESTED.
 */
export async function broadcastRide(prisma: PrismaClient, rideId: string) {
  const ride = await prisma.ride.findUniqueOrThrow({ where: { id: rideId } });
  const eligible = await getEligibleDrivers(prisma, ride);
  notifyEligibleDrivers(
    rideId,
    eligible.map((d) => d.id),
  );
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
 * application-level read-then-write or lock.
 */
export async function claimRide(prisma: PrismaClient, rideId: string, driverId: string) {
  const result = await prisma.ride.updateMany({
    where: { id: rideId, status: "REQUESTED", driverId: null },
    data: { driverId, status: "MATCHED" },
  });

  if (result.count !== 1) {
    throw new RideAlreadyClaimedError(rideId);
  }

  return prisma.ride.findUniqueOrThrow({ where: { id: rideId } });
}
