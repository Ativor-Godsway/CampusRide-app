import type { PrismaClient, Ride } from "@prisma/client";
import { getLoneFare, getSharedFarePerRider, splitFare } from "@rida/shared";
import { emitDriverBroadcast, emitOfferClosed } from "../../realtime/rideSocket";
import { logger } from "../../lib/logger";
import type { OfferClosedReason } from "@rida/shared";
import { DriverHasActiveRideError, RideAlreadyClaimedError } from "./errors";
import { ACTIVE_DRIVER_STATUSES } from "./stateMachine";
import { requestPlaceNames } from "../../routes/ridePins";
import { notifyRideRequest } from "../push/notify";

/**
 * Returns the candidate set of drivers who could be dispatched a ride:
 * online + approved drivers currently in the ride's pickup zone or a zone
 * adjacent to it. This is the candidate set only — ranking/"perfect match"
 * ordering of these candidates is Phase 2c, not handled here.
 *
 * With the ride's `id` (ride offers, 2026-10), drivers who already declined
 * or let this ride's offer time out are left out: it is never offered to
 * them again. Drivers on a trip stay in: a shared car with a free seat is
 * offered riders mid-trip (fill-suggestions); the broadcast only tells the
 * app to look.
 */
export async function getEligibleDrivers(
  prisma: PrismaClient,
  ride: { id?: string; pickupZoneId: string },
) {
  // Edges to or from a retired zone don't count: eligibility never flows
  // through a zone that is out of service.
  const adjacencies = await prisma.zoneAdjacency.findMany({
    where: {
      OR: [{ zoneId: ride.pickupZoneId }, { adjacentZoneId: ride.pickupZoneId }],
      zone: { retiredAt: null },
      adjacentZone: { retiredAt: null },
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
      currentZone: { retiredAt: null },
      ...(ride.id ? { user: { rideRejections: { none: { rideId: ride.id } } } } : {}),
    },
  });
}

/**
 * A request stopped being available — another driver took it, the rider
 * cancelled, or its window ran out. Every driver it could have been offered
 * to hears `ride:offer_closed` and drops it from their offer queue and list
 * at once, instead of on the next poll. Fire-and-forget: never throws.
 */
export function closeOffer(
  prisma: PrismaClient,
  ride: { id: string; pickupZoneId: string },
  reason: OfferClosedReason,
): void {
  void getEligibleDrivers(prisma, { pickupZoneId: ride.pickupZoneId })
    .then((drivers) => emitOfferClosed(drivers.map((d) => d.userId), { rideId: ride.id, reason }))
    .catch((err) => logger.warn("closeOffer failed", { rideId: ride.id, err }));
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
  const eligible = await getEligibleDrivers(prisma, { id: ride.id, pickupZoneId: ride.pickupZoneId });

  if (eligible.length > 0) {
    const farePesewas =
      ride.type === "LONE" ? getLoneFare() : getSharedFarePerRider(ride.occupancy);
    const { driverShare } = splitFare(farePesewas);
    const expiresAt = (ride.broadcastStartedAt?.getTime() ?? Date.now()) + 90_000;
    const placeNames = requestPlaceNames(ride, ride.pickupZone.name, ride.dropoffZone.name);

    emitDriverBroadcast(
      eligible.map((d) => d.userId),
      {
        rideId: ride.id,
        pickupZoneName: ride.pickupZone.name,
        dropoffZoneName: ride.dropoffZone.name,
        // Names only: no driver gets a rider's coordinates before accepting.
        ...placeNames,
        type: ride.type,
        farePesewas,
        driverSharePesewas: driverShare,
        expiresAt,
      },
    );
    // Drivers whose app is in the background or closed get it as a push.
    notifyRideRequest(prisma, ride.id, eligible.map((d) => d.userId), placeNames.pickupPlaceName);
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

  const claimed = await claimIfOpen(prisma, rideId, driverId);
  if (!claimed) throw new RideAlreadyClaimedError(rideId);
  return claimed;
}

/**
 * The claim itself: one conditional UPDATE that also returns the claimed row
 * (it used to be an update and then a second query to read the row back).
 * Null when the ride was not open: already claimed, cancelled or timed out.
 */
export async function claimIfOpen(prisma: PrismaClient, rideId: string, driverId: string): Promise<Ride | null> {
  const rows = await prisma.$queryRaw<Ride[]>`
    UPDATE "Ride" SET "driverId" = ${driverId}, status = 'MATCHED'
    WHERE id = ${rideId} AND status = 'REQUESTED' AND "driverId" IS NULL
    RETURNING *`;
  return rows[0] ?? null;
}
