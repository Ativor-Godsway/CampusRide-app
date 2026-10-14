import type { PrismaClient } from "@prisma/client";
import { pickupPin, type RiderPushKind } from "@rida/shared";
import { logger } from "../../lib/logger";
import { getZoneMap } from "../zones/zoneCache";
import { ACTIVE_DRIVER_STATUSES } from "../ride/stateMachine";
import { passengersToAlertArriving } from "./arriving";
import { isPushEnabled, sendPush } from "./pushService";

/**
 * The ride events that send a push notification, one helper per event, so a
 * route adds a single fire-and-forget line next to its socket emit. None of
 * these throw or return a promise the caller must handle; failures are logged
 * by sendPush (or here, for the lookups before it).
 */

function run(what: string, rideId: string, work: () => Promise<void>): void {
  // Push off: not even the name lookups run.
  if (!isPushEnabled()) return;
  void work().catch((err) => logger.error(`push: ${what} failed`, { err, rideId }));
}

async function nameOf(
  prisma: PrismaClient,
  userId: string | null | undefined,
): Promise<string | null> {
  if (!userId) return null;
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { name: true } });
  return user?.name ?? null;
}

/** A rider-facing update that names their driver (by first name). */
export function notifyRider(
  prisma: PrismaClient,
  riderIds: string | readonly string[],
  kind: RiderPushKind,
  rideId: string,
  options: { driverUserId?: string | null; noShow?: boolean } = {},
): void {
  run(kind, rideId, async () => {
    const driverName = await nameOf(prisma, options.driverUserId);
    await sendPush(prisma, {
      userIds: typeof riderIds === "string" ? [riderIds] : riderIds,
      kind,
      rideId,
      text: { driverName, noShow: options.noShow },
    });
  });
}

/**
 * A new request was offered to these drivers. Drivers already on a trip are
 * left out: their app shows riders who fit their car on the trip screen, and
 * a ping while driving is a distraction.
 */
export function notifyRideRequest(
  prisma: PrismaClient,
  rideId: string,
  driverUserIds: readonly string[],
  pickupName: string | null,
): void {
  run("RIDE_REQUEST", rideId, async () => {
    if (driverUserIds.length === 0) return;
    const busy = await prisma.ride.findMany({
      where: { driverId: { in: [...driverUserIds] }, status: { in: [...ACTIVE_DRIVER_STATUSES] } },
      select: { driverId: true },
    });
    const busyIds = new Set(busy.map((r) => r.driverId));
    await sendPush(prisma, {
      userIds: driverUserIds.filter((id) => !busyIds.has(id)),
      kind: "RIDE_REQUEST",
      rideId,
      text: { pickupName },
    });
  });
}

/** The rider cancelled a ride their driver had already accepted. */
export function notifyRiderCancelled(
  prisma: PrismaClient,
  ride: { id: string; riderId: string; driverId: string | null },
): void {
  if (!ride.driverId) return;
  const driverId = ride.driverId;
  run("RIDER_CANCELLED", ride.id, async () => {
    const riderName = await nameOf(prisma, ride.riderId);
    await sendPush(prisma, {
      userIds: [driverId],
      kind: "RIDER_CANCELLED",
      rideId: ride.id,
      text: { riderName },
    });
  });
}

/** Looked at most this often per ride; positions arrive every few seconds. */
const ARRIVING_CHECK_INTERVAL_MS = 15_000;
const lastArrivingCheck = new Map<string, number>();

/**
 * Called with each live position from a ride's driver (realtime/rideSocket.ts):
 * tells waiting riders their driver is almost at their pickup (rules in
 * ./arriving.ts). sendPush's dedupe makes it once per rider per ride.
 */
export function checkDriverArriving(
  prisma: PrismaClient,
  rideId: string,
  driverUserId: string,
  position: { latitude: number; longitude: number },
  now: Date = new Date(),
): void {
  if (!isPushEnabled()) return;
  const last = lastArrivingCheck.get(rideId);
  if (last !== undefined && now.getTime() - last < ARRIVING_CHECK_INTERVAL_MS) return;
  lastArrivingCheck.set(rideId, now.getTime());
  if (lastArrivingCheck.size > 5_000) {
    for (const [id, at] of lastArrivingCheck)
      if (now.getTime() - at > ARRIVING_CHECK_INTERVAL_MS) lastArrivingCheck.delete(id);
  }

  run("DRIVER_ARRIVING", rideId, async () => {
    const passengers = await prisma.ridePassenger.findMany({
      where: {
        rideId,
        status: "WAITING",
        ride: { driverId: driverUserId, status: { in: [...ACTIVE_DRIVER_STATUSES] } },
      },
      select: {
        id: true,
        riderId: true,
        status: true,
        createdAt: true,
        pickupLat: true,
        pickupLng: true,
        pickupZoneId: true,
      },
    });
    if (passengers.length === 0) return;
    const zones = await getZoneMap(prisma);
    const due = passengersToAlertArriving(
      position,
      passengers.map((p) => {
        const zone = zones.get(p.pickupZoneId);
        return {
          id: p.id,
          riderId: p.riderId,
          status: p.status,
          joinedAt: p.createdAt,
          pickup:
            pickupPin(p) ?? (zone ? { latitude: zone.latitude, longitude: zone.longitude } : null),
        };
      }),
      now,
    );
    for (const p of due)
      notifyRider(prisma, p.riderId, "DRIVER_ARRIVING", rideId, { driverUserId });
  });
}

/** Tests only. */
export function resetArrivingChecksForTests(): void {
  lastArrivingCheck.clear();
}
