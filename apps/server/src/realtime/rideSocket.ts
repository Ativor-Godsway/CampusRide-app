import type { Server as SocketIOServer, Socket } from "socket.io";
import type { PrismaClient } from "@prisma/client";
import {
  RIDE_CLIENT_EVENTS,
  type RideServerEvent,
  type RideServerEventPayloads,
} from "@rida/shared";
import { verifyAccessToken } from "../services/auth/tokens";

let ioRef: SocketIOServer | null = null;

function roomForRide(rideId: string): string {
  return `ride:${rideId}`;
}

/**
 * Wires up the rider-facing real-time layer (Phase 5c):
 * - On connect, verifies the access token passed as `socket.handshake.auth.token`
 *   (the same token used for HTTP requests). Disconnects unauthenticated sockets.
 * - `ride:subscribe` / `ride:unsubscribe` join/leave the `ride:{rideId}` room,
 *   after confirming the authenticated user is the ride's rider or one of its
 *   SHARED-ride passengers.
 *
 * Emitting is done via `emitRideEvent`, called from route handlers and the
 * dev mock driver after a ride transition commits — this module never
 * mutates ride state itself.
 */
export function initRideSocket(io: SocketIOServer, prisma: PrismaClient): void {
  ioRef = io;

  io.on("connection", (socket: Socket) => {
    const token = socket.handshake.auth?.token as string | undefined;

    let userId: string;
    try {
      if (!token) throw new Error("missing token");
      userId = verifyAccessToken(token).userId;
    } catch {
      socket.disconnect(true);
      return;
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
  });
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

/** Emits a contract event to everyone subscribed to a ride's room. No-op if the socket server isn't initialized (e.g. tests). */
export function emitRideEvent<E extends RideServerEvent>(
  rideId: string,
  event: E,
  payload: RideServerEventPayloads[E],
): void {
  ioRef?.to(roomForRide(rideId)).emit(event, payload);
}
