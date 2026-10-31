import type { PrismaClient } from "@prisma/client";
import { freshDriverPositions } from "../zones/livePositions";
import { driverPresenceOf } from "../zones/driverPresence";
import { ACTIVE_DRIVER_STATUSES } from "../ride/stateMachine";
import { AGGREGATE_TTL_MS, cached, cachedAt } from "./cache";
import { waitingRequests } from "./liveRequests";

/**
 * The admin live map (GET /admin/live). Asked every 5 seconds while it is on
 * screen, so it is built from the server's memory: drivers' live positions
 * (services/zones/livePositions.ts), their apps' presence, and the requests
 * waiting for a driver (./liveRequests.ts). The only database part — who the
 * online drivers are and the trips under way — is read at most once a minute
 * for everyone ("the board"), never per request.
 *
 * Positions are exact (admins only), not the rounded ones riders' Home map gets.
 */

/** A live position this old still puts the car on the map. */
export const LIVE_POSITION_FRESH_MS = 2 * 60_000;
const BOARD_KEY = "live:board";

interface BoardDriver {
  userId: string;
  driverId: string;
  name: string;
  plate: string | null;
  isOnline: boolean;
  lastLat: number | null;
  lastLng: number | null;
  lastSeenAt: Date | null;
}

interface BoardTrip {
  rideId: string;
  driverUserId: string;
  status: string;
  type: "LONE" | "SHARED";
  riders: number;
  stops: Array<{ kind: "pickup" | "dropoff"; latitude: number; longitude: number; label: string; done: boolean }>;
}

interface Board {
  drivers: BoardDriver[];
  trips: BoardTrip[];
}

async function readBoard(prisma: PrismaClient): Promise<Board> {
  const [trips, drivers] = await Promise.all([
    prisma.ride.findMany({
      where: { status: { in: [...ACTIVE_DRIVER_STATUSES] }, isReviewDemo: false, driverId: { not: null } },
      select: {
        id: true,
        driverId: true,
        status: true,
        type: true,
        pickupLat: true,
        pickupLng: true,
        pickupLabel: true,
        dropoffLat: true,
        dropoffLng: true,
        dropoffLabel: true,
        pickupZone: { select: { name: true, latitude: true, longitude: true } },
        dropoffZone: { select: { name: true, latitude: true, longitude: true } },
        passengers: {
          where: { status: { not: "CANCELLED" } },
          select: {
            status: true,
            pickupLat: true,
            pickupLng: true,
            pickupLabel: true,
            dropoffLat: true,
            dropoffLng: true,
            dropoffLabel: true,
            pickupZone: { select: { name: true, latitude: true, longitude: true } },
            dropoffZone: { select: { name: true, latitude: true, longitude: true } },
          },
        },
      },
    }),
    prisma.driver.findMany({
      where: { isOnline: true, user: { isReviewDemo: false, deletedAt: null } },
      select: {
        id: true,
        userId: true,
        plate: true,
        isOnline: true,
        lastLat: true,
        lastLng: true,
        lastSeenAt: true,
        user: { select: { name: true } },
      },
    }),
  ]);
  const onTripIds = new Set(trips.map((t) => t.driverId!));
  // A driver on a trip who went offline in the app is still driving it.
  const missing = [...onTripIds].filter((id) => !drivers.some((d) => d.userId === id));
  const extra = missing.length
    ? await prisma.driver.findMany({
        where: { userId: { in: missing } },
        select: { id: true, userId: true, plate: true, isOnline: true, lastLat: true, lastLng: true, lastSeenAt: true, user: { select: { name: true } } },
      })
    : [];
  return {
    drivers: [...drivers, ...extra].map((d) => ({
      userId: d.userId,
      driverId: d.id,
      name: d.user.name,
      plate: d.plate,
      isOnline: d.isOnline,
      lastLat: d.lastLat,
      lastLng: d.lastLng,
      lastSeenAt: d.lastSeenAt,
    })),
    trips: trips.map((t) => {
      const seats = t.passengers.length ? t.passengers : [{ ...t, status: "WAITING" as const }];
      return {
        rideId: t.id,
        driverUserId: t.driverId!,
        status: t.status,
        type: t.type,
        riders: t.passengers.length,
        stops: seats.flatMap((s) => [
          {
            kind: "pickup" as const,
            latitude: s.pickupLat ?? s.pickupZone.latitude,
            longitude: s.pickupLng ?? s.pickupZone.longitude,
            label: s.pickupLabel ?? s.pickupZone.name,
            done: s.status === "PICKED_UP" || s.status === "DROPPED_OFF",
          },
          {
            kind: "dropoff" as const,
            latitude: s.dropoffLat ?? s.dropoffZone.latitude,
            longitude: s.dropoffLng ?? s.dropoffZone.longitude,
            label: s.dropoffLabel ?? s.dropoffZone.name,
            done: s.status === "DROPPED_OFF",
          },
        ]),
      };
    }),
  };
}

export async function liveSnapshot(prisma: PrismaClient, now: number = Date.now()) {
  const board = await cached(BOARD_KEY, () => readBoard(prisma), AGGREGATE_TTL_MS, now);
  const positions = freshDriverPositions(LIVE_POSITION_FRESH_MS, now);
  const tripByDriver = new Map(board.trips.map((t) => [t.driverUserId, t]));

  const drivers = board.drivers.map((d) => {
    const live = positions.get(d.userId);
    const presence = driverPresenceOf(d.userId);
    const trip = tripByDriver.get(d.userId);
    // A trip position seen since the board was read says "on a trip" sooner than the board can.
    const onTrip = Boolean(trip) || Boolean(live?.rideId);
    const position = live
      ? { latitude: live.latitude, longitude: live.longitude, heading: live.heading, at: new Date(live.at).toISOString(), live: true }
      : d.lastLat != null && d.lastLng != null
        ? { latitude: d.lastLat, longitude: d.lastLng, heading: null, at: d.lastSeenAt?.toISOString() ?? null, live: false }
        : null;
    const seenAt = Math.max(live?.at ?? 0, presence?.heardAt ?? 0, d.lastSeenAt?.getTime() ?? 0);
    return {
      userId: d.userId,
      driverId: d.driverId,
      name: d.name,
      plate: d.plate,
      status: onTrip ? ("ON_TRIP" as const) : ("WAITING" as const),
      rideId: trip?.rideId ?? live?.rideId ?? null,
      position,
      seenAt: seenAt > 0 ? new Date(seenAt).toISOString() : null,
      app: presence ? { connected: presence.connected, state: presence.state } : null,
    };
  });

  const requests = waitingRequests(now).map((r) => ({
    rideId: r.rideId,
    riderId: r.riderId,
    riderName: r.riderName,
    type: r.type,
    requestedAt: new Date(r.requestedAt).toISOString(),
    pickup: r.pickup,
    pickupLabel: r.pickupLabel,
    dropoffLabel: r.dropoffLabel,
    offeredTo: r.offeredTo.size,
    declined: r.declinedBy.size,
    timedOut: r.timedOutWith.size,
  }));

  const onTrip = drivers.filter((d) => d.status === "ON_TRIP").length;
  return {
    generatedAt: new Date(now).toISOString(),
    /** When the drivers' names and the trips were last read from the database. */
    boardAt: new Date(cachedAt(BOARD_KEY) ?? now).toISOString(),
    drivers,
    requests,
    trips: board.trips,
    counts: {
      online: drivers.length,
      onTrip,
      waitingDrivers: drivers.length - onTrip,
      ridersWaiting: requests.length,
      tripsRunning: board.trips.length,
    },
  };
}

export type LiveSnapshot = Awaited<ReturnType<typeof liveSnapshot>>;
