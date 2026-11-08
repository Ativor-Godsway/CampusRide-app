import type { PrismaClient } from "@prisma/client";
import { dropoffPin, pickupPin, type LatLng, type RideEtaPayload } from "@rida/shared";
import { estimateRoute } from "../routing/campusRoutes";
import { emitToRider } from "../../realtime/rideSocket";
import { latestDriverPosition } from "../zones/livePositions";
import { getZoneMap } from "../zones/zoneCache";
import { ACTIVE_DRIVER_STATUSES } from "./stateMachine";

/**
 * Each rider's road ETA, from the driver's live position (realtime/rideSocket.ts
 * calls this with every relayed position and sends the answers to each
 * rider's own room).
 *
 * On CampusRide's campus roads (services/routing/campusRoutes.ts: a few
 * milliseconds, no network), not the straight line the apps used to pad by
 * 1.3: a rider still waiting gets the way to their own pickup, a rider on
 * board the way to their own drop-off. A rider whose stop can't be routed
 * gets nothing, and the app keeps its own estimate.
 */

/** Worked out at most this often per ride; positions arrive every few seconds. */
export const RIDER_ETA_INTERVAL_MS = 10_000;

const lastWorkedOut = new Map<string, number>();

export interface RiderEta {
  riderId: string;
  payload: RideEtaPayload;
}

/** Whether a ride's ETAs are due again; records it if so. */
export function riderEtaDue(rideId: string, now: number = Date.now()): boolean {
  const last = lastWorkedOut.get(rideId);
  if (last !== undefined && now - last < RIDER_ETA_INTERVAL_MS) return false;
  lastWorkedOut.set(rideId, now);
  if (lastWorkedOut.size > 5_000) {
    for (const [id, at] of lastWorkedOut) if (now - at > RIDER_ETA_INTERVAL_MS) lastWorkedOut.delete(id);
  }
  return true;
}

/** The ETA of every rider still in or waiting for this driver's car. */
export async function riderEtas(
  prisma: PrismaClient,
  rideId: string,
  driverUserId: string,
  position: LatLng,
  now: number = Date.now(),
): Promise<RiderEta[]> {
  const seats = await prisma.ridePassenger.findMany({
    where: {
      rideId,
      status: { in: ["WAITING", "PICKED_UP"] },
      ride: { driverId: driverUserId, status: { in: [...ACTIVE_DRIVER_STATUSES] } },
    },
    select: {
      riderId: true,
      status: true,
      pickupLat: true,
      pickupLng: true,
      pickupZoneId: true,
      dropoffLat: true,
      dropoffLng: true,
      dropoffZoneId: true,
    },
  });
  if (seats.length === 0) return [];
  const zones = await getZoneMap(prisma);
  const out: RiderEta[] = [];
  for (const seat of seats) {
    const toward = seat.status === "WAITING" ? "pickup" : "dropoff";
    const zone = zones.get(toward === "pickup" ? seat.pickupZoneId : seat.dropoffZoneId);
    const stop =
      (toward === "pickup" ? pickupPin(seat) : dropoffPin(seat)) ??
      (zone ? { latitude: zone.latitude, longitude: zone.longitude } : null);
    if (!stop) continue;
    const route = estimateRoute([position, stop]);
    if (!route) continue;
    out.push({
      riderId: seat.riderId,
      payload: { rideId, toward, seconds: Math.round(route.durationSeconds), at: now },
    });
  }
  return out;
}

/** A driver position older than this is too stale to work an ETA out from. */
const POSITION_FRESH_MS = 60_000;

/**
 * After the driver changed a seat (picked Bill up out of order, dropped
 * someone off, undid a step): each remaining rider's ETA at once, from the
 * driver's last position, instead of on the next relayed position. Bill on
 * board now gets the way to his drop-off; a rider still waiting keeps the
 * way to their pickup. Nothing without a recent position.
 */
export async function sendRiderEtasNow(
  prisma: PrismaClient,
  rideId: string,
  driverUserId: string,
  now: number = Date.now(),
): Promise<void> {
  const position = latestDriverPosition(driverUserId, POSITION_FRESH_MS, now);
  if (!position) return;
  lastWorkedOut.set(rideId, now);
  const etas = await riderEtas(prisma, rideId, driverUserId, position, now);
  for (const eta of etas) emitToRider(eta.riderId, "ride:eta", eta.payload);
}

/** Tests only. */
export function resetRiderEtasForTests(): void {
  lastWorkedOut.clear();
}
