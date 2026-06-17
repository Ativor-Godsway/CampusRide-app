import type { Server as SocketIOServer, Socket } from "socket.io";
import type { PrismaClient } from "@prisma/client";
import {
  RIDE_CLIENT_EVENTS,
  DRIVER_CLIENT_EVENTS,
  DRIVER_EVENTS,
  RIDE_EVENTS,
  type RideServerEvent,
  type RideServerEventPayloads,
  type RideBroadcastPayload,
  type DriverLocationUpdatePayload,
} from "@rida/shared";
import { verifyAccessToken } from "../services/auth/tokens";

let ioRef: SocketIOServer | null = null;

function roomForRide(rideId: string): string {
  return `ride:${rideId}`;
}

function roomForDriver(userId: string): string {
  return `driver:${userId}`;
}

/**
 * Wires up the real-time layer (Phase 5c + 6a):
 *
 * Rider side (Phase 5c):
 * - `ride:subscribe` / `ride:unsubscribe` join/leave the `ride:{rideId}` room,
 *   after confirming the authenticated user is the ride's rider or passenger.
 *
 * Driver side (Phase 6a):
 * - Every authenticated driver is automatically joined to `driver:{userId}` so
 *   the server can push `ride:broadcast` events to them.
 * - `driver:location` events from the driver are re-emitted as
 *   `ride:driver_location` to the ride's room (riders see live GPS).
 */
export function initRideSocket(io: SocketIOServer, prisma: PrismaClient): void {
  ioRef = io;

  io.on("connection", (socket: Socket) => {
    const token = socket.handshake.auth?.token as string | undefined;

    let userId: string;
    let userRole: string;
    try {
      if (!token) throw new Error("missing token");
      const payload = verifyAccessToken(token);
      userId = payload.userId;
      userRole = payload.role ?? "RIDER";
    } catch {
      socket.disconnect(true);
      return;
    }

    // Every driver joins their personal room immediately on connect so they
    // receive ride:broadcast events pushed by broadcastRide.
    if (userRole === "DRIVER") {
      void socket.join(roomForDriver(userId));
    }

    socket.on(RIDE_CLIENT_EVENTS.SUBSCRIBE, (rideId: unknown) => {
      if (typeof rideId !== "string") return;
      void authorizeRideAccess(prisma, rideId, userId).then((allowed) => {
        if (allowed) socket.join(roomForRide(rideId));
      });
    });

    socket.on(RIDE_CLIENT_EVENTS.UNSUBSCRIBE, (rideId: unknown) => {
      if (typeof rideId !== "string") return;
      socket.leave(roomForRide(rideId));
    });

    // Driver streams GPS during an active ride; server re-emits to the ride room.
    socket.on(DRIVER_CLIENT_EVENTS.LOCATION_UPDATE, (data: unknown) => {
      if (!isDriverLocationUpdate(data)) return;
      void authorizeDriverRide(prisma, data.rideId, userId).then((allowed) => {
        if (!allowed) return;
        ioRef?.to(roomForRide(data.rideId)).emit(RIDE_EVENTS.DRIVER_LOCATION, {
          rideId: data.rideId,
          lat: data.lat,
          lng: data.lng,
          ts: Date.now(),
        });
      });
    });
  });
}

function isDriverLocationUpdate(v: unknown): v is DriverLocationUpdatePayload {
  return (
    typeof v === "object" &&
    v !== null &&
    typeof (v as Record<string, unknown>).rideId === "string" &&
    typeof (v as Record<string, unknown>).lat === "number" &&
    typeof (v as Record<string, unknown>).lng === "number"
  );
}

async function authorizeRideAccess(
  prisma: PrismaClient,
  rideId: string,
  userId: string,
): Promise<boolean> {
  const ride = await prisma.ride.findUnique({
    where: { id: rideId },
    include: { passengers: { where: { riderId: userId } } },
  });
  if (!ride) return false;
  return ride.riderId === userId || ride.passengers.length > 0;
}

/** Allows a location update only if the user is the active driver of the ride. */
async function authorizeDriverRide(
  prisma: PrismaClient,
  rideId: string,
  userId: string,
): Promise<boolean> {
  const ride = await prisma.ride.findUnique({
    where: { id: rideId },
    select: { driverId: true, status: true },
  });
  if (!ride) return false;
  return ride.driverId === userId && ride.status === "IN_PROGRESS";
}

/** Emits a contract event to everyone subscribed to a ride's room. No-op if the socket server isn't initialized (e.g. tests). */
export function emitRideEvent<E extends RideServerEvent>(
  rideId: string,
  event: E,
  payload: RideServerEventPayloads[E],
): void {
  ioRef?.to(roomForRide(rideId)).emit(event, payload);
}

/** Emits a ride:broadcast event to all specified driver user rooms. */
export function emitDriverBroadcast(
  driverUserIds: string[],
  payload: RideBroadcastPayload,
): void {
  if (!ioRef || driverUserIds.length === 0) return;
  const rooms = driverUserIds.map(roomForDriver);
  ioRef.to(rooms).emit(DRIVER_EVENTS.RIDE_BROADCAST, payload);
}
